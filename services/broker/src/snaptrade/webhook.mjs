import { verifyWebhookSignature } from "./signer.mjs";

/**
 * POST /hooks/snaptrade (no service JWT; server.mjs hands over the raw body, at most 64 KB).
 *
 * Accepted only when all of these hold, else 401 (400 for a body that is not JSON):
 * - the Signature header is base64(HMAC-SHA256(consumer key, canonical JSON of the payload));
 * - clientId is Nasscord's own;
 * - eventTimestamp is within 5 minutes of now (SnapTrade's replay rule);
 * - its webhookId was not seen in the last 10 minutes (a repeat answers 200 and does nothing).
 * Then the event is mapped onto the workspace's connections (userId -> broker_aggregator_users,
 * brokerageAuthorizationId -> external_ref, or accountId -> broker_accounts):
 * - holdings and trades updated: the read cache of that connection is dropped (its transactions,
 *   read at most once a day, stay);
 * - transactions updated: the transactions are read again too;
 * - an account added or removed: the account list is loaded again on the next read;
 * - CONNECTION_BROKEN: the connection expires ("<Broker> ended Nasscord's access...");
 * - CONNECTION_FIXED: the connection is read again, and an expired one is active again once
 *   SnapTrade shows its authorization enabled;
 * - CONNECTION_DELETED: SnapTrade no longer holds it; the connection becomes an error.
 * Anything else (USER_REGISTERED, CONNECTION_ADDED...) is acknowledged and ignored: the connect
 * steps themselves record new connections. Nothing of the payload is logged but its event type.
 */

const MAX_SKEW_MS = 5 * 60_000;
const SEEN_MS = 10 * 60_000;

/** @typedef {"refresh" | "transactions" | "accounts" | "fixed" | "broken" | "deleted"} HookAction */

/** @type {Readonly<Record<string, HookAction>>} */
export const SNAPTRADE_EVENTS = Object.freeze({
  ACCOUNT_HOLDINGS_UPDATED: "refresh",
  ACCOUNT_TRANSACTIONS_INITIAL_UPDATE: "transactions",
  ACCOUNT_TRANSACTIONS_UPDATED: "transactions",
  TRADE_DETECTION: "refresh",
  TRADE_UPDATE: "refresh",
  CONNECTION_UPDATED: "refresh",
  CONNECTION_FIXED: "fixed",
  NEW_ACCOUNT_AVAILABLE: "accounts",
  ACCOUNT_REMOVED: "accounts",
  CONNECTION_BROKEN: "broken",
  CONNECTION_DELETED: "deleted",
});

/**
 * @param {{
 *   clientId: string,
 *   consumerKey: string,
 *   store: import("../db.mjs").Store,
 *   users: import("./users.mjs").SnapTradeUsers,
 *   log: import("../log.mjs").Logger,
 *   now: () => number,
 *   act: (action: HookAction, conn: import("../db.mjs").ConnectionRow) => Promise<void>,
 * }} deps
 */
export function createSnapTradeWebhook(deps) {
  const { store, users, log, now } = deps;
  /** @type {Map<string, number>} webhookId -> when it may be forgotten */
  const seen = new Map();

  /** @param {number} t */
  function prune(t) {
    if (seen.size < 500) return;
    for (const [id, until] of seen) if (until <= t) seen.delete(id);
  }

  /** @param {unknown} v */
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  /**
   * @param {{ headers: Record<string, string | string[] | undefined>, rawBody: Buffer }} req
   * @returns {Promise<{ status: number, body?: unknown }>}
   */
  return async function webhook(req) {
    const header = req.headers.signature;
    const signature = Array.isArray(header) ? header[0] : header;
    const text = req.rawBody.toString("utf8");
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== "object" || Array.isArray(v)) return { status: 400 };
    } catch {
      return { status: 400 };
    }
    const payload = verifyWebhookSignature(deps.consumerKey, req.rawBody, signature);
    if (!payload) {
      log.warn("snaptrade webhook refused", { reason: "signature" });
      return { status: 401 };
    }
    if (str(payload.clientId) !== deps.clientId) {
      log.warn("snaptrade webhook refused", { reason: "client" });
      return { status: 401 };
    }
    const t = now();
    const at = Date.parse(str(payload.eventTimestamp));
    if (!Number.isFinite(at) || Math.abs(t - at) > MAX_SKEW_MS) {
      log.warn("snaptrade webhook refused", { reason: "timestamp" });
      return { status: 401 };
    }
    const eventType = str(payload.eventType).toUpperCase().slice(0, 60);
    const webhookId = str(payload.webhookId).slice(0, 200);
    prune(t);
    if (webhookId) {
      if ((seen.get(webhookId) ?? 0) > t) return { status: 200, body: { ok: true, repeated: true } };
      seen.set(webhookId, t + SEEN_MS);
    }

    const action = SNAPTRADE_EVENTS[eventType];
    if (!action) return { status: 200, body: { ok: true } };
    const wid = await users.workspaceOf(str(payload.userId));
    if (!wid) return { status: 200, body: { ok: true } };
    const live = await store.listConnections({ workspace_id: wid, method: "snaptrade", status: ["neq", "disconnected"] });
    const authorizationId = str(payload.brokerageAuthorizationId) || str(payload.connectionId);
    let targets = authorizationId ? live.filter((c) => c.external_ref === authorizationId) : [];
    const accountId = str(payload.accountId);
    if (!targets.length && accountId && live.length) {
      const accounts = await store.listAccounts(live.map((c) => c.id));
      const ids = new Set(accounts.filter((a) => a.external_id === accountId).map((a) => a.connection_id));
      targets = live.filter((c) => ids.has(c.id));
    }
    for (const conn of targets) {
      await deps.act(action, conn);
      log.info("snaptrade webhook applied", { eventType, connectionId: conn.id });
    }
    return { status: 200, body: { ok: true } };
  };
}
