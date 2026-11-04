import { createLocks } from "../locks.mjs";
import { ibkrAccountRows } from "../mapping.mjs";
import { iso, parseTime } from "../time.mjs";

/**
 * Keepalive per gateway (contract section 7).
 *
 * Every cycle: GET /v1/api/iserver/auth/status, and POST /v1/api/tickle at least every 55 s.
 * While a login is pending the status is read every 3 s, so the app sees "connected" within
 * seconds of the user finishing the IBKR page.
 *
 * First authenticated status: POST /iserver/auth/ssodh/init {"publish":true,"compete":false}, then
 * GET /iserver/accounts and GET /portfolio/accounts, upsert broker_accounts, and set the connection
 * active with session_expires_at 24 h ahead.
 *
 * `competing: true` means another session (TWS, the IBKR mobile app, another browser login) holds
 * this IBKR username. The service says so in status_detail and never sends `compete: true` itself:
 * taking the session back would log the user out of their own app.
 *
 * A watch belongs to one gateway (its port). When that gateway exits or is replaced, only that
 * watch ends: an old JVM that finishes exiting after a Reconnect never cancels the watch of the
 * new one.
 */

export const IBKR_DETAIL = Object.freeze({
  pending: "Log in on the IBKR page to finish connecting.",
  competing:
    "Another session (TWS or the IBKR mobile app) is using this IBKR username. Close it, or use a second IBKR username for Nasscord.",
  ended: "IBKR ended the session. Log in again to continue.",
  brokerageDown: "IBKR's brokerage session is not responding. Log in again to continue.",
  loginTimeout: "The IBKR login was not finished in time. Press Reconnect to try again.",
  gatewayStopped: "The IBKR connection stopped unexpectedly. Log in again to continue.",
  gatewayRestarted: "The IBKR connection was restarted. Log in again to continue.",
  serviceRestarted: "The broker service restarted. Log in to IBKR again to continue.",
});

const FAST_POLL_MS = 3_000;
/** status 200 but not authenticated for this long after a login: send ssodh/init (compete:false) */
const INIT_NUDGE_AFTER_MS = 10_000;
const INIT_NUDGE_EVERY_MS = 30_000;
/** active, SSO alive, brokerage not authenticated for this long: error */
const BROKERAGE_DOWN_AFTER_MS = 5 * 60_000;
/** this many failed cycles in a row (gateway not answering): restart = session loss */
const MAX_FAILED_CYCLES = 3;

/**
 * @typedef {{
 *   connectionId: string,
 *   port: number,
 *   timer: NodeJS.Timeout | null,
 *   running: boolean,
 *   stopped: boolean,
 *   authenticated: boolean,
 *   everAuthenticated: boolean,
 *   competing: boolean,
 *   connected: boolean,
 *   sso: boolean,
 *   bootstrapped: boolean,
 *   lastTickleAt: number,
 *   lastCheckAt: number,
 *   unauthSince: number | null,
 *   lastInitAt: number,
 *   failures: number,
 *   lastDetail: string | null | undefined,
 *   lastOkWrite: number,
 *   waiters: Array<() => void>,
 * }} WatchState
 */

/**
 * @param {{
 *   manager: import("./gateway-manager.mjs").GatewayManager,
 *   gw: import("./gateway-http.mjs").GatewayHttp,
 *   store: import("../db.mjs").Store,
 *   log: import("../log.mjs").Logger,
 *   cache?: import("../cache.mjs").CoalescingCache,
 *   audit?: import("../audit.mjs").Audit,
 *   locks?: import("../locks.mjs").Locks,
 *   now?: () => number,
 *   keepaliveMs?: number,
 *   fastPollMs?: number,
 *   sessionHours?: number,
 *   setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout,
 *   clearTimer?: (t: NodeJS.Timeout) => void,
 * }} deps
 */
export function createIbkrSessions(deps) {
  const {
    manager,
    gw,
    store,
    log,
    cache,
    locks = createLocks(),
    now = Date.now,
    keepaliveMs = 55_000,
    fastPollMs = FAST_POLL_MS,
    sessionHours = 24,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps;
  /** @type {Map<string, WatchState>} */
  const watched = new Map();

  /** @param {string} connectionId @param {number} port @returns {WatchState} */
  function fresh(connectionId, port) {
    return {
      connectionId,
      port,
      timer: null,
      running: false,
      stopped: false,
      authenticated: false,
      everAuthenticated: false,
      competing: false,
      connected: false,
      sso: false,
      bootstrapped: false,
      lastTickleAt: 0,
      lastCheckAt: 0,
      unauthSince: null,
      lastInitAt: 0,
      failures: 0,
      lastDetail: undefined,
      lastOkWrite: 0,
      waiters: [],
    };
  }

  /** @param {WatchState} st */
  function schedule(st) {
    if (st.stopped) return;
    if (st.timer) clearTimer(st.timer);
    const ms = st.authenticated ? keepaliveMs : fastPollMs;
    st.timer = setTimer(() => {
      st.timer = null;
      void cycle(st);
    }, ms);
    st.timer.unref?.();
  }

  /**
   * @param {string} id
   * @param {string[]} statuses
   * @param {object} patch
   */
  async function update(id, statuses, patch) {
    try {
      const row = await store.updateConnectionIf(id, statuses, patch);
      cache?.invalidate(id);
      return row;
    } catch (e) {
      log.warn("connection update failed", { connectionId: id, error: e });
      return null;
    }
  }

  /**
   * A system audit row about a connection, tagged with its workspace (read from the row) so the
   * console's per-workspace log shows IBKR expiries, restarts and exits like the scheduler's.
   * @param {string} connectionId
   * @param {{ action: string, result?: "ok" | "denied" | "error", meta?: Record<string, unknown> }} entry
   */
  async function auditSystem(connectionId, entry) {
    if (!deps.audit) return;
    const row = await store.getConnection(connectionId).catch(() => null);
    await deps.audit.record({
      actor: "system",
      workspaceId: row?.workspace_id ?? null,
      action: entry.action,
      target: row ? `ibkr · ${row.environment} · ${connectionId}` : `ibkr · ${connectionId}`,
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.meta ? { meta: entry.meta } : {}),
    });
  }

  /**
   * Connection is no longer usable: record why, stop polling, remember when (slot release
   * happens 30 minutes later in the scheduler).
   * @param {WatchState} st
   * @param {"expired" | "error"} status
   * @param {string} detail
   */
  async function endSession(st, status, detail) {
    st.authenticated = false;
    st.bootstrapped = false;
    await update(st.connectionId, ["active", "pending", "error"], { status, status_detail: detail });
    manager.markExpired(st.connectionId, now());
    stop(st);
    void auditSystem(st.connectionId, { action: "broker.session.expired", meta: { reason: detail } });
  }

  /** @param {WatchState} st */
  function stop(st) {
    st.stopped = true;
    if (st.timer) clearTimer(st.timer);
    st.timer = null;
    if (watched.get(st.connectionId) === st) watched.delete(st.connectionId);
    for (const w of st.waiters.splice(0)) w();
  }

  /**
   * First authenticated status: open the brokerage session (without competing), discover the
   * accounts and make the connection active.
   * @param {WatchState} st
   * @param {number} port
   */
  async function bootstrap(st, port) {
    const cid = st.connectionId;
    const row = await store.getConnection(cid);
    if (!row || row.status === "disconnected") {
      stop(st);
      return false;
    }
    await gw.post(cid, port, "/iserver/auth/ssodh/init", { publish: true, compete: false });
    const iserver = await gw.get(cid, port, "/iserver/accounts");
    const portfolio = await gw.get(cid, port, "/portfolio/accounts");
    if (iserver.status >= 400 && portfolio.status >= 400) {
      // Right after a login the bridge can need a moment ("no bridge"); try again next cycle.
      log.info("ibkr accounts not ready yet", { connectionId: cid, iserver: iserver.status, portfolio: portfolio.status });
      return false;
    }
    const rows = ibkrAccountRows(
      {
        portfolioAccounts: portfolio.status < 400 && Array.isArray(portfolio.json) ? portfolio.json : [],
        iserverAccounts: iserver.status < 400 ? iserver.json : null,
      },
      row,
    );
    if (!rows.length) {
      // Every IBKR login has at least one account: an empty list is the bridge still loading.
      log.info("ibkr accounts not listed yet", { connectionId: cid });
      return false;
    }
    await store.upsertAccounts(rows);
    // A Reconnect can log in with another IBKR username (the advice after a competing session).
    // Accounts of the earlier login are not reachable through this session: they go.
    const pruned = await store.pruneAccounts(cid, rows.map((r) => r.external_id));
    if (pruned) log.info("removed accounts of an earlier IBKR login", { connectionId: cid, count: pruned });
    const t = now();
    await update(cid, ["pending", "active", "expired", "error"], {
      status: "active",
      status_detail: st.competing ? IBKR_DETAIL.competing : null,
      session_expires_at: iso(t + sessionHours * 3_600_000),
      last_ok_at: iso(t),
    });
    st.lastDetail = st.competing ? IBKR_DETAIL.competing : null;
    st.lastOkWrite = t;
    manager.markExpired(cid, null);
    log.info("ibkr session active", { connectionId: cid, accounts: rows.length });
    return true;
  }

  /** @param {WatchState} st */
  async function cycle(st) {
    if (st.stopped || st.running) return;
    st.running = true;
    const cid = st.connectionId;
    try {
      const port = manager.portFor(cid);
      if (!port || port !== st.port) {
        // The gateway of this watch is gone or was replaced; whoever started the new one watches it.
        stop(st);
        return;
      }
      if (!manager.isReady(cid)) {
        const ok = await manager.whenReady(cid);
        if (!ok) {
          st.failures++;
          if (st.failures >= MAX_FAILED_CYCLES) {
            stop(st);
            await replaceGateway(st);
          }
          return;
        }
      }

      const t = now();
      if (t - st.lastTickleAt >= keepaliveMs) {
        st.lastTickleAt = t;
        await gw.post(cid, port, "/tickle", {}).catch(() => null);
      }

      const res = await gw.get(cid, port, "/iserver/auth/status");
      st.lastCheckAt = now();
      st.failures = 0;
      const wasAuthenticated = st.authenticated;
      if (res.status === 401 || res.status === 403) {
        st.sso = false;
        st.authenticated = false;
        st.connected = false;
      } else if (res.status < 400 && res.json && typeof res.json === "object") {
        st.sso = true;
        st.authenticated = res.json.authenticated === true;
        st.connected = res.json.connected === true;
        st.competing = res.json.competing === true;
      } else {
        throw new Error(`auth status answered ${res.status}`);
      }

      if (st.authenticated) {
        st.unauthSince = null;
        if (!st.bootstrapped) {
          st.bootstrapped = await bootstrap(st, port);
          if (st.bootstrapped) st.everAuthenticated = true;
          else st.authenticated = false; // keep polling fast until the accounts load
        } else {
          await refreshActive(st);
        }
      } else if (st.everAuthenticated) {
        if (!st.sso) {
          await endSession(st, "expired", IBKR_DETAIL.ended);
          return;
        }
        st.unauthSince = st.unauthSince ?? now();
        if (st.competing) {
          await setDetail(st, IBKR_DETAIL.competing);
        } else {
          await nudgeInit(st, port);
        }
        if (now() - st.unauthSince >= BROKERAGE_DOWN_AFTER_MS) {
          await endSession(st, "error", st.competing ? IBKR_DETAIL.competing : IBKR_DETAIL.brokerageDown);
          return;
        }
      } else if (st.sso) {
        // Logged in on IBKR's page, brokerage session not open yet.
        st.unauthSince = st.unauthSince ?? now();
        if (st.competing) await setDetail(st, IBKR_DETAIL.competing);
        else if (now() - st.unauthSince >= INIT_NUDGE_AFTER_MS) await nudgeInit(st, port);
      }
      if (wasAuthenticated !== st.authenticated) log.debug("ibkr auth changed", { connectionId: cid, authenticated: st.authenticated });
    } catch (e) {
      st.failures++;
      log.warn("ibkr keepalive cycle failed", { connectionId: cid, failures: st.failures, error: e });
      if (st.failures >= MAX_FAILED_CYCLES) {
        stop(st);
        await replaceGateway(st);
      }
    } finally {
      st.running = false;
      for (const w of st.waiters.splice(0)) w();
      schedule(st);
    }
  }

  /**
   * The gateway of a watch stopped answering. The login inside it is lost either way, so the JVM
   * is replaced (a Reconnect then gets a working one). Runs under the connection's lock, the same
   * one Connect and Reconnect take, so a restart and a Reconnect never interleave.
   * @param {WatchState} st the watch that gave up (already stopped)
   */
  async function replaceGateway(st) {
    const cid = st.connectionId;
    const restarted = await locks.run(cid, async () => {
      // Already replaced or released by someone else: nothing of this gateway is left to fix.
      if (manager.portFor(cid) !== st.port) return false;
      // A Reconnect that came in after this watch gave up is watching the same broken gateway. The
      // user is about to log in, so the connection stays pending and the new gateway is watched.
      const newer = watched.get(cid);
      const reconnecting = !!newer && !newer.stopped && newer !== st && newer.port === st.port;
      if (newer) stop(newer);
      if (!reconnecting) {
        await update(
          cid,
          ["active", "pending", "error"],
          st.everAuthenticated
            ? { status: "expired", status_detail: IBKR_DETAIL.gatewayRestarted }
            : { status: "error", status_detail: IBKR_DETAIL.gatewayStopped },
        );
      }
      try {
        await manager.restart(cid);
      } catch (e) {
        log.error("gateway restart failed", { connectionId: cid, error: e });
        if (reconnecting) await update(cid, ["pending"], { status: "error", status_detail: IBKR_DETAIL.gatewayStopped });
        return true;
      }
      if (reconnecting) watch(cid);
      else manager.markExpired(cid, now());
      log.warn("restarted a gateway that stopped answering", { connectionId: cid, reconnecting });
      return true;
    });
    if (restarted) void auditSystem(cid, { action: "gateway.restart", result: "error" });
  }

  /**
   * Start (or restart) polling the gateway a connection runs on now.
   * @param {string} connectionId
   */
  function watch(connectionId) {
    const port = manager.portFor(connectionId);
    const existing = watched.get(connectionId);
    if (existing && !existing.stopped && existing.port === port) {
      schedule(existing);
      return;
    }
    if (existing) stop(existing);
    if (!port) return;
    const st = fresh(connectionId, port);
    watched.set(connectionId, st);
    schedule(st);
  }

  /**
   * @param {WatchState} st
   * @param {string | null} detail
   */
  async function setDetail(st, detail) {
    if (st.lastDetail === detail) return;
    st.lastDetail = detail;
    await update(st.connectionId, ["active", "pending", "error"], { status_detail: detail });
  }

  /** @param {WatchState} st @param {number} port */
  async function nudgeInit(st, port) {
    const t = now();
    if (t - st.lastInitAt < INIT_NUDGE_EVERY_MS) return;
    st.lastInitAt = t;
    await gw.post(st.connectionId, port, "/iserver/auth/ssodh/init", { publish: true, compete: false }).catch(() => null);
  }

  /** @param {WatchState} st */
  async function refreshActive(st) {
    const t = now();
    await setDetail(st, st.competing ? IBKR_DETAIL.competing : null);
    if (t - st.lastOkWrite < 5 * 60_000) return;
    st.lastOkWrite = t;
    /** @type {Record<string, string | null>} */
    const patch = { last_ok_at: iso(t) };
    // Still logged in past the 24 h mark: IBKR has not ended it yet. Keep the expiry an hour out
    // so the app shows "expiring" honestly instead of a time in the past.
    const row = await store.getConnection(st.connectionId).catch(() => null);
    const exp = parseTime(row?.session_expires_at);
    if (exp !== null && exp - t < 15 * 60_000) patch.session_expires_at = iso(t + 3_600_000);
    if (row && row.status !== "active") Object.assign(patch, { status: "active" });
    await update(st.connectionId, ["active", "error"], patch);
  }

  // A gateway that exits on its own takes the login with it. Only the watch of THAT gateway ends:
  // an old JVM that finishes exiting after a Reconnect started a new one says nothing about it.
  manager.events.on("exit", (/** @type {{ connectionId: string, port: number, expected: boolean }} */ ev) => {
    const st = watched.get(ev.connectionId);
    if (st && st.port !== ev.port) return;
    if (st) stop(st);
    if (ev.expected) return;
    if (manager.portFor(ev.connectionId) !== null) return; // already running on another gateway
    void update(ev.connectionId, ["active", "pending", "error"], {
      status: "expired",
      status_detail: IBKR_DETAIL.gatewayStopped,
    });
    void auditSystem(ev.connectionId, { action: "gateway.exit", result: "error" });
  });

  return {
    IBKR_DETAIL,

    watch,

    /**
     * Stops polling. With `port`, only while the watch is still on that gateway.
     * @param {string} connectionId
     * @param {number} [port]
     */
    unwatch(connectionId, port) {
      const st = watched.get(connectionId);
      if (st && (port === undefined || st.port === port)) stop(st);
    },

    /**
     * A connection whose gateway runs but which nobody polls gets its watch back (a status read
     * heals what a race left behind).
     * @param {string} connectionId
     */
    ensure(connectionId) {
      const st = watched.get(connectionId);
      const port = manager.portFor(connectionId);
      if (port && (!st || st.stopped || st.port !== port)) watch(connectionId);
    },

    /** @param {string} connectionId */
    isAuthenticated(connectionId) {
      const st = watched.get(connectionId);
      return !!st && st.authenticated && st.bootstrapped;
    },

    /** @param {string} connectionId */
    state(connectionId) {
      const st = watched.get(connectionId);
      if (!st) return null;
      return {
        authenticated: st.authenticated && st.bootstrapped,
        competing: st.competing,
        connected: st.connected,
        sso: st.sso,
        lastCheckAt: st.lastCheckAt,
      };
    },

    /**
     * Runs one cycle now (bounded) so a status request sees fresh state.
     * @param {string} connectionId
     * @param {number} [timeoutMs]
     */
    async checkNow(connectionId, timeoutMs = 4_000) {
      const st = watched.get(connectionId);
      if (!st || st.stopped) return;
      if (now() - st.lastCheckAt < 1_500 && !st.running) return;
      const done = st.running
        ? new Promise((r) => st.waiters.push(() => r(undefined)))
        : (async () => {
            if (st.timer) clearTimer(st.timer);
            st.timer = null;
            await cycle(st);
          })();
      await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
    },

    /** Runs one cycle and waits for it (tests). @param {string} connectionId */
    async tick(connectionId) {
      const st = watched.get(connectionId);
      if (!st) return;
      if (st.timer) clearTimer(st.timer);
      st.timer = null;
      await cycle(st);
    },

    watchedIds: () => [...watched.keys()],

    stopAll() {
      for (const st of [...watched.values()]) stop(st);
    },
  };
}

/** @typedef {ReturnType<typeof createIbkrSessions>} IbkrSessions */
