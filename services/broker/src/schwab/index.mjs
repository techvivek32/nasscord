import { badRequest, BrokerAuthError, HttpError, SessionExpiredError } from "../errors.mjs";
import { loginRef } from "../oauth2.mjs";
import { iso, parseTime } from "../time.mjs";
import { bucketFor, createSchwabClient, SCHWAB_API, SCHWAB_OAUTH_PATHS } from "./client.mjs";
import { schwabAccountRows, schwabAccountSummary, schwabExecutions, schwabHashes, schwabOrders, schwabPosition, schwabPrefs } from "./mapping.mjs";

/**
 * Charles Schwab (schwab_oauth), read only (docs/real-backend.md, sections 8 to 11).
 *
 * Clients:
 * - "user": the user's own Trader API - Individual app (App Key and Secret pasted in Nasscord, the
 *   callback https://nasscord.com/api/broker/callback/schwab registered on it). Schwab defines an
 *   Individual app as your own app for your own account, so BROKER_AUDIENCE keeps this to the
 *   platform owner (schwab_oauth.user=superadmin) until Schwab agrees in writing.
 * - "platform": Nasscord's Trader API - Commercial app (SCHWAB_CLIENT_ID / SCHWAB_CLIENT_SECRET),
 *   unavailable until those are set and opened with BROKER_AUDIENCE.
 *
 * Sessions: the access token lives 30 minutes and is refreshed lazily when under 5 minutes are left
 * (HTTP Basic with the App Key and Secret). The refresh token dies 7 days after the browser login
 * and refreshing does not extend it: session_expires_at is that deadline, the app warns 48 hours
 * before (reconnectWarnHours in src/lib/broker-connect), and refresh() (the scheduler, every 5
 * minutes) expires the connection at the deadline: "Schwab requires a new login every 7 days.
 * Reconnect to continue." Reconnect reuses the stored App Key and Secret.
 *
 * The login's identity (external_ref, critique D2): the id_token `sub` when Schwab sends one, else
 * sha256 of the App Key and the sorted account numbers (loginRef in src/oauth2.mjs; the numbers and
 * not the hashValues, because Schwab may re-key the hashes and the same login must be found again).
 * Schwab does not document its id_token, so a Reconnect of a sub-named connection that comes back
 * with another `sub` keeps the connection's ref only when the login cannot be anyone else's (every
 * shared account already this connection's, neither the new name nor any of those accounts held by
 * another live connection of the workspace: sameLoginAgain); any other login is refused by flows
 * (409 other_account). An h:-named connection follows the framework: its name may move with the
 * account list, never onto another connection's login (409 other_connection).
 *
 * History: orders entered in the last 60 days (orders and executions), TRADE transactions of the
 * last 60 days (commissions, and the fills of older orders). A working GTC order entered more than
 * 60 days ago is not listed under Orders; its fills still appear under Executions.
 *
 * Account hashes: every account path takes the hashValue from /accounts/accountNumbers. The map
 * (account number -> hash) lives in the sealed secret (`extra.hashes`), is read at every login, again
 * after 24 hours, and when an account's hash is missing or refused.
 *
 * Nothing here logs a token, code, key, account number, hash or query string.
 */

/** Sentences on the connection (status_detail) and in read errors. */
export const SCHWAB_DETAIL = Object.freeze({
  weekly: "Schwab requires a new login every 7 days. Reconnect to continue.",
  ended: "Schwab no longer accepts this login. Reconnect to continue.",
  noAccounts: "Schwab shared no accounts with Nasscord. Start again and tick at least one account on Schwab's page.",
  /** @param {string} display masked account number */
  missingAccount: (display) => `Schwab did not send account ${display}. Reconnect and tick it on Schwab's page to see it again.`,
});

/** The refresh token's hard life, from the browser login. */
export const SCHWAB_LOGIN_MS = 7 * 24 * 3_600_000;
const ACCESS_MS = 30 * 60_000;
const REFRESH_BEFORE_MS = 5 * 60_000;
/** A refused refresh this close to the 7-day deadline is the weekly login, not a revoked grant. */
const NEAR_END_MS = 60 * 60_000;
/** Order and transaction history read per account. */
export const SCHWAB_HISTORY_MS = 60 * 24 * 3_600_000;
const HASHES_TTL_MS = 24 * 3_600_000;
/** At most one account-hash read per minute per connection when a hash is missing or refused. */
const HASH_REREAD_MIN_MS = 60_000;
/** Raw orders are shared by orders() and executions() for this long. */
const ORDERS_RAW_TTL_MS = 10_000;
const LAST_OK_EVERY_MS = 60_000;

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("../oauth2.mjs").OAuthSecret} OAuthSecret
 * @typedef {import("../oauth2.mjs").OAuthProfile} OAuthProfile
 * @typedef {import("./client.mjs").SchwabAuth} SchwabAuth
 * @typedef {"user" | "platform"} Client
 */

/**
 * Schwab's token errors: an expired refresh token has come back as invalid_client and as
 * refresh_token_authentication_error; both mean "log in again".
 * @param {number} status
 * @param {any} json
 * @returns {"invalid_grant" | "invalid_client" | "other"}
 */
export function schwabTokenError(status, json) {
  const err = String(json?.error ?? "").toLowerCase();
  if (err === "invalid_grant" || err === "refresh_token_authentication_error") return "invalid_grant";
  if (err === "invalid_client" || err === "unauthorized_client" || status === 401) return "invalid_client";
  return "other";
}

/**
 * When the login behind a secret ends: the stored refresh end, and never later than 7 days after the
 * browser login (refreshIssuedAt), whatever Schwab's token answer said. Null without a refresh token.
 * @param {OAuthSecret | null | undefined} s
 * @returns {number | null}
 */
export function schwabDeadline(s) {
  const stored = parseTime(s?.refreshExpiresAt);
  const issued = parseTime(s?.refreshIssuedAt);
  const hard = issued === null ? null : issued + SCHWAB_LOGIN_MS;
  if (stored === null) return hard;
  if (hard === null) return stored;
  return Math.min(stored, hard);
}

/** @type {import("../adapter-types.mjs").AdapterFactory} */
export function createAdapter(deps) {
  const { config, store, oauth2, locks, cache, log, now } = deps;
  const apiBase = (deps.urls.api ?? SCHWAB_API).replace(/\/+$/, "");
  const oauthBase = (deps.urls.oauth ?? apiBase).replace(/\/+$/, "");
  const client = createSchwabClient({ http: deps.http, base: apiBase });
  const platform = config.brokers.schwab.clientId && config.brokers.schwab.clientSecret ? { clientId: config.brokers.schwab.clientId, clientSecret: config.brokers.schwab.clientSecret } : null;

  /** @type {Map<string, { at: number, hashes: Record<string, string> }>} the last hash map read from Schwab per connection */
  const hashReads = new Map();
  /** @type {Map<string, Promise<Record<string, string>>>} a hash read in flight per connection (one at a time) */
  const hashInflight = new Map();
  /** @type {Map<string, number>} last last_ok_at write per connection */
  const lastOkWrite = new Map();

  /**
   * @param {Client} kind
   * @param {string} [expiredDetail] the sentence when the engine ends the login
   * @returns {OAuthProfile}
   */
  function profileOf(kind, expiredDetail = SCHWAB_DETAIL.weekly) {
    return {
      brokerId: "schwab",
      name: "Schwab",
      authorizeUrl: `${oauthBase}${SCHWAB_OAUTH_PATHS.authorize}`,
      tokenUrl: `${oauthBase}${SCHWAB_OAUTH_PATHS.token}`,
      clientAuth: "basic",
      sendRedirectUri: true,
      scope: null,
      pkce: false,
      platformClient: kind === "platform" ? platform : null,
      refresh: { kind: "fixed", hardExpiryMs: SCHWAB_LOGIN_MS, accessFallbackMs: ACCESS_MS, refreshBeforeMs: REFRESH_BEFORE_MS },
      expiredDetail,
      tokenRatePerSec: 2,
      parseTokenError: schwabTokenError,
    };
  }

  /** @param {OAuthSecret | null | undefined} s @returns {Client} */
  const kindOf = (s) => (s?.client === "platform" ? "platform" : "user");

  /** The App Key a secret authenticates with (the user's own, or Nasscord's). @param {OAuthSecret | null | undefined} s */
  const appKeyOf = (s) => (kindOf(s) === "platform" ? (platform?.clientId ?? "") : (s?.clientId ?? ""));

  /** @param {ConnectionRow} conn @param {string} detail */
  async function endLogin(conn, detail) {
    await oauth2.expire(conn, detail);
    return new SessionExpiredError(detail, { reauth: "redirect" });
  }

  /**
   * A bearer token for an active connection: the 7-day deadline first, then the engine (lazy
   * refresh under the token lock, saved before use).
   * @param {ConnectionRow} conn
   * @returns {Promise<SchwabAuth>}
   */
  async function bearer(conn) {
    const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
    const deadline = schwabDeadline(s);
    if (conn.status === "active" && deadline !== null && deadline <= now()) throw await endLogin(conn, SCHWAB_DETAIL.weekly);
    const detail = deadline !== null && deadline - now() < NEAR_END_MS ? SCHWAB_DETAIL.weekly : SCHWAB_DETAIL.ended;
    const token = await oauth2.accessToken(conn, profileOf(kindOf(s), detail));
    const key = appKeyOf(s);
    return { token, bucket: key ? bucketFor(kindOf(s), key) : `schwab:${conn.id}` };
  }

  /**
   * Schwab refused a token Nasscord still thought valid: mark it stale (under the engine's token
   * lock, and only if no other call has refreshed it already) so the next bearer() refreshes.
   * @param {ConnectionRow} conn @param {string} token
   */
  async function markStale(conn, token) {
    await locks.run(`token:${conn.id}`, async () => {
      const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id, { fresh: true }));
      if (s?.accessToken === token) await oauth2.saveSecret(conn.id, { ...s, accessExpiresAt: iso(0) });
    });
  }

  /**
   * Runs a read with a bearer token. A 401 gets one refresh and one retry; a second 401 ends the
   * login (the user revoked the app at Schwab, or Schwab disabled it).
   * @template T
   * @param {ConnectionRow} conn
   * @param {(auth: SchwabAuth) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withAuth(conn, fn) {
    const auth = await bearer(conn);
    try {
      return await fn(auth);
    } catch (e) {
      if (!(e instanceof BrokerAuthError && e.brokerStatus === 401)) throw e;
    }
    await markStale(conn, auth.token);
    const again = await bearer(conn);
    try {
      return await fn(again);
    } catch (e) {
      if (e instanceof BrokerAuthError && e.brokerStatus === 401) {
        log.info("schwab refused a fresh token; login needed", { connectionId: conn.id });
        throw await endLogin(conn, SCHWAB_DETAIL.ended);
      }
      throw e;
    }
  }

  /** last_ok_at after a read that worked, at most once a minute. @param {ConnectionRow} conn */
  async function touch(conn) {
    const t = now();
    if (t - (lastOkWrite.get(conn.id) ?? 0) < LAST_OK_EVERY_MS) return;
    lastOkWrite.set(conn.id, t);
    await store.updateConnectionIf(conn.id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /**
   * The account number -> hash map. From the sealed secret, read again from Schwab when it is older
   * than a day, or when an account is missing from it or `force` is set; never more than once a
   * minute per connection (the map read in that minute is the answer), and one read at a time
   * (parallel reads of several accounts share it).
   * @param {ConnectionRow} conn
   * @param {{ need?: string[], force?: boolean }} [o]
   * @returns {Promise<Record<string, string>>}
   */
  async function hashMap(conn, o = {}) {
    const inflight = hashInflight.get(conn.id);
    if (inflight) return inflight;
    const last = hashReads.get(conn.id);
    if (last && now() - last.at < HASH_REREAD_MIN_MS) return last.hashes;

    const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
    const extra = /** @type {Record<string, unknown>} */ (s?.extra ?? {});
    const stored = extra.hashes && typeof extra.hashes === "object" ? /** @type {Record<string, string>} */ (extra.hashes) : null;
    const at = parseTime(typeof extra.hashesAt === "string" ? extra.hashesAt : null);
    const stale = !stored || at === null || now() - at >= HASHES_TTL_MS;
    const missing = (o.need ?? []).some((n) => !stored?.[n]);
    if (!(stale || missing || o.force)) return stored ?? {};
    // Another caller may have started the read while the secret was loading.
    const started = hashInflight.get(conn.id);
    if (started) return started;

    const read = (async () => {
      const hashes = schwabHashes(await withAuth(conn, (auth) => client.accountNumbers(auth)));
      hashReads.set(conn.id, { at: now(), hashes });
      await locks
        .run(`token:${conn.id}`, async () => {
          // Under the engine's token lock and on the freshest copy, so a refresh is never overwritten.
          const cur = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id, { fresh: true }));
          if (!cur?.accessToken) return; // the login ended or the connection went meanwhile
          const row = await store.getConnection(conn.id);
          if (!row || row.status === "disconnected") return;
          await oauth2.saveSecret(conn.id, { ...cur, extra: { ...(cur.extra ?? {}), hashes, hashesAt: iso(now()) } });
        })
        .catch((e) => log.warn("schwab account hashes not saved", { connectionId: conn.id, error: e }));
      return hashes;
    })().finally(() => hashInflight.delete(conn.id));
    hashInflight.set(conn.id, read);
    return read;
  }

  /**
   * Runs a read that needs the account's hash. Answers null when Schwab no longer lists the account
   * (the portfolio read reports it as an error entry), so one account never fails the others. A
   * refused hash path gets one fresh hash map (at most once a minute) and one retry with a new hash.
   * @template T
   * @param {ConnectionRow} conn
   * @param {AccountRow} account
   * @param {(hash: string) => Promise<T>} fn
   * @returns {Promise<T | null>}
   */
  async function withHash(conn, account, fn) {
    const hash = (await hashMap(conn, { need: [account.external_id] }))[account.external_id];
    if (!hash) return null;
    try {
      return await fn(hash);
    } catch (e) {
      if (!(e instanceof HttpError && e.code === "broker_http")) throw e;
      const fresh = await hashMap(conn, { force: true });
      const next = fresh[account.external_id];
      if (!next && Object.keys(fresh).length > 0) return null;
      if (!next || next === hash) throw e;
      return fn(next);
    }
  }

  /**
   * Raw orders of one account for the last 60 days (shared by orders() and executions()).
   * @param {ConnectionRow} conn @param {AccountRow} account @param {number} t
   * @returns {Promise<unknown[] | null>}
   */
  function rawOrders(conn, account, t) {
    return cache.get(
      `${conn.id}:schwab-orders:${account.id}`,
      () => withHash(conn, account, (hash) => withAuth(conn, (auth) => client.orders(auth, hash, t - SCHWAB_HISTORY_MS, t))),
      ORDERS_RAW_TTL_MS,
    );
  }

  /**
   * Schwab does not document its id_token, so the weekly login of the same person may come back
   * with another `sub`. It is taken as this connection's login only when it cannot be anyone
   * else's: every account it shares is already an account of this connection, no other live
   * connection of the workspace holds the new name, and none holds any of those accounts. Anything
   * else (an account this connection never had, a login or an account another connection holds)
   * keeps the new name, and flows refuses the Reconnect.
   * @param {ConnectionRow} conn
   * @param {string} ref the name Schwab's answer gives the login
   * @param {string[]} numbers the account numbers the login shares
   */
  async function sameLoginAgain(conn, ref, numbers) {
    const known = new Set((await store.listAccounts([conn.id])).map((a) => a.external_id));
    if (numbers.length === 0 || !numbers.every((n) => known.has(n))) return false;
    const others = (
      await store.listConnections({ workspace_id: conn.workspace_id, broker_id: conn.broker_id, environment: conn.environment, status: ["neq", "disconnected"] })
    ).filter((c) => c.id !== conn.id);
    if (others.some((c) => c.external_ref === ref)) return false;
    const held = new Set((await store.listAccounts(others.map((c) => c.id))).map((a) => a.external_id));
    return !numbers.some((n) => held.has(n));
  }

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const adapter = {
    descriptor: {
      method: "schwab_oauth",
      brokers: ["schwab"],
      name: "Schwab",
      // Schwab's Trader API has no sandbox and no paper environment: only the user's own accounts.
      environments: ["production"],
      readTtlMs: { portfolio: 10_000, orders: 15_000, executions: 30_000 },
      lazyAccounts: false,
      sweepEveryMs: 5 * 60_000,
      clients: ["user", "platform"],
    },

    oauthProfile: (_environment, kind) => profileOf(kind),

    /**
     * After the code exchange (canonical host; the connection may still be pending): the hash map
     * and the login's external_ref.
     */
    async identify(conn, tokens, secret) {
      const key = appKeyOf(secret);
      const auth = { token: tokens.accessToken, bucket: key ? bucketFor(kindOf(secret), key) : `schwab:${conn.id}` };
      const hashes = schwabHashes(await client.accountNumbers(auth));
      const numbers = Object.keys(hashes);
      if (numbers.length === 0) throw badRequest(SCHWAB_DETAIL.noAccounts, "schwab_no_accounts");
      let ref = loginRef({ idToken: tokens.idToken, key, members: numbers });
      if (!ref) throw new Error("schwab identify: no App Key to name the login with");
      // A Reconnect of a sub-named login that came back named differently: kept only when it cannot
      // be another login (sameLoginAgain); otherwise flows refuses it (409 other_account). An h:
      // name follows the framework's rule (it may move with the account list).
      if (conn.external_ref && ref !== conn.external_ref && !conn.external_ref.startsWith("h:") && (await sameLoginAgain(conn, ref, numbers))) {
        ref = conn.external_ref;
      }
      // The secret gets this map (flows saves `extra`), or keeps its own if the login is refused.
      hashReads.delete(conn.id);
      return { externalRef: ref, extra: { hashes, hashesAt: iso(now()) } };
    },

    /** The shared accounts, typed from GET /accounts and named from /userPreference. */
    async listAccounts(conn) {
      const [accounts, prefs] = await Promise.all([
        withAuth(conn, (auth) => client.accounts(auth)),
        withAuth(conn, (auth) => client.userPreference(auth)).catch((e) => {
          if (e instanceof SessionExpiredError) throw e;
          log.info("schwab account nicknames not available", { connectionId: conn.id, error: e });
          return null;
        }),
      ]);
      await touch(conn);
      return schwabAccountRows(accounts, schwabPrefs(prefs));
    },

    /**
     * The scheduler (every 5 minutes) and Reconnect: expired at the 7-day mark, otherwise the access
     * token is kept fresh (a refresh only when under 5 minutes are left).
     */
    async refresh(conn) {
      try {
        await bearer(conn);
        return "ok";
      } catch (e) {
        if (e instanceof SessionExpiredError) return "expired";
        throw e;
      }
    },

    async portfolio(conn, accounts) {
      const list = await withAuth(conn, (auth) => client.accounts(auth, { positions: true }));
      /** @type {Map<string, any>} */
      const byNumber = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        const n = item?.securitiesAccount?.accountNumber;
        if (n !== undefined && n !== null) byNumber.set(String(n), item);
      }
      /** @type {import("../mapping.mjs").AccountSummary[]} */
      const summaries = [];
      /** @type {import("../mapping.mjs").Position[]} */
      const positions = [];
      /** @type {Array<{ connectionId: string, message: string }>} */
      const errors = [];
      for (const account of accounts) {
        const item = byNumber.get(account.external_id);
        if (!item) {
          errors.push({ connectionId: conn.id, message: SCHWAB_DETAIL.missingAccount(account.display_number) });
          continue;
        }
        summaries.push(schwabAccountSummary(item, account));
        for (const p of Array.isArray(item.securitiesAccount?.positions) ? item.securitiesAccount.positions : []) {
          const pos = schwabPosition(p, account);
          if (pos.qty !== 0) positions.push(pos);
        }
      }
      await touch(conn);
      return { accounts: summaries, positions, errors };
    },

    async orders(conn, accounts) {
      const t = now();
      const lists = await Promise.all(accounts.map((a) => rawOrders(conn, a, t)));
      await touch(conn);
      return lists.flatMap((list, i) => (list ? schwabOrders(list, accounts[i], t) : []));
    },

    async executions(conn, accounts) {
      const t = now();
      const per = await Promise.all(
        accounts.map(async (account) => {
          const orders = await rawOrders(conn, account, t);
          if (!orders) return [];
          // Commission comes from the booked TRADE transactions. Without them (not booked yet, or
          // the call failed) the fills are still shown, marked provisional.
          const transactions = await withHash(conn, account, (hash) => withAuth(conn, (auth) => client.transactions(auth, hash, t - SCHWAB_HISTORY_MS, t))).catch((e) => {
            if (e instanceof SessionExpiredError) throw e;
            log.info("schwab transactions not available; fills are provisional", { connectionId: conn.id, error: e });
            return null;
          });
          return schwabExecutions(orders, transactions, account, t);
        }),
      );
      await touch(conn);
      return per.flat();
    },

    // No revoke: Schwab publishes no token revocation for these apps. Disconnect deletes the sealed
    // App Secret and tokens; the user can delete the app on developer.schwab.com.

    forget(id) {
      hashReads.delete(id);
      hashInflight.delete(id);
      lastOkWrite.delete(id);
    },
  };
  return adapter;
}
