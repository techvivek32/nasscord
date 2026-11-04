import { ETRADE_DETAIL } from "./etrade/adapter.mjs";
import { IBKR_DETAIL } from "./ibkr/session.mjs";
import { createLocks } from "./locks.mjs";
import { parseTime } from "./time.mjs";

/**
 * Housekeeping, once a minute:
 * - E*TRADE: at 00:00 ET every active connection becomes expired ("E*TRADE ends every session at
 *   midnight Eastern..."); a pending one whose 5-minute request token ran out becomes expired;
 *   tokens idle for 90 minutes get a renew so E*TRADE's 2-hour idle cut-off does not hit.
 * - IBKR: a pending login past its window becomes expired and its gateway is stopped at once (it
 *   never held an IBKR session, so nothing in it is worth keeping, and a login started and never
 *   finished must not hold a slot); a gateway whose connection has been expired or errored for 30
 *   minutes is stopped and its slot released; a gateway with no connection row, or a disconnected
 *   one, is stopped at once.
 * On boot: IBKR connections that were pending or active belonged to JVMs of the previous process
 * and are marked expired.
 *
 * Every IBKR change runs under the connection's lock (the one Connect and Reconnect take) and
 * re-reads its state inside it, so a Reconnect pressed during a sweep is never undone. Slots are
 * released by port: the sweep stops the gateway it checked, never a newer one.
 */

/**
 * @param {{
 *   store: import("./db.mjs").Store,
 *   etrade: import("./etrade/adapter.mjs").EtradeAdapter,
 *   manager: import("./ibkr/gateway-manager.mjs").GatewayManager,
 *   sessions: import("./ibkr/session.mjs").IbkrSessions,
 *   audit: import("./audit.mjs").Audit,
 *   cache: import("./cache.mjs").CoalescingCache,
 *   log: import("./log.mjs").Logger,
 *   locks?: import("./locks.mjs").Locks,
 *   now?: () => number,
 *   intervalMs?: number,
 *   releaseAfterExpiryMs?: number,
 * }} deps
 */
export function createScheduler(deps) {
  const { store, etrade, manager, sessions, audit, cache, log, now = Date.now } = deps;
  const locks = deps.locks ?? createLocks();
  const intervalMs = deps.intervalMs ?? 60_000;
  const releaseAfterExpiryMs = deps.releaseAfterExpiryMs ?? 30 * 60_000;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let running = false;

  /** @param {import("./db.mjs").ConnectionRow} c @param {string} reason */
  const auditExpiry = (c, reason) =>
    audit.record({
      actor: "system",
      workspaceId: c.workspace_id,
      action: "broker.session.expired",
      target: `${c.broker_id} · ${c.environment} · ${c.id}`,
      meta: { reason },
    });

  async function etradeSweep() {
    const t = now();
    const rows = await store.listConnections({ broker_id: "etrade", status: ["in", ["active", "pending"]] });
    for (const c of rows) {
      const exp = parseTime(c.session_expires_at);
      try {
        if (exp !== null && exp <= t) {
          const detail = c.status === "active" ? ETRADE_DETAIL.midnight : ETRADE_DETAIL.codeTimeout;
          await etrade.expire(c, detail);
          await auditExpiry(c, detail);
          log.info("etrade connection expired", { connectionId: c.id, status: c.status });
        } else if (c.status === "active") {
          await etrade.keepFresh(c);
        }
      } catch (e) {
        log.warn("etrade sweep failed for a connection", { connectionId: c.id, error: e });
      }
    }
  }

  /** @param {number} port @param {string} connectionId */
  const slotNow = (port, connectionId) => manager.list().find((s) => s.port === port && s.connectionId === connectionId && !s.stopping);

  async function ibkrSweep() {
    const t = now();
    const pending = await store.listConnections({ broker_id: "ibkr", status: "pending" });
    for (const c of pending) {
      const exp = parseTime(c.session_expires_at);
      if (exp === null || exp > t) continue;
      await locks.run(c.id, async () => {
        // A Reconnect since the list was read opened a new login window: leave it alone.
        const row = await store.getConnection(c.id);
        const until = parseTime(row?.session_expires_at);
        if (!row || row.status !== "pending" || until === null || until > t) return;
        if (sessions.isAuthenticated(c.id)) return; // the bootstrap is about to flip it active
        sessions.unwatch(c.id);
        const done = await store.updateConnectionIf(c.id, ["pending"], { status: "expired", status_detail: IBKR_DETAIL.loginTimeout });
        cache.invalidate(c.id);
        if (done) await auditExpiry(c, IBKR_DETAIL.loginTimeout);
        // Reconnect starts a new gateway (a few seconds) and a new login window.
        const port = manager.portFor(c.id);
        if (port) {
          log.info("releasing gateway of a login not finished in time", { connectionId: c.id, port });
          await manager.stopSlot(port, c.id);
        }
      });
    }

    for (const slot of manager.list()) {
      if (slot.stopping) continue;
      let row = null;
      try {
        row = await store.getConnection(slot.connectionId);
      } catch (e) {
        log.warn("slot check could not read the connection", { connectionId: slot.connectionId, error: e });
        continue;
      }
      if (!row || row.status === "disconnected") {
        log.info("releasing gateway without a live connection", { connectionId: slot.connectionId, port: slot.port });
        sessions.unwatch(slot.connectionId, slot.port);
        await manager.stopSlot(slot.port, slot.connectionId);
        continue;
      }
      if (row.status === "expired" || row.status === "error") {
        if (slot.expiredAt === null) {
          manager.markExpired(slot.connectionId, t);
          continue;
        }
        if (t - slot.expiredAt < releaseAfterExpiryMs) continue;
        await locks.run(slot.connectionId, async () => {
          // Checked again under the lock: a Reconnect in between reuses the gateway (and clears
          // its expiry), and then it stays.
          const current = slotNow(slot.port, slot.connectionId);
          if (!current || current.expiredAt === null || t - current.expiredAt < releaseAfterExpiryMs) return;
          const fresh = await store.getConnection(slot.connectionId);
          if (fresh && fresh.status !== "expired" && fresh.status !== "error" && fresh.status !== "disconnected") return;
          log.info("releasing gateway 30 minutes after expiry", { connectionId: slot.connectionId, port: slot.port });
          sessions.unwatch(slot.connectionId, slot.port);
          await manager.stopSlot(slot.port, slot.connectionId);
        });
      } else if (slot.expiredAt !== null) {
        manager.markExpired(slot.connectionId, null);
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await etradeSweep().catch((e) => log.warn("etrade sweep failed", { error: e }));
      await ibkrSweep().catch((e) => log.warn("ibkr sweep failed", { error: e }));
    } finally {
      running = false;
    }
  }

  return {
    tick,

    /** Marks IBKR gateway sessions of a previous run as expired. */
    async recoverOnBoot() {
      const rows = await store.listConnections({
        broker_id: "ibkr",
        method: "ibkr_gateway",
        status: ["in", ["pending", "active"]],
      });
      for (const c of rows) {
        if (manager.portFor(c.id)) continue;
        await store.updateConnectionIf(c.id, ["pending", "active"], {
          status: "expired",
          status_detail: IBKR_DETAIL.serviceRestarted,
        });
      }
      if (rows.length) log.info("marked IBKR sessions of the previous run expired", { count: rows.length });
    },

    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
