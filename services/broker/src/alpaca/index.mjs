import { badGateway, badRequest, BrokerAuthError, conflict, HttpError, SessionExpiredError } from "../errors.mjs";
import { clean } from "../mapping.mjs";
import { iso } from "../time.mjs";
import { alpacaDataHost, alpacaHosts, createAlpacaClient, keyCheckTag } from "./client.mjs";
import { alpacaAccountRow, alpacaAccountSummary, alpacaExecutions, alpacaOrders, alpacaPosition, isAccountClosed } from "./mapping.mjs";
import { createAlpacaOrders } from "./orders.mjs";

/**
 * Alpaca with the user's own API key (method alpaca_key, flow api_key): the Live account or one of
 * the user's own Paper accounts, one connection per key (docs/real-backend.md, "Connect flows").
 *
 * - Connect: the pasted pair is checked with GET /v2/account on the live host, then the paper host
 *   (in Reconnect, the connection's own host first). The host that accepts it decides Live or
 *   Paper; Alpaca has no sample-data environment for this API. flows.mjs stores
 *   { keyId, secretKey, host } sealed in broker_secrets and reuses the connection of an account the
 *   workspace already has. The check runs on the bucket of that key pair alone (keyCheckTag), so a
 *   429 on one user's account never pauses anyone else's Connect.
 * - Reads: balances and positions (15 s cache), orders and fills of the last 30 days plus every
 *   open order (30 s cache). Read-only: client.mjs allows GET on the read endpoints only, except
 *   the trading part (`trading`, src/alpaca/orders.mjs, docs/real-backend.md section 13): order
 *   entry with its own clients and allowlists, which only the order core calls, after the workspace
 *   switch. It always gets the order's account (ctx.account), never accountOf's first-account fallback.
 * - Keys do not expire. When Alpaca refuses the key (401 or 403, also on /v2/account, so a refusal
 *   of one endpoint does not end a working connection) the user regenerated it, or reset or
 *   deleted the paper account: the connection becomes expired and renew answers next.kind
 *   "api_key". A key of another account is refused there.
 * - A closed account (a read or a renew found it) is an error with ALPACA_DETAIL.closed. Renew
 *   checks it again with the stored key and answers 409 account_closed while it stays closed,
 *   instead of asking for a key that cannot help. Because the adapter has its own renew, flows.mjs
 *   passes the BROKER_AUDIENCE gate before every Alpaca renew, a plain check included.
 * - Disconnect deletes the stored key (connections.mjs). Alpaca has no API to revoke a key, so
 *   revoke() does nothing; the dialog tells the user to regenerate it in Alpaca.
 */

export const ALPACA_DETAIL = Object.freeze({
  keyRefused: "Alpaca no longer accepts this key. Paste the new key.",
  paperKeyRefused: "Alpaca no longer accepts this key. Paste the new key, or, if you reset or deleted this paper account, disconnect it and connect the new one.",
  closed: "Alpaca says this account is closed. Disconnect it.",
});

const KEY_REFUSED = "Alpaca did not accept this key. Copy the Key ID and the Secret of the same account again, or generate a new pair in Alpaca.";
/** Orders and fills are read for this long back (open orders whatever their age). */
const HISTORY_MS = 30 * 24 * 3_600_000;
/** last_ok_at is written at most this often per connection. */
const OK_WRITE_MS = 60_000;
/** A key check's bucket that a 429 paused is kept this long (the limiter's longest pause), then dropped. */
const CHECK_KEEP_MS = 10 * 60_000;

/**
 * No scheduler work (keys do not expire) and no lazy account list (connect stores the one account).
 * @type {import("../adapter-types.mjs").AdapterDescriptor}
 */
export const ALPACA_DESCRIPTOR = Object.freeze(
  /** @type {import("../adapter-types.mjs").AdapterDescriptor} */ ({
    method: "alpaca_key",
    brokers: ["alpaca"],
    name: "Alpaca",
    environments: ["production", "paper"],
    readTtlMs: Object.freeze({ portfolio: 15_000, orders: 30_000, executions: 30_000 }),
    lazyAccounts: false,
    sweepEveryMs: null,
  }),
);

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("./client.mjs").AlpacaHost} AlpacaHost
 * @typedef {{ keyId: string, secretKey: string, host: AlpacaHost }} AlpacaSecret
 */

/** @param {import("../db.mjs").Environment} environment @returns {AlpacaHost} */
const hostOf = (environment) => (environment === "paper" ? "paper" : "live");

/** @param {unknown} s @returns {s is AlpacaSecret} */
const isKey = (s) => !!s && typeof s === "object" && typeof (/** @type {any} */ (s).keyId) === "string" && typeof (/** @type {any} */ (s).secretKey) === "string";

/** @type {import("../adapter-types.mjs").AdapterFactory} */
export function createAdapter(deps) {
  const { config, store, oauth2, cache, limiter, log, now } = deps;
  const hosts = alpacaHosts(deps.urls, config.production);
  const dataHost = alpacaDataHost(deps.urls, config.production);
  /** @type {Map<string, number>} last time last_ok_at was written */
  const lastOkWrite = new Map();
  /** @type {Map<string, number>} key-check tags whose bucket a 429 paused -> when it may be dropped */
  const pausedChecks = new Map();

  /**
   * Drops the key-check buckets whose pause is over, so the limiter does not keep one per key
   * ever checked. A check that ends without a 429 drops its bucket at once (connectKey).
   * @param {number} t
   */
  function pruneChecks(t) {
    for (const [tag, until] of pausedChecks) {
      if (until > t) continue;
      pausedChecks.delete(tag);
      limiter.forget(tag);
    }
  }

  /** @param {ConnectionRow} conn */
  const refusedDetail = (conn) => (conn.environment === "paper" ? ALPACA_DETAIL.paperKeyRefused : ALPACA_DETAIL.keyRefused);

  /** @param {ConnectionRow} conn @param {AlpacaSecret} secret */
  const clientFor = (conn, secret) => {
    const host = hostOf(conn.environment);
    // The key was checked on this host when it was stored; a key of the other host never reads here.
    if (secret.host && secret.host !== host) throw new Error("alpaca: the stored key is for another host than the connection");
    return createAlpacaClient({ http: deps.http, base: hosts[host], keyId: secret.keyId, secretKey: secret.secretKey, bucketKey: `alpaca:${conn.id}` });
  };

  /** @param {string} id */
  async function touch(id) {
    const t = now();
    if (t - (lastOkWrite.get(id) ?? 0) < OK_WRITE_MS) return;
    lastOkWrite.set(id, t);
    await store.updateConnectionIf(id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /**
   * Alpaca refused the key on /v2/account as well: the connection is expired, unless the key was
   * replaced while the read ran (then the new key reads next time). The key stays stored until
   * Disconnect or a replacement overwrites it.
   * @param {ConnectionRow} conn
   * @param {AlpacaSecret} used
   * @param {number} brokerStatus
   * @returns {Promise<never>}
   */
  async function keyRefused(conn, used, brokerStatus) {
    const current = await oauth2.loadSecret(conn.id, { fresh: true }).catch(() => null);
    if (isKey(current) && (current.keyId !== used.keyId || current.secretKey !== used.secretKey)) {
      throw new HttpError(409, "The Alpaca key of this connection was just replaced. Refresh to read with the new key.", { code: "key_replaced" });
    }
    const detail = refusedDetail(conn);
    cache.invalidate(conn.id);
    lastOkWrite.delete(conn.id);
    await store.updateConnectionIf(conn.id, ["active"], { status: "expired", status_detail: detail });
    log.info("alpaca key refused; connection expired", { connectionId: conn.id, brokerStatus });
    throw new SessionExpiredError(detail, { reauth: "api_key" });
  }

  /**
   * Runs a read with the connection's key. A 401 or 403 ends the connection only when /v2/account
   * refuses the key too; otherwise it was that one endpoint, and the read fails on its own.
   * @template T
   * @param {ConnectionRow} conn
   * @param {string} what for the sentence ("positions")
   * @param {(client: import("./client.mjs").AlpacaClient) => Promise<T>} fn
   * @param {boolean} [accountCall] fn is the /v2/account call itself
   * @returns {Promise<T>}
   */
  async function withKey(conn, what, fn, accountCall = false) {
    if (conn.status !== "active") throw new SessionExpiredError(conn.status_detail || refusedDetail(conn), { reauth: "api_key" });
    const secret = await oauth2.loadSecret(conn.id);
    if (!isKey(secret)) {
      const detail = refusedDetail(conn);
      await store.updateConnectionIf(conn.id, ["active"], { status: "expired", status_detail: detail });
      cache.invalidate(conn.id);
      throw new SessionExpiredError(detail, { reauth: "api_key" });
    }
    const client = clientFor(conn, secret);
    try {
      const out = await fn(client);
      await touch(conn.id);
      return out;
    } catch (e) {
      if (!(e instanceof BrokerAuthError)) throw e;
      if (!accountCall) {
        try {
          await client.account();
        } catch (e2) {
          if (e2 instanceof BrokerAuthError) return keyRefused(conn, secret, e2.brokerStatus);
          throw e2;
        }
        throw badGateway(`Alpaca refused to send the ${what} of this account (${e.brokerStatus}).`, "broker_forbidden");
      }
      return keyRefused(conn, secret, e.brokerStatus);
    }
  }

  /** @param {ConnectionRow} conn */
  async function markClosed(conn) {
    cache.invalidate(conn.id);
    await store.updateConnectionIf(conn.id, ["active"], { status: "error", status_detail: ALPACA_DETAIL.closed });
    log.info("alpaca account closed", { connectionId: conn.id });
  }

  /**
   * The /v2/account answer of a stored key, or a closed account turned into an error.
   * @param {ConnectionRow} conn
   */
  async function account(conn) {
    const a = await withKey(conn, "account", (c) => c.account(), true);
    if (isAccountClosed(a)) {
      await markClosed(conn);
      throw conflict(ALPACA_DETAIL.closed, "account_closed");
    }
    return a;
  }

  /**
   * refresh(): does the stored key still work? A refused key is "expired"; a closed account
   * answers its own 409 (and becomes an error).
   * @param {ConnectionRow} conn
   * @returns {Promise<"ok" | "expired">}
   */
  async function stillWorks(conn) {
    try {
      await account(conn);
      return "ok";
    } catch (e) {
      if (e instanceof SessionExpiredError) return "expired";
      throw e;
    }
  }

  /**
   * A connection a read found closed, checked again with its stored key. Still closed throws 409
   * account_closed; open again makes it active and answers the row; a refused or missing key
   * answers null (renew then asks for the key, and the replace-key connect checks the account).
   * @param {ConnectionRow} conn
   * @returns {Promise<ConnectionRow | null>}
   */
  async function recheckClosed(conn) {
    const secret = await oauth2.loadSecret(conn.id, { fresh: true });
    if (!isKey(secret)) return null;
    let a;
    try {
      a = await clientFor(conn, secret).account();
    } catch (e) {
      if (e instanceof BrokerAuthError) return null;
      throw e;
    }
    if (isAccountClosed(a)) throw conflict(ALPACA_DETAIL.closed, "account_closed");
    const t = now();
    const row = await store.updateConnectionIf(conn.id, ["error"], { status: "active", status_detail: null, last_ok_at: iso(t) });
    lastOkWrite.set(conn.id, t);
    cache.invalidate(conn.id);
    log.info("alpaca account open again; connection active", { connectionId: conn.id });
    return row ?? (await store.getConnection(conn.id));
  }

  /**
   * The connection's one account among those the read was given (normally exactly it).
   * @param {ConnectionRow} conn @param {AccountRow[]} accounts
   */
  const accountOf = (conn, accounts) => accounts.find((a) => a.external_id === conn.external_ref) ?? accounts[0] ?? null;

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const adapter = {
    descriptor: ALPACA_DESCRIPTOR,

    trading: createAlpacaOrders({ deps, hosts: { ...hosts, data: dataHost }, log: log.child({ part: "orders" }), now }),

    async connectKey(ctx, input) {
      const keyId = clean(input.keyId);
      const secretKey = input.secret;
      if (!keyId) throw badRequest("Paste the Alpaca API Key ID as well as the Secret.", "bad_key_id");
      /** @type {AlpacaHost[]} */
      const order = input.environment
        ? [hostOf(input.environment)]
        : ctx.existing?.environment === "paper"
          ? ["paper", "live"]
          : ["live", "paper"];
      pruneChecks(now());
      // The bucket of this key pair alone: Alpaca limits each account, so its 429 pauses this
      // pair's checks (a retry within the pause is answered here) and nobody else's.
      const tag = keyCheckTag(keyId, secretKey);
      let limited = false;
      try {
        /** @type {unknown} */
        let failure = null;
        for (const host of order) {
          const client = createAlpacaClient({ http: deps.http, base: hosts[host], keyId, secretKey, bucketKey: `alpaca:${tag}` });
          let a;
          try {
            a = await client.account();
          } catch (e) {
            // Refused here: maybe a key of the other host. A 429 stops the check; any other failure
            // (Alpaca down) is answered only if the other host does not take the key either.
            if (e instanceof BrokerAuthError) continue;
            if (e instanceof HttpError && e.status === 429) {
              limited = true;
              throw e;
            }
            failure ??= e;
            continue;
          }
          const id = clean(a.id);
          if (id.length > 200) throw badGateway("Alpaca sent an account answer Nasscord could not read.", "broker_reply");
          if (isAccountClosed(a)) throw badRequest("This Alpaca account is closed. Connect an open account.", "alpaca_account_closed");
          const environment = host === "paper" ? "paper" : "production";
          return {
            environment,
            externalRef: id,
            secret: /** @type {AlpacaSecret} */ ({ keyId, secretKey, host }),
            accounts: [alpacaAccountRow(a, environment)],
            scope: null,
            sessionExpiresAt: null,
          };
        }
        if (failure) throw failure;
        throw badRequest(KEY_REFUSED, "alpaca_key_rejected");
      } finally {
        // A paused bucket stays until its pause is over (pruneChecks); any other outcome drops it.
        if (limited) {
          pausedChecks.set(tag, now() + CHECK_KEEP_MS);
        } else {
          pausedChecks.delete(tag);
          limiter.forget(tag);
        }
      }
    },

    async listAccounts(conn) {
      return [alpacaAccountRow(await account(conn), conn.environment)];
    },

    async balances(conn, accounts) {
      const acct = accountOf(conn, accounts);
      if (!acct) return { accounts: [] };
      return { accounts: [alpacaAccountSummary(await account(conn), acct)] };
    },

    async positions(conn, accounts) {
      const acct = accountOf(conn, accounts);
      if (!acct) return [];
      const list = await withKey(conn, "positions", (c) => c.positions());
      return list.map((p) => alpacaPosition(p, acct));
    },

    async orders(conn, accounts) {
      const acct = accountOf(conn, accounts);
      if (!acct) return [];
      const t = now();
      const list = await withKey(conn, "orders", (c) => c.orders(/** @type {string} */ (iso(t - HISTORY_MS))));
      return alpacaOrders(list, acct, t);
    },

    async executions(conn, accounts) {
      const acct = accountOf(conn, accounts);
      if (!acct) return [];
      const t = now();
      const list = await withKey(conn, "fills", (c) => c.fills(/** @type {string} */ (iso(t - HISTORY_MS))));
      return alpacaExecutions(list, acct, t);
    },

    refresh: stillWorks,

    /**
     * Renew and Reconnect: flows.genericRenew for an api_key method, plus a closed account.
     * - active: a working key needs nothing; a refused one becomes expired and asks for the new
     *   key; an account Alpaca now calls closed answers 409 account_closed (refresh).
     * - closed (an error with ALPACA_DETAIL.closed): recheckClosed. Still closed answers 409
     *   account_closed, since no new key can help; open again is active again.
     * - anything else (expired): asks for the new key (next.kind "api_key").
     */
    async renew(conn) {
      if (conn.status === "error" && conn.status_detail === ALPACA_DETAIL.closed) {
        const row = await recheckClosed(conn);
        if (row) return { connection: row };
      } else if (conn.status === "active" && (await stillWorks(conn)) === "ok") {
        const row = await store.updateConnection(conn.id, { status_detail: null, last_ok_at: iso(now()) });
        return { connection: row ?? conn };
      }
      return { connection: (await store.getConnection(conn.id)) ?? conn, next: { kind: "api_key" } };
    },

    /** Alpaca has no API to revoke a key; Disconnect deletes the stored one. */
    async revoke() {},

    forget(id) {
      lastOkWrite.delete(id);
    },
  };
  return adapter;
}
