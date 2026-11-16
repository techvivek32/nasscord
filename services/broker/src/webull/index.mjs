import { badGateway, badRequest, BrokerAuthError, conflict, HttpError, SessionExpiredError, unavailable } from "../errors.mjs";
import { createWindowCounter } from "../limits.mjs";
import { loginRef, OAuthTokenError } from "../oauth2.mjs";
import { iso, parseTime } from "../time.mjs";
import { createWebullClient, webullBase, WEBULL_OAUTH_PATHS, WEBULL_VERSIONS } from "./client.mjs";
import { mergeOrderGroups, webullAccountRows, webullAccountSummary, webullExecutions, webullOrders, webullPositions } from "./mapping.mjs";
import { signRequest } from "./signer.mjs";

/**
 * Webull Connect (webull_oauth), read only (docs/real-backend.md, "Connect flows").
 *
 * Webull's Connect API is its route for third-party platforms: Nasscord's own OAuth client
 * (client "platform", flow oauth2_platform) once Webull approves Nasscord's application and its
 * sandbox testing. Until WEBULL_CLIENT_ID, WEBULL_CLIENT_SECRET, WEBULL_APP_KEY and
 * WEBULL_APP_SECRET exist the method is "not configured", and BROKER_AUDIENCE keeps it to the
 * platform owner (webull_oauth=superadmin) until the owner opens it. Until then Webull users connect
 * through SnapTrade. The individual Trading API key is never offered (Webull designates it for
 * natural persons and it always carries trading).
 *
 * - Environments: WEBULL_ENV picks Webull's service for this server. "production" is the user's own
 *   live account. "sandbox" is Webull's test data for the testing Webull requires before go-live:
 *   developers only (config refuses it in production, and so does every profile here), labelled
 *   "Sandbox · sample data" in the app.
 * - Login: Webull's authorize endpoint (/oauth2/auth-codes/get) sends the user to the sign-in on
 *   passport.webull.com, then back to Nasscord's one callback
 *   (OAUTH_CALLBACK_BASE/api/broker/callback/webull, on Webull's redirect whitelist). The code lives
 *   60 seconds and works once; the canonical callback exchanges it at once.
 * - Token calls: form body with client_id and client_secret, signed with the app key and secret
 *   (signer.mjs, x-version v2). The App Secret is only the HMAC key and is never sent. Webull
 *   documents three refusals: 401 UNAUTHORIZED, 417 INVALID_PARAMETER and 500 SYSTEM_ERROR. A 417
 *   ends that one login (a dead refresh token or code); a 401 is Nasscord's request (signature,
 *   app key, client) and never ends a user's login: the connection waits 5 minutes before its next
 *   try, and 3 refusals in 10 minutes pause every Webull token call for 10 minutes, because
 *   repeated failed calls can get the service's IP blocked (webullTokenError).
 * - Tokens: the access token lives 30 minutes and is refreshed lazily (src/oauth2.mjs, lock
 *   "token:<id>"). The refresh token lives 15 days (rt_expires_in) and Webull issues a new one on
 *   every refresh: the new one is saved to broker_secrets before the new access token is used.
 * - The 15 days (critique A2): Webull does not say whether they count from the user's approval or
 *   restart with each refresh. Until Webull confirms, Nasscord treats them as fixed
 *   (WEBULL_REFRESH_MODE "fixed"): the login ends 15 days after the approval, session_expires_at
 *   is that date (the app shows "Reconnect by <date>"), every refresh keeps it, and the scheduler
 *   expires the connection at the mark: "Webull asks you to approve Nasscord again every 15 days.
 *   Reconnect to continue." If Webull confirms the period restarts, mode "sliding" moves the end
 *   with every refresh and the sweep refreshes a login with under 5 days left, so it never lapses.
 * - Identity: external_ref is Webull's identity_id from the token answer.
 * - Reads: each product has its own account_id; every endpoint is read one account after another
 *   (Webull allows 2 calls per 2 seconds per endpoint) with balances and positions, and open and
 *   historical orders, in parallel. Orders: open orders plus 30 days of history. Executions: fills
 *   from those orders, with commissions from TRADE cash activities (read per calendar year, on
 *   their own faster bucket, at the same time as the orders).
 * - Time: the app gives a whole /v1 read 8 seconds, for every broker of the workspace. A Webull read
 *   answers within WEBULL_READ_BUDGET_MS (6 s); a read still running then goes on in the background
 *   and lands in the cache, and this answer is "Webull is taking longer than usual", so a slow
 *   Webull never blanks the other brokers.
 * - Refusals: a 401 or 403 on some accounts while others read fine is those accounts (Webull applies
 *   the Connect app's permissions per product account): an entry for each in the portfolio, and for
 *   orders and fills, which have no per-account error channel, an error for the whole login that
 *   names the account rather than a list that silently lacks it. A login ends only when Webull
 *   refuses everything, then the account list itself, with a token it has just issued.
 * - Disconnect deletes the tokens. Webull publishes no token revocation for Connect; the user can
 *   remove Nasscord in Webull.
 *
 * Nothing here logs a token, code, key, account number or query string.
 */

/** Sentences on the connection (status_detail) and in read errors. */
export const WEBULL_DETAIL = Object.freeze({
  period: "Webull asks you to approve Nasscord again every 15 days. Reconnect to continue.",
  ended: "Webull no longer accepts Nasscord's access. Reconnect to continue.",
  noAccounts: "Webull shared no accounts with Nasscord. Start again and approve your account on Webull's page.",
  sandboxRefused: "Webull's sandbox holds sample data, which this server does not serve. Connect your own Webull account.",
  /** @param {"production" | "sandbox"} env the connection's @param {"production" | "sandbox"} server this server's */
  otherService: (env, server) =>
    `This Webull connection was made with Webull's ${env === "sandbox" ? "sandbox" : "live"} service, and this server is set up for its ${server === "sandbox" ? "sandbox" : "live"} service. Disconnect it and connect again.`,
  /** @param {string} what @param {Account} a */
  accountRead: (what, a) => `Webull did not send the ${what} of ${a.label} (${a.display_number}). Try again in a moment.`,
  /** @param {string} what @param {Account} a */
  accountRefused: (what, a) => `Webull refused to send the ${what} of ${a.label} (${a.display_number}). If it keeps refusing, exclude that account on the Brokers page.`,
  /** @param {Account} a */
  ordersMissing: (a) => `Webull did not send the orders of ${a.label} (${a.display_number}), so this login's orders and fills are not shown. Try again in a moment.`,
  /** @param {Account} a */
  ordersRefused: (a) => `Webull refused to send the orders of ${a.label} (${a.display_number}). Exclude that account on the Brokers page to see this login's other orders and fills.`,
  /** @param {string} what */
  slow: (what) => `Webull is taking longer than usual to send your ${what}. They appear on the next update.`,
  tokenRefused: "Webull refused Nasscord's request to renew this login. Nasscord tries again in a few minutes; if you removed Nasscord in Webull, reconnect.",
  paused: "Nasscord paused Webull sign-ins for a few minutes after Webull refused its requests. Try again later.",
});
/** @typedef {{ label: string, display_number: string }} Account */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The refresh token's documented life, from the approval. */
export const WEBULL_REFRESH_MS = 15 * DAY;
const ACCESS_MS = 30 * MINUTE;
/** A refused refresh this close to the 15-day end is the period running out, not a revoked grant. */
const NEAR_END_MS = 60 * MINUTE;
/** Sliding mode: the sweep refreshes a login whose refresh token has less than this left. */
export const WEBULL_KEEPALIVE_MS = 5 * DAY;
/** Orders and fills are read this far back. */
export const WEBULL_HISTORY_MS = 30 * DAY;
/** Raw reads (balances and positions, orders, cash activities) are reused for this long. */
const RAW_TTL_MS = 30_000;
/**
 * How long a read waits for Webull before answering "taking longer than usual". The app's call to
 * the service lasts 8 seconds for every broker of the workspace; this leaves room for the rest.
 */
export const WEBULL_READ_BUDGET_MS = 6_000;
/** After Webull refused a connection's refresh with 401, that connection waits this long to try again. */
const REFUSED_COOLDOWN_MS = 5 * MINUTE;
/** 401s at the token endpoint that pause every Webull token call, in what window, for how long. */
const REFUSAL_PAUSE = Object.freeze({ failures: 3, windowMs: 10 * MINUTE, pauseMs: 10 * MINUTE });
const LAST_OK_EVERY_MS = MINUTE;
/** The only scope Webull documents (user, trade, write and read); Nasscord reads only, whatever it holds. */
export const WEBULL_DEFAULT_SCOPE = "user:trade:wr";

/**
 * "fixed": the 15 days count from the approval (the default until Webull says otherwise);
 * "sliding": each refresh starts a new 15 days.
 * @typedef {"fixed" | "sliding"} WebullRefreshMode
 */
/** @type {WebullRefreshMode} */
export const WEBULL_REFRESH_MODE = "fixed";

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("../db.mjs").Environment} Environment
 * @typedef {import("../oauth2.mjs").OAuthProfile} OAuthProfile
 * @typedef {import("../oauth2.mjs").OAuthSecret} OAuthSecret
 * @typedef {import("./client.mjs").WebullClient} WebullClient
 */

/**
 * Webull's token endpoint refusals as the OAuth engine acts on them, for a refresh. Webull answers
 * { error_code, message } and documents three (developer.webull.com/apis/docs/reference/connect-api/
 * create-and-refresh-token): 401 UNAUTHORIZED, 417 INVALID_PARAMETER and 500 SYSTEM_ERROR. Classified
 * by status and code, never by the message:
 * - a code that names the signature, timestamp, nonce, app key or client, or any other 401: "other".
 *   It is Nasscord's request, never one user's grant, so no connection is expired for it (the
 *   adapter counts it toward its own pause of Webull token calls; the engine counts only
 *   invalid_client).
 * - a code that names the grant, the refresh token or the code, or a 417 (a refused parameter: on a
 *   refresh the refresh token, on an exchange the code): invalid_grant (that user logs in again).
 * - anything else (500 SYSTEM_ERROR, a 2xx without a token): "other".
 * The code exchange maps a 401 to invalid_client instead ("Webull did not accept Nasscord's app").
 * TODO(webull-sandbox): confirm the codes during the sandbox testing; until then the adapter logs
 * each refusal's status and error_code (never its message or body).
 * @param {number} status
 * @param {any} json
 * @returns {"invalid_grant" | "invalid_client" | "other"}
 */
export function webullTokenError(status, json) {
  const code = String(json?.error_code ?? json?.error ?? json?.code ?? "").toUpperCase();
  if (/SIGN|NONCE|TIMESTAMP|APP_KEY|APP_SECRET|CLIENT/.test(code)) return "other";
  if (/INVALID_GRANT|REFRESH_TOKEN|AUTH_CODE|AUTHORIZATION_CODE/.test(code)) return "invalid_grant";
  if (status === 417) return "invalid_grant";
  return "other";
}

/** A refusal's error_code as it may go into a log line: Webull's codes are capitals and underscores. @param {any} json */
const loggableCode = (json) => {
  const c = String(json?.error_code ?? json?.error ?? "");
  return /^[A-Z_]{1,40}$/.test(c) ? c : c ? "unreadable" : "none";
};

/** What byDeadline answers when the read is still running. */
const LATE = Symbol("late");

/**
 * When the login behind a secret ends (the stored refresh end, or 15 days after the approval when
 * Webull sent none). Null without a refresh token.
 * @param {OAuthSecret | null | undefined} s
 * @returns {number | null}
 */
export function webullDeadline(s) {
  if (!s?.refreshToken) return null;
  const stored = parseTime(s.refreshExpiresAt);
  if (stored !== null) return stored;
  const issued = parseTime(s.refreshIssuedAt);
  return issued === null ? null : issued + WEBULL_REFRESH_MS;
}

/**
 * @param {import("../adapter-types.mjs").AdapterDeps} deps
 * @param {{ refreshMode?: WebullRefreshMode, signReads?: boolean, readBudgetMs?: number }} [opts]
 *   refreshMode: see WEBULL_REFRESH_MODE. signReads: HMAC-sign every read too (the TODO in
 *   client.mjs); off until Webull says resource calls must be signed. readBudgetMs: see
 *   WEBULL_READ_BUDGET_MS (tests shorten it).
 * @returns {import("../adapter-types.mjs").BrokerAdapter}
 */
export function createWebullAdapter(deps, opts = {}) {
  const { config, store, oauth2, locks, cache, log, now } = deps;
  const wb = config.brokers.webull;
  const mode = opts.refreshMode ?? WEBULL_REFRESH_MODE;
  const readBudgetMs = opts.readBudgetMs ?? WEBULL_READ_BUDGET_MS;
  /** The environment this server's Webull credentials belong to. Never sandbox in production. */
  /** @type {"production" | "sandbox"} */
  const serverEnv = !config.production && wb.env === "sandbox" ? "sandbox" : "production";
  const platform = wb.clientId && wb.clientSecret ? { clientId: wb.clientId, clientSecret: wb.clientSecret } : null;
  const signing = wb.appKey && wb.appSecret ? { appKey: wb.appKey, appSecret: wb.appSecret } : null;
  // WEBULL_SCOPE is not a config variable yet; the scope comes with Webull's approval (client.mjs).
  const configuredScope = /** @type {{ scope?: unknown }} */ (wb).scope;
  const scope = typeof configuredScope === "string" && /^[\w:. -]{1,200}$/.test(configuredScope) ? configuredScope : WEBULL_DEFAULT_SCOPE;
  const budget = createWindowCounter({ now });
  /** @type {Map<string, number>} last last_ok_at write per connection */
  const lastOkWrite = new Map();
  /** Webull's 401s at the token endpoint (Nasscord's request): their times, and the pause they set. */
  const refusals = { at: /** @type {number[]} */ ([]), pausedUntil: 0 };
  /** @type {Map<string, number>} connection id -> when Webull last answered its refresh with 401 */
  const refusedRefresh = new Map();

  /**
   * The environment's API base, after the sample-data and server checks.
   * @param {Environment} environment
   */
  function baseFor(environment) {
    if (environment === "sandbox" && config.production) throw badRequest(WEBULL_DETAIL.sandboxRefused, "sandbox_refused");
    if (environment !== "production" && environment !== "sandbox") throw badRequest("Webull has no paper environment Nasscord can connect. Connect your Webull account.", "bad_environment");
    if (environment !== serverEnv) throw conflict(WEBULL_DETAIL.otherService(environment, serverEnv), "other_service");
    return webullBase(deps.urls, config.production, environment);
  }

  /**
   * Before every token call: no call while Webull's 401s have paused them, and none for a
   * connection whose refresh Webull refused with 401 a few minutes ago.
   * @param {string | null} connectionId the refreshing connection; null for a code exchange
   */
  function checkRefusals(connectionId) {
    const t = now();
    if (refusals.pausedUntil > t) throw unavailable(WEBULL_DETAIL.paused, "circuit_open");
    const last = connectionId ? refusedRefresh.get(connectionId) : undefined;
    if (last !== undefined && t - last < REFUSED_COOLDOWN_MS) throw unavailable(WEBULL_DETAIL.tokenRefused, "webull_token_refused");
  }

  /**
   * A 401 at the token endpoint. One connection adds at most 2 in a window (its cooldown), so
   * one user's login never pauses everyone; a broken signature or client soon does.
   * @param {string | null} connectionId
   */
  function noteRefusal(connectionId) {
    const t = now();
    if (connectionId) refusedRefresh.set(connectionId, t);
    refusals.at = [...refusals.at.filter((at) => t - at < REFUSAL_PAUSE.windowMs), t];
    if (refusals.at.length >= REFUSAL_PAUSE.failures) {
      refusals.pausedUntil = t + REFUSAL_PAUSE.pauseMs;
      refusals.at = [];
      log.warn("webull token calls paused after repeated 401s", { minutes: Math.round(REFUSAL_PAUSE.pauseMs / MINUTE) });
    }
  }

  /**
   * @param {Environment} environment
   * @param {string} [expiredDetail]
   * @param {string | null} [connectionId] set for a connection's refresh (bearer); null for the
   *   code exchange, where a 401 is invalid_client (see webullTokenError)
   * @returns {OAuthProfile}
   */
  function profileFor(environment, expiredDetail = WEBULL_DETAIL.ended, connectionId = null) {
    const base = baseFor(environment);
    return {
      brokerId: "webull",
      name: "Webull",
      authorizeUrl: `${base}${WEBULL_OAUTH_PATHS.authorize}`,
      tokenUrl: `${base}${WEBULL_OAUTH_PATHS.token}`,
      clientAuth: "body",
      sendRedirectUri: true,
      scope,
      pkce: false,
      platformClient: platform,
      // Every token call is signed over the exact form body that is sent.
      tokenHeaders: ({ url, body }) => {
        if (!signing) throw unavailable("Webull logins are not set up on this server yet.", "not_configured");
        checkRefusals(connectionId);
        return signRequest({ ...signing, url, body, now: now(), version: WEBULL_VERSIONS.token });
      },
      // "fixed" still saves every new refresh token before use; it only keeps the end where it is.
      refresh: { kind: mode === "sliding" ? "rotating" : "fixed", hardExpiryMs: WEBULL_REFRESH_MS, accessFallbackMs: ACCESS_MS },
      expiredDetail,
      // Repeated failed token calls can get the calling IP blocked: one a second, the engine's
      // circuit breaker, and the 401 pause above.
      tokenRatePerSec: 1,
      parseTokenError: (status, json) => {
        const kind = webullTokenError(status, json);
        log.info("webull token call refused", { status, errorCode: loggableCode(json), kind, grant: connectionId ? "refresh" : "code" });
        if (status === 401) noteRefusal(connectionId);
        return !connectionId && status === 401 && kind === "other" ? "invalid_client" : kind;
      },
    };
  }

  /** @param {ConnectionRow} conn @param {string} detail */
  async function endLogin(conn, detail) {
    lastOkWrite.delete(conn.id);
    await oauth2.expire(conn, detail);
    return new SessionExpiredError(detail, { reauth: "redirect" });
  }

  /**
   * A usable access token: the 15-day end first, then the engine (lazy refresh under the token
   * lock; a rotated refresh token is saved before the new access token is used). A refresh Webull
   * refused with 401 keeps the connection and answers WEBULL_DETAIL.tokenRefused.
   * @param {ConnectionRow} conn
   * @param {{ force?: boolean }} [o] force: refresh now (the sliding-mode keepalive)
   * @returns {Promise<string>}
   */
  async function bearer(conn, o = {}) {
    if (conn.environment === "sandbox" && config.production) throw badRequest(WEBULL_DETAIL.sandboxRefused, "sandbox_refused");
    const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
    const deadline = webullDeadline(s);
    if (conn.status === "active" && deadline !== null && deadline <= now()) throw await endLogin(conn, WEBULL_DETAIL.period);
    const detail = deadline !== null && deadline - now() < NEAR_END_MS ? WEBULL_DETAIL.period : WEBULL_DETAIL.ended;
    const profile = profileFor(conn.environment, detail, conn.id);
    try {
      return await oauth2.accessToken(conn, o.force ? { ...profile, refresh: { ...profile.refresh, refreshBeforeMs: Number.MAX_SAFE_INTEGER } } : profile);
    } catch (e) {
      if (e instanceof OAuthTokenError && e.kind === "other" && e.brokerStatus === 401) throw unavailable(WEBULL_DETAIL.tokenRefused, "webull_token_refused");
      throw e;
    }
  }

  /**
   * Webull refused a token Nasscord still thought valid: mark it stale (under the engine's token
   * lock, and only if no other call has refreshed it already) so the next bearer() refreshes.
   * @param {ConnectionRow} conn @param {string} token
   */
  async function markStale(conn, token) {
    await locks.run(`token:${conn.id}`, async () => {
      const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id, { fresh: true }));
      if (s?.accessToken === token) await oauth2.saveSecret(conn.id, { ...s, accessExpiresAt: iso(0) });
    });
  }

  /** @param {ConnectionRow} conn @param {string} token */
  const clientFor = (conn, token) =>
    createWebullClient({
      http: deps.http,
      base: baseFor(conn.environment),
      token,
      connectionId: conn.id,
      budget,
      signing: opts.signReads ? signing : null,
      now,
      environment: conn.environment === "sandbox" ? "sandbox" : "production",
    });

  /** last_ok_at after a read that worked, at most once a minute. @param {ConnectionRow} conn */
  async function touch(conn) {
    const t = now();
    if (t - (lastOkWrite.get(conn.id) ?? 0) < LAST_OK_EVERY_MS) return;
    lastOkWrite.set(conn.id, t);
    await store.updateConnectionIf(conn.id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /** @param {string} what @param {number} status */
  const refusedRead = (what, status) => badGateway(`Webull refused to send the ${what} of this login (${status}).`, "broker_forbidden");

  /**
   * Runs a read with the connection's token. A 401 gets one refresh and one more try. Refused again
   * with the token Webull just issued, the login is over (expired, Reconnect) only when Webull
   * refuses the account list too; otherwise it is that read refused. A 403 is that read refused,
   * never the login.
   * @template T
   * @param {ConnectionRow} conn
   * @param {string} what for the sentence ("balances")
   * @param {(c: WebullClient) => Promise<T>} fn
   * @param {{ list?: boolean }} [o] list: fn reads the account list itself
   * @returns {Promise<T>}
   */
  async function withClient(conn, what, fn, o = {}) {
    const token = await bearer(conn);
    try {
      const out = await fn(clientFor(conn, token));
      await touch(conn);
      return out;
    } catch (e) {
      if (!(e instanceof BrokerAuthError)) throw e;
      if (e.brokerStatus !== 401) throw refusedRead(what, e.brokerStatus);
    }
    await markStale(conn, token);
    const again = await bearer(conn);
    try {
      const out = await fn(clientFor(conn, again));
      await touch(conn);
      return out;
    } catch (e) {
      if (!(e instanceof BrokerAuthError)) throw e;
      if (e.brokerStatus !== 401) throw refusedRead(what, e.brokerStatus);
    }
    if (!o.list) {
      // Only a refused account list ends the login; a 5xx or a limit there says nothing.
      const listWorks = await clientFor(conn, again)
        .accounts()
        .then(
          () => true,
          (e) => !(e instanceof BrokerAuthError && e.brokerStatus === 401),
        );
      if (listWorks) {
        log.info("webull refused one read with a fresh token; the login stands", { connectionId: conn.id, what });
        throw refusedRead(what, 401);
      }
    }
    log.info("webull refused a fresh token; login needed", { connectionId: conn.id });
    throw await endLogin(conn, WEBULL_DETAIL.ended);
  }

  /**
   * @template T
   * @typedef {{ ok: Array<[AccountRow, T]>, errors: Array<[AccountRow, HttpError]> }} Lane
   */

  /**
   * Reads one endpoint for each account, one account after another (Webull's per-endpoint limit).
   * An account whose read fails with a broker answer, a 401 or 403 included, becomes an error entry
   * (loginRefused decides whether the refusals were the token's); the session ending, a rate limit
   * or Nasscord's own limit stops the whole read.
   * @template T
   * @param {ConnectionRow} conn
   * @param {WebullClient} c
   * @param {AccountRow[]} accounts
   * @param {string} what
   * @param {(c: WebullClient, a: AccountRow) => Promise<T>} read
   * @returns {Promise<Lane<T>>}
   */
  async function lane(conn, c, accounts, what, read) {
    /** @type {Array<[AccountRow, T]>} */
    const ok = [];
    /** @type {Array<[AccountRow, HttpError]>} */
    const errors = [];
    for (const a of accounts) {
      try {
        ok.push([a, await read(c, a)]);
      } catch (e) {
        if (!(e instanceof HttpError) || e instanceof SessionExpiredError || e.status === 429) throw e;
        log.info("webull left out one account's read", { connectionId: conn.id, what, status: e instanceof BrokerAuthError ? e.brokerStatus : e.status });
        errors.push([a, e]);
      }
    }
    return { ok, errors };
  }

  /**
   * When Webull answered no call of a read and refused every one (401 or 403), that is the token or
   * the login, not the accounts: it is thrown for withClient (a refresh, then the account-list
   * check). One account that read fine proves the token, and the refused ones stay entries.
   * @param {Array<Lane<unknown>>} lanes
   */
  function loginRefused(lanes) {
    if (lanes.some((l) => l.ok.length > 0)) return;
    const errs = lanes.flatMap((l) => l.errors.map(([, e]) => e));
    if (errs.length === 0 || !errs.every((e) => e instanceof BrokerAuthError)) return;
    throw errs.find((e) => e instanceof BrokerAuthError && e.brokerStatus === 401) ?? errs[0];
  }

  /** Webull said no to this account (401, 403, another 4xx), rather than not answering. @param {HttpError} e */
  const refused = (e) => e instanceof BrokerAuthError || e.code === "broker_http";
  /** @param {string} what @param {AccountRow} a @param {HttpError} e */
  const accountProblem = (what, a, e) => (refused(e) ? WEBULL_DETAIL.accountRefused(what, a) : WEBULL_DETAIL.accountRead(what, a));
  /** @param {AccountRow[]} accounts */
  const idsOf = (accounts) => accounts.map((a) => a.id).sort().join(",");

  /**
   * A shared read, or LATE once `at` has passed. The read goes on after LATE and lands in the cache
   * for the next call; its failure is handled by the race, so nothing goes unhandled.
   * @template T
   * @param {Promise<T>} p
   * @param {number} at
   * @returns {Promise<T | typeof LATE>}
   */
  function byDeadline(p, at) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {Promise<typeof LATE>} */
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(LATE), Math.max(0, at - now()));
    });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  }

  /** @param {string} what */
  const slow = (what) => unavailable(WEBULL_DETAIL.slow(what), "broker_slow");

  /**
   * Some account's open or history read failed. Orders and fills have no per-account error channel
   * (the portfolio has one), so the whole login answers an error that names the account rather than
   * a list that silently lacks it.
   * @param {Array<[AccountRow, HttpError]>} failed
   * @param {boolean} anyOk some account's read came back
   */
  function ordersMissing(failed, anyOk) {
    const [a, e] = failed.find(([, x]) => refused(x)) ?? failed[0];
    if (refused(e)) return badGateway(WEBULL_DETAIL.ordersRefused(a), "broker_forbidden");
    // Webull answered nothing at all: its own sentence ("Webull is not answering right now (503).").
    if (!anyOk) return e;
    return badGateway(WEBULL_DETAIL.ordersMissing(a), e.code);
  }

  /**
   * Open orders plus 30 days of history per account, shared by orders() and executions(). Every
   * account or an error: a failure is thrown, so it is not cached.
   * @param {ConnectionRow} conn
   * @param {AccountRow[]} accounts
   */
  function rawOrders(conn, accounts) {
    return cache.get(
      `${conn.id}:webull-orders:${idsOf(accounts)}`,
      () =>
        withClient(conn, "orders", async (c) => {
          const t = now();
          const [open, history] = await Promise.all([
            lane(conn, c, accounts, "open orders", (cl, a) => cl.openOrders(a.external_id)),
            lane(conn, c, accounts, "order history", (cl, a) => cl.historicalOrders(a.external_id, t - WEBULL_HISTORY_MS, t)),
          ]);
          loginRefused([open, history]);
          const failed = [...open.errors, ...history.errors];
          if (failed.length > 0) throw ordersMissing(failed, open.ok.length + history.ok.length > 0);
          const openBy = new Map(open.ok.map(([a, v]) => [a.id, v]));
          const historyBy = new Map(history.ok.map(([a, v]) => [a.id, v]));
          return {
            fetchedAt: t,
            byAccount: new Map(accounts.map((a) => [a.id, mergeOrderGroups(openBy.get(a.id) ?? [], historyBy.get(a.id) ?? [])])),
          };
        }),
      RAW_TTL_MS,
    );
  }

  /**
   * TRADE cash activities of 30 days per account (the commissions of the fills), on their own
   * bucket. Optional: a refused or failed account is left out and its fills are provisional, and a
   * 401 here never refreshes or ends the login (the orders read decides that). Never rejects: the
   * session ending comes back as the error, so a caller may start this early and await it later.
   * @param {ConnectionRow} conn
   * @param {AccountRow[]} accounts
   * @returns {Promise<Map<string, any[]> | SessionExpiredError>}
   */
  function tradeActivities(conn, accounts) {
    return cache
      .get(
        `${conn.id}:webull-cash:${idsOf(accounts)}`,
        () =>
          withClient(conn, "trade activity", async (c) => {
            const t = now();
            const out = await lane(conn, c, accounts, "trade activity", (cl, a) => cl.tradeActivities(a.external_id, t - WEBULL_HISTORY_MS, t));
            return new Map(out.ok.map(([a, v]) => [a.id, v]));
          }),
        RAW_TTL_MS,
      )
      .catch((e) => {
        if (e instanceof SessionExpiredError) return e;
        log.info("webull trade activity not available; fills are provisional", { connectionId: conn.id, error: e });
        return /** @type {Map<string, any[]>} */ (new Map());
      });
  }

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const adapter = {
    descriptor: {
      method: "webull_oauth",
      brokers: ["webull"],
      name: "Webull",
      environments: ["production", "sandbox"],
      readTtlMs: { portfolio: 30_000, orders: 30_000, executions: 60_000 },
      lazyAccounts: false,
      sweepEveryMs: 15 * MINUTE,
      clients: ["platform"],
    },

    // One Webull service per server: live, or (outside production only) the sandbox.
    environmentsFor: () => [serverEnv],

    oauthProfile(environment, client) {
      if (client !== "platform") throw badRequest("Webull connects only through Nasscord's Webull app.", "unknown_method");
      return profileFor(environment);
    },

    /**
     * After the code exchange (canonical host): the login's name is Webull's identity_id. Without one
     * (Webull documents it as always sent) the login is named by a hash of its account ids.
     */
    async identify(conn, tokens) {
      const raw = /** @type {Record<string, unknown> | undefined} */ (tokens.raw);
      const identity = typeof raw?.identity_id === "string" ? raw.identity_id.trim() : "";
      if (/^[A-Za-z0-9_.:-]{1,190}$/.test(identity)) return { externalRef: identity, scope };
      const c = clientFor(conn, tokens.accessToken);
      const ids = webullAccountRows(await c.accounts()).map((a) => a.external_id);
      if (ids.length === 0) throw badRequest(WEBULL_DETAIL.noAccounts, "webull_no_accounts");
      const ref = loginRef({ key: platform?.clientId ?? "webull", members: ids });
      if (!ref) throw badGateway("Webull did not say which login this is. Start again from Brokers.", "no_identity");
      return { externalRef: ref, scope };
    },

    async listAccounts(conn) {
      const rows = await withClient(conn, "account list", async (c) => webullAccountRows(await c.accounts()), { list: true });
      if (rows.length === 0) throw badRequest(WEBULL_DETAIL.noAccounts, "webull_no_accounts");
      return rows;
    },

    async portfolio(conn, accounts) {
      const at = now() + readBudgetMs;
      const read = cache.get(
        `${conn.id}:webull-portfolio:${idsOf(accounts)}`,
        () =>
          withClient(conn, "balances and positions", async (c) => {
            const [balances, positions] = await Promise.all([
              lane(conn, c, accounts, "balances", (cl, a) => cl.balances(a.external_id)),
              lane(conn, c, accounts, "positions", (cl, a) => cl.positions(a.external_id)),
            ]);
            loginRefused([balances, positions]);
            // Nothing came back at all (Webull is down): one error for the connection, not one per
            // account, and not cached.
            if (accounts.length > 0 && balances.ok.length === 0 && positions.ok.length === 0) {
              const all = [...balances.errors, ...positions.errors];
              const [a, e] = all.find(([, x]) => !refused(x)) ?? all[0];
              throw refused(e) ? badGateway(accountProblem("balances", a, e), "broker_forbidden") : e;
            }
            return { balances, positions };
          }),
        RAW_TTL_MS,
      );
      const got = await byDeadline(read, at);
      if (got === LATE) throw slow("balances and positions");
      const { balances, positions } = got;
      return {
        accounts: balances.ok.map(([a, b]) => webullAccountSummary(b, a)),
        positions: positions.ok.flatMap(([a, p]) => webullPositions(p, a)),
        errors: [
          ...balances.errors.map(([a, e]) => ({ connectionId: conn.id, message: accountProblem("balances", a, e) })),
          ...positions.errors.map(([a, e]) => ({ connectionId: conn.id, message: accountProblem("positions", a, e) })),
        ],
      };
    },

    async orders(conn, accounts) {
      const raw = await byDeadline(rawOrders(conn, accounts), now() + readBudgetMs);
      if (raw === LATE) throw slow("orders");
      return accounts.flatMap((a) => webullOrders(raw.byAccount.get(a.id) ?? [], a, raw.fetchedAt));
    },

    async executions(conn, accounts) {
      const at = now() + readBudgetMs;
      // Started together: the cash activities have their own bucket and need only the time range,
      // so their wait does not add to the orders'.
      const cash = tradeActivities(conn, accounts);
      const raw = await byDeadline(rawOrders(conn, accounts), at);
      if (raw === LATE) throw slow("fills");
      // Commissions come from TRADE cash activities. Without them (the call failed, or is still
      // running) the fills are still shown, marked provisional.
      const activities = await byDeadline(cash, at);
      if (activities instanceof SessionExpiredError) throw activities;
      const byAccount = activities === LATE ? null : activities;
      return accounts.flatMap((a) => webullExecutions(raw.byAccount.get(a.id) ?? [], byAccount?.get(a.id) ?? null, a, raw.fetchedAt));
    },

    /**
     * The scheduler (every 15 minutes) and renew, under the connection's lock:
     * - no tokens left, or the 15-day end passed: expired, with that sentence;
     * - sliding mode, under 5 days left: refreshed now, so the new 15 days start;
     * - otherwise "skipped" (reads refresh the access token when they need it).
     */
    async refresh(conn) {
      const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
      if (!s || (!s.refreshToken && !s.accessToken)) {
        await endLogin(conn, WEBULL_DETAIL.ended);
        return "expired";
      }
      const end = webullDeadline(s);
      if (end !== null && end <= now()) {
        await endLogin(conn, WEBULL_DETAIL.period);
        log.info("webull login reached its 15 day end; connection expired", { connectionId: conn.id });
        return "expired";
      }
      if (mode !== "sliding" || end === null || end - now() > WEBULL_KEEPALIVE_MS) return "skipped";
      try {
        await bearer(conn, { force: true });
        return "ok";
      } catch (e) {
        if (e instanceof SessionExpiredError) return "expired";
        throw e;
      }
    },

    // No revoke: Webull publishes no token revocation for Connect. Disconnect deletes the tokens.

    forget(id) {
      lastOkWrite.delete(id);
      refusedRefresh.delete(id);
    },
  };
  return adapter;
}

/** @type {import("../adapter-types.mjs").AdapterFactory} */
export function createAdapter(deps) {
  return createWebullAdapter(deps);
}
