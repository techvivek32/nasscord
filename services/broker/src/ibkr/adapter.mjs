import { randomUUID } from "node:crypto";
import { badGateway, badRequest, conflict, HttpError, SessionExpiredError, unavailable, userMessage } from "../errors.mjs";
import { createLocks } from "../locks.mjs";
import { ibkrAccountSummary, ibkrExecution, ibkrOrder, ibkrPosition } from "../mapping.mjs";
import { iso } from "../time.mjs";
import { IBKR_DETAIL } from "./session.mjs";

/**
 * IBKR through one Client Portal Gateway per connection (method "ibkr_gateway").
 * Nothing secret is stored: the user logs in on IBKR's own page (through the login host) and the
 * session lives inside the gateway JVM.
 *
 * Reads (contract section 7): /portfolio/{acct}/summary, /portfolio/{acct}/positions/{page},
 * /iserver/account/orders, /iserver/account/trades, /iserver/account/pnl/partitioned.
 *
 * The same interface (start, renew, disconnect, portfolio, orders, executions) is what a later
 * IBKR OAuth adapter ("ibkr_oauth") implements.
 */

const MAX_POSITION_PAGES = 20;
/** IBKR's documented minimum page size; a shorter page is the last one. */
const MIN_PAGE_SIZE = 30;

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 */

/**
 * @param {{
 *   store: import("../db.mjs").Store,
 *   manager: import("./gateway-manager.mjs").GatewayManager,
 *   sessions: import("./session.mjs").IbkrSessions,
 *   gw: import("./gateway-http.mjs").GatewayHttp,
 *   tokens: import("./login-proxy.mjs").LoginTokens,
 *   cache: import("../cache.mjs").CoalescingCache,
 *   locks?: import("../locks.mjs").Locks,
 *   publicLoginUrl: string,
 *   loginWindowMs: number,
 *   maxPendingLogins?: number,
 *   log: import("../log.mjs").Logger,
 *   now?: () => number,
 * }} deps
 */
export function createIbkrAdapter(deps) {
  const { store, manager, sessions, gw, tokens, cache, publicLoginUrl, loginWindowMs, log, now = Date.now } = deps;
  const locks = deps.locks ?? createLocks();
  const maxPendingLogins = deps.maxPendingLogins ?? Infinity;

  /**
   * Gateways waiting for a login: running, not logged in, and not already counting down to their
   * release after an expiry. Capped (IBKR_MAX_PENDING_LOGINS) so logins that are started and never
   * finished cannot take every slot from people who are logged in or about to be.
   */
  const pendingLogins = () =>
    manager.list().filter((s) => !s.stopping && s.expiredAt === null && !sessions.isAuthenticated(s.connectionId)).length;

  /** @param {string} cid */
  const loginUrl = (cid) => `${publicLoginUrl}/start?t=${encodeURIComponent(tokens.issueTicket(cid))}`;

  /**
   * The gateway port of a connection whose IBKR session is open, or a SessionExpiredError.
   * @param {ConnectionRow} connection
   */
  function livePort(connection) {
    const port = manager.portFor(connection.id);
    if (connection.status !== "active" || !port || !sessions.isAuthenticated(connection.id)) {
      throw new SessionExpiredError(connection.status_detail || IBKR_DETAIL.ended);
    }
    return port;
  }

  /**
   * GET through the gateway with the IBKR quirks handled: a 401 means the session is gone, and a
   * 400 on /iserver/account/* right after a re-login usually means /iserver/accounts has to be read
   * first ("no bridge"), so that is done once before one retry.
   * @param {ConnectionRow} connection
   * @param {number} port
   * @param {string} path
   */
  async function read(connection, port, path) {
    let res = await gw.get(connection.id, port, path);
    if (res.status === 400 && path.startsWith("/iserver/account")) {
      await gw.get(connection.id, port, "/iserver/accounts");
      res = await gw.get(connection.id, port, path);
    }
    if (res.status === 401) {
      void sessions.checkNow(connection.id);
      throw new SessionExpiredError(IBKR_DETAIL.ended);
    }
    if (res.status === 429) throw new HttpError(429, "IBKR is limiting requests right now. Try again in a few seconds.", { code: "rate_limited", retryAfterSec: 5 });
    if (res.status >= 400) throw badGateway(`IBKR answered with an error (${res.status}). Try again in a moment.`, "ibkr_http");
    return res.json;
  }

  /**
   * Starts a gateway for a connection and returns the login URL.
   * @param {ConnectionRow} connection
   */
  async function openLogin(connection) {
    if (!manager.bundleAvailable()) {
      throw unavailable("IBKR connections are not set up on this server yet.", "no_bundle");
    }
    // A connection that already has a gateway reuses it; only a new one needs a free pending place.
    if (!manager.portFor(connection.id) && pendingLogins() >= maxPendingLogins) {
      log.warn("ibkr pending logins at the cap", { cap: maxPendingLogins });
      throw unavailable("Too many IBKR logins are waiting to be finished on this server. Try again in a few minutes.", "too_many_pending");
    }
    await manager.start(connection.id);
    sessions.watch(connection.id);
    return loginUrl(connection.id);
  }

  /** @param {ConnectionRow} connection */
  const isLive = (connection) =>
    connection.status === "active" && !!manager.portFor(connection.id) && sessions.isAuthenticated(connection.id);

  /**
   * A login link for an existing connection. Still logged in: the link only shows the done page.
   * Otherwise the gateway is started (or reused) and the connection goes back to pending.
   * @param {ConnectionRow} connection
   * @returns {Promise<{ connection: ConnectionRow, loginUrl: string }>}
   */
  async function relogin(connection) {
    if (isLive(connection)) return { connection, loginUrl: loginUrl(connection.id) };
    const url = await openLogin(connection);
    const row = await store.updateConnection(connection.id, {
      status: "pending",
      status_detail: IBKR_DETAIL.pending,
      session_expires_at: iso(now() + loginWindowMs),
    });
    manager.markExpired(connection.id, null);
    cache.invalidate(connection.id);
    return { connection: row ?? connection, loginUrl: url };
  }

  return {
    /**
     * @param {{ claims: import("../jwt.mjs").ServiceClaims, environment: unknown }} input
     * @returns {Promise<{ connection: ConnectionRow, loginUrl: string }>}
     */
    async start({ claims, environment }) {
      if (environment !== "production" && environment !== "paper") {
        throw badRequest("Choose Live or Paper for IBKR.");
      }
      if (!manager.bundleAvailable()) {
        throw unavailable("IBKR connections are not set up on this server yet.", "no_bundle");
      }
      // One IBKR connection per workspace and environment: pressing Connect again reuses it (and
      // its gateway, and the user's included/excluded accounts) instead of piling up rows and slots.
      const existing = (
        await store.listConnections({
          workspace_id: /** @type {string} */ (claims.wid),
          broker_id: "ibkr",
          method: "ibkr_gateway",
          environment: /** @type {string} */ (environment),
          status: ["in", ["pending", "active", "expired", "error"]],
        })
      ).at(-1);
      if (existing) {
        // Same lock as Reconnect, a gateway restart and the slot release on this connection.
        const reused = await locks.run(existing.id, async () => {
          const fresh = await store.getConnection(existing.id);
          // Disconnected in the meantime: it is not revived, a new connection is made below.
          return fresh && fresh.status !== "disconnected" ? relogin(fresh) : null;
        });
        if (reused) return reused;
      }

      const id = randomUUID();
      const connection = await store.insertConnection({
        id,
        workspace_id: claims.wid,
        user_id: claims.sub,
        broker_id: "ibkr",
        method: "ibkr_gateway",
        environment,
        status: "pending",
        status_detail: IBKR_DETAIL.pending,
        // While pending, this is the end of the login window.
        session_expires_at: iso(now() + loginWindowMs),
      });
      try {
        return { connection, loginUrl: await openLogin(connection) };
      } catch (e) {
        await store
          .updateConnection(id, { status: "error", status_detail: e instanceof HttpError ? e.message : IBKR_DETAIL.gatewayStopped })
          .catch(() => {});
        throw e;
      }
    },

    /**
     * Gateway still running: a fresh login link for it (or nothing to do when logged in).
     * Gateway gone: start a new one, connection back to pending.
     * @param {ConnectionRow} connection
     * @returns {Promise<{ connection: ConnectionRow, loginUrl?: string }>}
     */
    async renew(connection) {
      if (isLive(connection)) return { connection };
      return relogin(connection);
    },

    /**
     * A fresh one-time login link for a gateway that is already running (the app's
     * GET /api/broker/ibkr/login/[id] asks for one at the moment the user opens the login, so the
     * link the browser follows is never older than a few seconds). Starts nothing: a connection
     * without a running gateway needs Reconnect first.
     * @param {ConnectionRow} connection
     * @returns {{ loginUrl: string }}
     */
    loginLink(connection) {
      if (connection.status === "disconnected") {
        throw conflict("This IBKR connection was removed. Connect IBKR again from Nasscord.", "disconnected");
      }
      if (!manager.portFor(connection.id)) {
        throw conflict("This IBKR login is not running any more. Press Reconnect in Nasscord to start a new one.", "no_gateway");
      }
      return { loginUrl: loginUrl(connection.id) };
    },

    /** @param {ConnectionRow} connection */
    async disconnect(connection) {
      const port = manager.portFor(connection.id);
      sessions.unwatch(connection.id);
      if (port) {
        await gw.post(connection.id, port, "/logout", {}).catch(() => null);
        await manager.stop(connection.id);
      }
    },

    /**
     * One account that cannot be read is reported in `errors` and left out; the others are still
     * answered. A lost session or a rate limit fails the whole connection.
     * @param {ConnectionRow} connection
     * @param {AccountRow[]} accounts included accounts of this connection
     */
    async portfolio(connection, accounts) {
      const port = livePort(connection);
      const pnl = await read(connection, port, "/iserver/account/pnl/partitioned").catch((e) => {
        if (e instanceof SessionExpiredError) throw e;
        log.info("ibkr pnl unavailable", { connectionId: connection.id, error: e });
        return null;
      });
      /** @type {import("../mapping.mjs").AccountSummary[]} */
      const summaries = [];
      /** @type {import("../mapping.mjs").Position[]} */
      const positions = [];
      /** @type {Array<{ connectionId: string, message: string }>} */
      const errors = [];
      /** @type {unknown} */
      let firstError = null;
      for (const account of accounts) {
        const acct = encodeURIComponent(account.external_id);
        try {
          const summary = await read(connection, port, `/portfolio/${acct}/summary`);
          /** @type {import("../mapping.mjs").Position[]} */
          const own = [];
          for (let page = 0; page < MAX_POSITION_PAGES; page++) {
            const list = await read(connection, port, `/portfolio/${acct}/positions/${page}`);
            const items = Array.isArray(list) ? list : [];
            for (const p of items) if (Number(p?.position ?? 0) !== 0) own.push(ibkrPosition(p, account));
            if (items.length < MIN_PAGE_SIZE) break;
          }
          summaries.push(ibkrAccountSummary(summary, pnl, account));
          positions.push(...own);
        } catch (e) {
          if (e instanceof SessionExpiredError || (e instanceof HttpError && e.status === 429)) throw e;
          if (!(e instanceof HttpError)) log.error("ibkr account read failed", { connectionId: connection.id, error: e });
          firstError ??= e;
          errors.push({ connectionId: connection.id, message: `IBKR account ${account.display_number}: ${userMessage(e)}` });
        }
      }
      if (!summaries.length && firstError) throw firstError;
      return { accounts: summaries, positions, errors };
    },

    /**
     * @param {ConnectionRow} connection
     * @param {AccountRow[]} accounts
     */
    async orders(connection, accounts) {
      const port = livePort(connection);
      const fetchedAt = now();
      const body = await read(connection, port, "/iserver/account/orders");
      const list = Array.isArray(body?.orders) ? body.orders : Array.isArray(body) ? body : [];
      const byNumber = new Map(accounts.map((a) => [a.external_id, a]));
      return list
        .filter((/** @type {any} */ o) => byNumber.has(String(o.acct ?? o.account ?? "")))
        .map((/** @type {any} */ o) => ibkrOrder(o, /** @type {AccountRow} */ (byNumber.get(String(o.acct ?? o.account))), fetchedAt));
    },

    /**
     * @param {ConnectionRow} connection
     * @param {AccountRow[]} accounts
     */
    async executions(connection, accounts) {
      const port = livePort(connection);
      const fetchedAt = now();
      const body = await read(connection, port, "/iserver/account/trades?days=7");
      const list = Array.isArray(body) ? body : [];
      const byNumber = new Map(accounts.map((a) => [a.external_id, a]));
      return list
        .filter((/** @type {any} */ t) => byNumber.has(String(t.account ?? t.accountCode ?? "")))
        .map((/** @type {any} */ t) =>
          ibkrExecution(t, /** @type {AccountRow} */ (byNumber.get(String(t.account ?? t.accountCode))), fetchedAt),
        );
    },
  };
}

/** @typedef {ReturnType<typeof createIbkrAdapter>} IbkrAdapter */
