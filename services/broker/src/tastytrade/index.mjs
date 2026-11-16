import { badGateway, badRequest, BrokerAuthError, HttpError, SessionExpiredError, unavailable } from "../errors.mjs";
import { etDateKey, iso } from "../time.mjs";
import { createTastytradeClient, TASTYTRADE_SCOPE, TASTYTRADE_TOKEN_PATH, tastytradeHosts } from "./client.mjs";
import {
  markOf,
  mergeOrders,
  tastytradeAccountRows,
  tastytradeAccountsRef,
  tastytradeAccountSummary,
  tastytradeCustomerRef,
  tastytradeExecutions,
  tastytradeOrders,
  tastytradePosition,
  tastytradeTokenError,
} from "./mapping.mjs";

/**
 * tastytrade (tastytrade_oauth), read only (docs/real-backend.md, sections 8 to 11).
 *
 * One client, "platform": TASTYTRADE_CLIENT_ID and TASTYTRADE_CLIENT_SECRET in the service env.
 * - Until tastytrade's trusted third party verification passes, that client is the owner's personal
 *   OAuth app, which tastytrade restricts to the owner's own account: BROKER_AUDIENCE keeps
 *   tastytrade_oauth to the superadmin (the default). Without the two variables the method is "not
 *   configured" for everyone (src/registry.mjs). Once tastytrade verifies Nasscord the owner swaps
 *   in the verified client and opens it with tastytrade_oauth=all.
 * - The redirect URI registered on the app: https://nasscord.com/api/broker/callback/tastytrade.
 * - Users need two-factor authentication on at tastytrade, or the "read" consent fails.
 *
 * Environments: production only for users. TASTYTRADE_ENV=cert points the method at tastytrade's
 * cert sandbox (simulated, reset daily: sample data) for developers; the config refuses it in
 * production, the registry drops "sandbox" there, and tastytradeHosts() refuses cert hosts there.
 * The cert and production apps are separate tastytrade apps with separate credentials, so this
 * server's client serves only the environment TASTYTRADE_ENV names; a connection of the other one
 * is answered "not set up" and never sent to a token endpoint with the wrong app. tastytrade has no
 * paper account on its API, so nothing here is labelled Paper.
 *
 * Sessions: the access token is a 15-minute JWT, refreshed lazily when under 2 minutes are left
 * (POST /oauth/token, JSON body with the client secret). The refresh token never expires and never
 * rotates, so session_expires_at stays null and the sealed refresh token is the whole login: it is
 * AES-GCM at rest (src/secrets.mjs) and never logged. Only the token endpoint ends a login: a
 * refused refresh means the user deleted the grant at my.tastytrade.com, and the engine expires the
 * connection with "tastytrade access was removed. Reconnect to continue." A read that tastytrade
 * refuses (401) gets one refresh and one retry; when the new token is refused too, the grant is
 * still alive (the refresh just worked), so the read fails, the tokens stay, and that token is not
 * refreshed again for a read (one refresh per 15-minute token, however many reads fail). Too many
 * failed logins block the service IP at tastytrade for about 8 hours, so the token endpoint has a
 * stricter circuit breaker (3 failures in 10 minutes pause token calls for 30 minutes) and a refused
 * refresh never repeats (tastytradeTokenError).
 *
 * The login's identity (external_ref): tastytrade's customer reference from GET /customers/me
 * (`external-id`; the API answers "me" as the id). Nothing else of that answer is kept: names,
 * the masked tax number and the birth date are never stored or logged. Data stays per user: every
 * read uses the connection's own token, and nothing read for one user is shared with another.
 *
 * Reads: balances, positions with marks (include-marks=true), orders (/orders/live, which holds
 * today's orders and every older order still working, plus the 30-day search, merged by id;
 * start-date is always sent), and Trade transactions for executions (there is no executions
 * endpoint). One account's 404 or 403 does not hide the others: portfolio() names it in `errors`,
 * orders() and executions() leave it out and log it (their contract has no errors list); only when
 * every account fails does the read fail. A list cut at its page cap is logged. No revoke: tastytrade
 * publishes no token revocation for third parties; Disconnect deletes the sealed tokens and the
 * dialog tells the user to delete the grant under Manage > My Profile > API.
 *
 * Nothing here logs a token, code, account number, name or query string.
 */

/** Sentences on the connection (status_detail) and in read errors. */
export const TASTYTRADE_DETAIL = Object.freeze({
  removed: "tastytrade access was removed. Reconnect to continue.",
  noAccounts: "This tastytrade login has no open account to connect.",
  /** @param {"production" | "sandbox"} environment */
  otherApp: (environment) =>
    environment === "sandbox"
      ? "This tastytrade connection was made with tastytrade's sandbox app (sample data), which this server is not set up for. Disconnect it."
      : "This tastytrade connection was made with tastytrade's live app, which this server is not set up for right now. Try again later.",
  /** @param {string} what @param {string} display */
  accountRead: (what, display) => `tastytrade did not send the ${what} of account ${display}.`,
  /** @param {string} what */
  refusedFresh: (what) => `tastytrade refused the ${what} even with a new access token (401). Try again in a few minutes.`,
  /** @param {string[]} symbols */
  noMark: (symbols) =>
    `tastytrade sent no current price for ${symbols.slice(0, 5).join(", ")}${symbols.length > 5 ? ` and ${symbols.length - 5} more` : ""}, so yesterday's close is shown for ${symbols.length === 1 ? "it" : "them"}.`,
});

/** The access token's life when tastytrade's answer does not say (it says 900 seconds). */
export const TASTYTRADE_ACCESS_MS = 15 * 60_000;
/** Order and trade history read per account. */
export const TASTYTRADE_HISTORY_DAYS = 30;
/** Token endpoint breaker: stricter than the engine's default (tastytrade blocks the IP for ~8 h). */
export const TASTYTRADE_CIRCUIT = Object.freeze({ failures: 3, windowMs: 10 * 60_000, openMs: 30 * 60_000 });
/** last_ok_at is written at most this often per connection. */
const OK_WRITE_MS = 60_000;

const READ_TTL = Object.freeze({ portfolio: 15_000, orders: 30_000, executions: 60_000 });

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("../db.mjs").Environment} Environment
 * @typedef {import("../oauth2.mjs").OAuthProfile} OAuthProfile
 * @typedef {import("../oauth2.mjs").OAuthSecret} OAuthSecret
 * @typedef {import("./client.mjs").TastytradeAuth} TastytradeAuth
 * @typedef {{ connectionId: string, message: string }} PartialError
 */

/** "2026-11-16" -> "2026-10-17" (calendar arithmetic on the New York date). @param {string} key @param {number} days */
function shiftDate(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Settles a promise into { ok, value } or { ok: false, error }. @template T @param {Promise<T>} p */
const settle = (p) =>
  p.then(
    (value) => /** @type {{ ok: true, value: T }} */ ({ ok: true, value }),
    (error) => /** @type {{ ok: false, error: unknown }} */ ({ ok: false, error }),
  );

/** A failure of one account's read that should not hide the other accounts. @param {unknown} e */
const accountScoped = (e) => e instanceof HttpError && (e.code === "broker_http" || e.code === "broker_forbidden");

/** @type {import("../adapter-types.mjs").AdapterFactory} */
export function createAdapter(deps) {
  const { config, store, oauth2, locks, log, now } = deps;
  const settings = config.brokers.tastytrade;
  /** The one environment this server's client serves. @type {Environment} */
  const served = settings.env === "cert" ? "sandbox" : "production";
  const platform = settings.clientId && settings.clientSecret ? { clientId: settings.clientId, clientSecret: settings.clientSecret } : null;
  const userAgent = `nasscord/${config.version}`;
  const versionHeaders = () => ({ "user-agent": userAgent, "accept-version": settings.apiVersion });
  /** @type {Map<string, ReturnType<typeof createTastytradeClient>>} one read client per environment */
  const clients = new Map();
  /** @type {Map<string, number>} last last_ok_at write per connection */
  const lastOkWrite = new Map();
  /** @type {Map<string, Promise<string>>} a token request in flight per connection */
  const tokenInflight = new Map();
  /** @type {Map<string, string>} per connection: a just-refreshed token tastytrade still refused (never refreshed again for a read) */
  const refusedFresh = new Map();

  /** @param {Environment} environment */
  const hostsOf = (environment) => tastytradeHosts(deps.urls, config.production, environment === "sandbox" ? "cert" : "production");

  /** @param {Environment} environment */
  function clientOf(environment) {
    let c = clients.get(environment);
    if (!c) {
      c = createTastytradeClient({ http: deps.http, base: hostsOf(environment).api, userAgent, apiVersion: settings.apiVersion });
      clients.set(environment, c);
    }
    return c;
  }

  /**
   * @param {Environment} environment
   * @returns {OAuthProfile}
   */
  function profileOf(environment) {
    const hosts = hostsOf(environment);
    return {
      brokerId: "tastytrade",
      name: "tastytrade",
      authorizeUrl: hosts.authorize,
      tokenUrl: `${hosts.api}${TASTYTRADE_TOKEN_PATH}`,
      clientAuth: "json",
      sendRedirectUri: true,
      scope: TASTYTRADE_SCOPE,
      pkce: false,
      // The app of the other environment is a different tastytrade app: never sent there.
      platformClient: environment === served ? platform : null,
      tokenHeaders: versionHeaders,
      refresh: { kind: "fixed", hardExpiryMs: null, accessFallbackMs: TASTYTRADE_ACCESS_MS },
      expiredDetail: TASTYTRADE_DETAIL.removed,
      tokenRatePerSec: 1,
      circuit: TASTYTRADE_CIRCUIT,
      parseTokenError: tastytradeTokenError,
    };
  }

  /** @param {ConnectionRow} conn */
  const bucketOf = (conn) => `tastytrade:${conn.id}`;

  /**
   * A bearer token for an active connection of the environment this server serves (the engine
   * refreshes it lazily under the token lock and saves it before use). Calls that start together
   * (balances and positions of every account) share one token request, so a failing token endpoint
   * costs one failed call per read, not one per account and endpoint: repeated failed logins are
   * what gets the service IP blocked at tastytrade.
   * @param {ConnectionRow} conn
   * @param {string | null} [refused] a token tastytrade just refused (marked stale): a shared request
   *   that started before the mark and answers it again is not reused
   * @returns {Promise<TastytradeAuth>}
   */
  async function bearer(conn, refused = null) {
    if (conn.environment !== served) throw unavailable(TASTYTRADE_DETAIL.otherApp(conn.environment === "sandbox" ? "sandbox" : "production"), "tastytrade_other_app");
    const profile = profileOf(conn.environment);
    let pending = tokenInflight.get(conn.id);
    if (!pending) {
      pending = oauth2.accessToken(conn, profile).finally(() => tokenInflight.delete(conn.id));
      tokenInflight.set(conn.id, pending);
    }
    let token = await pending;
    if (refused && token === refused) token = await oauth2.accessToken(conn, profile);
    return { token, bucket: bucketOf(conn) };
  }

  /**
   * tastytrade refused a token Nasscord still thought valid: mark it stale (under the engine's token
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
   * A 403 is about this read (the scope, the account's authority), not the login.
   * @param {unknown} e @param {string} what
   */
  const forbiddenRead = (e, what) =>
    e instanceof BrokerAuthError && e.brokerStatus === 403 ? new HttpError(502, `tastytrade refused to send the ${what} (403).`, { code: "broker_forbidden" }) : e;

  /**
   * A read refused with a token the token endpoint had just issued. Not account-scoped: it is about
   * the whole login, so portfolio() answers it once for the connection.
   * @param {string} what
   */
  const refusedRead = (what) => badGateway(TASTYTRADE_DETAIL.refusedFresh(what), "tastytrade_refused");

  /**
   * Runs a read with a bearer token. A 401 gets one refresh and one retry. Only the token endpoint
   * ends the login: a refused refresh (a deleted grant) is expired by the engine. A refresh that
   * works proves the grant is alive, so a 401 on its new token is a read error that keeps the
   * tokens (a fleet-wide cause, such as a new User-Agent rule, must not wipe every grant), and that
   * token is not refreshed again: later reads try it once and fail the same way until it works or
   * runs out (15 minutes). The refresh itself is refused at most once per connection, so this never
   * loops on the token endpoint.
   * @template T
   * @param {ConnectionRow} conn
   * @param {string} what for the sentence ("balances")
   * @param {(auth: TastytradeAuth) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withAuth(conn, what, fn) {
    const auth = await bearer(conn);
    try {
      const out = await fn(auth);
      await worked(conn, auth.token);
      return out;
    } catch (e) {
      if (!(e instanceof BrokerAuthError && e.brokerStatus === 401)) throw forbiddenRead(e, what);
    }
    if (refusedFresh.get(conn.id) === auth.token) throw refusedRead(what);
    await markStale(conn, auth.token);
    const again = await bearer(conn, auth.token);
    try {
      const out = await fn(again);
      await worked(conn, again.token);
      return out;
    } catch (e) {
      if (e instanceof BrokerAuthError && e.brokerStatus === 401) {
        if (refusedFresh.get(conn.id) !== again.token) log.warn("tastytrade refused a just-refreshed token; tokens kept", { connectionId: conn.id });
        refusedFresh.set(conn.id, again.token);
        throw refusedRead(what);
      }
      throw forbiddenRead(e, what);
    }
  }

  /** A read worked with `token`. @param {ConnectionRow} conn @param {string} token */
  async function worked(conn, token) {
    if (refusedFresh.get(conn.id) === token) refusedFresh.delete(conn.id);
    await touch(conn);
  }

  /** last_ok_at after a read that worked, at most once a minute. @param {ConnectionRow} conn */
  async function touch(conn) {
    const t = now();
    if (t - (lastOkWrite.get(conn.id) ?? 0) < OK_WRITE_MS) return;
    lastOkWrite.set(conn.id, t);
    await store.updateConnectionIf(conn.id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /** The open accounts of the connection's login. @param {ConnectionRow} conn */
  async function listAccounts(conn) {
    const items = await withAuth(conn, "account list", (auth) => clientOf(conn.environment).accounts(auth));
    return tastytradeAccountRows(items);
  }

  /**
   * Balances and positions of every account. One account's refusal is an error entry and the
   * others still show; positions without a current mark are shown at yesterday's close and named.
   * @param {ConnectionRow} conn @param {AccountRow[]} accounts
   */
  async function portfolio(conn, accounts) {
    const client = clientOf(conn.environment);
    /** @type {PartialError[]} */
    const errors = [];
    const reads = await Promise.all(
      accounts.map(async (account) => {
        const [b, p] = await Promise.all([
          settle(withAuth(conn, "balances", (auth) => client.balances(auth, account.external_id))),
          settle(withAuth(conn, "positions", (auth) => client.positions(auth, account.external_id))),
        ]);
        for (const r of [b, p]) if (!r.ok && !accountScoped(r.error)) throw r.error;
        return { account, b, p };
      }),
    );
    /** @type {import("../mapping.mjs").AccountSummary[]} */
    const summaries = [];
    /** @type {import("../mapping.mjs").Position[]} */
    const positions = [];
    /** @type {Set<string>} */
    const unmarked = new Set();
    for (const { account, b, p } of reads) {
      if (b.ok && b.value) summaries.push(tastytradeAccountSummary(b.value, account));
      else errors.push({ connectionId: conn.id, message: TASTYTRADE_DETAIL.accountRead("balances", account.display_number) });
      if (!p.ok) {
        errors.push({ connectionId: conn.id, message: TASTYTRADE_DETAIL.accountRead("positions", account.display_number) });
        continue;
      }
      for (const raw of p.value) {
        const pos = tastytradePosition(raw, account);
        if (pos.qty === 0 || !pos.symbol) continue;
        if (markOf(raw) === undefined) unmarked.add(pos.symbol);
        positions.push(pos);
      }
    }
    if (unmarked.size > 0) errors.push({ connectionId: conn.id, message: TASTYTRADE_DETAIL.noMark([...unmarked]) });
    return { accounts: summaries, positions, errors };
  }

  /**
   * One read per account. An account-scoped failure (404, 403) leaves that account out and the
   * others still show; any other failure, or every account failing, fails the read. The adapter
   * contract gives orders and executions no errors list, so a left-out account and a list cut at
   * its page cap are logged (never the account number); portfolio() names the account to the user.
   * @template T
   * @param {ConnectionRow} conn @param {AccountRow[]} accounts
   * @param {"orders" | "trades"} what
   * @param {(account: AccountRow) => Promise<{ rows: T[], truncated: boolean }>} read
   * @returns {Promise<T[]>}
   */
  async function perAccount(conn, accounts, what, read) {
    const settled = await Promise.all(accounts.map((account) => settle(read(account))));
    /** @type {T[]} */
    const out = [];
    /** @type {unknown} */
    let firstScoped = null;
    let leftOut = 0;
    let cut = 0;
    for (const r of settled) {
      if (r.ok) {
        out.push(...r.value.rows);
        if (r.value.truncated) cut += 1;
        continue;
      }
      if (!accountScoped(r.error)) throw r.error;
      firstScoped ??= r.error;
      leftOut += 1;
    }
    if (accounts.length > 0 && leftOut === accounts.length) throw firstScoped;
    if (leftOut > 0) log.info(`tastytrade ${what} read in part`, { connectionId: conn.id, accountsLeftOut: leftOut });
    if (cut > 0) log.info(`tastytrade ${what} cut at the page cap; the oldest are not shown`, { connectionId: conn.id, accountsCut: cut });
    return out;
  }

  /**
   * Orders of every account: /orders/live (today's orders in any status, plus every older order
   * still working, such as a GTC placed months ago) and the last 30 days, merged by id.
   * @param {ConnectionRow} conn @param {AccountRow[]} accounts
   */
  async function orders(conn, accounts) {
    const client = clientOf(conn.environment);
    const t = now();
    const recent = shiftDate(etDateKey(t), -TASTYTRADE_HISTORY_DAYS);
    return perAccount(conn, accounts, "orders", async (account) => {
      const n = account.external_id;
      const [live, searched] = await Promise.all([
        withAuth(conn, "orders", (auth) => client.liveOrders(auth, n)),
        withAuth(conn, "orders", (auth) => client.searchOrders(auth, n, recent)),
      ]);
      return { rows: tastytradeOrders(mergeOrders(live.items, searched.items), account, t), truncated: live.truncated || searched.truncated };
    });
  }

  /** Trade transactions of the last 30 days. @param {ConnectionRow} conn @param {AccountRow[]} accounts */
  async function executions(conn, accounts) {
    const client = clientOf(conn.environment);
    const t = now();
    const start = shiftDate(etDateKey(t), -TASTYTRADE_HISTORY_DAYS);
    return perAccount(conn, accounts, "trades", async (account) => {
      const list = await withAuth(conn, "trades", (auth) => client.trades(auth, account.external_id, start));
      return { rows: tastytradeExecutions(list.items, account, t), truncated: list.truncated };
    });
  }

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const adapter = {
    descriptor: {
      method: "tastytrade_oauth",
      brokers: ["tastytrade"],
      name: "tastytrade",
      // Production for users; "sandbox" is the cert environment, developers only (never in production).
      environments: ["production", "sandbox"],
      readTtlMs: READ_TTL,
      lazyAccounts: false,
      // The login does not end on its own: nothing to sweep.
      sweepEveryMs: null,
      clients: ["platform"],
    },

    // Only the environment whose app this server holds; the registry drops sandbox in production.
    environmentsFor: (c) => [c.brokers.tastytrade.env === "cert" ? "sandbox" : "production"],

    configured: (client) => (client === "platform" ? null : "tastytrade logins use Nasscord's own OAuth client only"),

    oauthProfile: (environment) => profileOf(environment),

    /**
     * After the code exchange (canonical host; the connection may still be pending): the customer
     * reference names the login, and a login without an open account is refused.
     */
    async identify(conn, tokens) {
      const client = clientOf(conn.environment);
      const auth = { token: tokens.accessToken, bucket: bucketOf(conn) };
      const [customer, items] = await Promise.all([client.customer(auth), client.accounts(auth)]);
      const accounts = tastytradeAccountRows(items);
      if (accounts.length === 0) throw badRequest(TASTYTRADE_DETAIL.noAccounts, "tastytrade_no_accounts");
      const ref = tastytradeCustomerRef(customer) ?? tastytradeAccountsRef(accounts.map((a) => a.external_id));
      if (!ref) throw new Error("tastytrade identify: no customer reference and no account to name the login with");
      return { externalRef: ref, scope: tokens.scope ?? TASTYTRADE_SCOPE };
    },

    listAccounts,
    portfolio,
    orders,
    executions,

    /**
     * Renew and Reconnect (flows.genericRenew): does the grant still work? The account list is read
     * with a fresh token; a deleted grant is "expired" and Reconnect starts a new login.
     */
    async refresh(conn) {
      try {
        await withAuth(conn, "account list", (auth) => clientOf(conn.environment).accounts(auth));
        return "ok";
      } catch (e) {
        if (e instanceof SessionExpiredError) return "expired";
        throw e;
      }
    },

    // No revoke: tastytrade publishes no token revocation for third parties. Disconnect deletes the
    // sealed tokens; the user deletes the grant at my.tastytrade.com (Manage > My Profile > API).

    forget(id) {
      lastOkWrite.delete(id);
      tokenInflight.delete(id);
      refusedFresh.delete(id);
      for (const c of clients.values()) c.drop(`tastytrade:${id}`);
    },
  };
  return adapter;
}
