import { gateKey } from "../config.mjs";
import { badGateway, badRequest, BrokerAuthError, conflict, forbidden, HttpError, SessionExpiredError } from "../errors.mjs";
import { createBrokerHttp } from "../http.mjs";
import { clean } from "../mapping.mjs";
import { loginRef } from "../oauth2.mjs";
import { etDateKey, iso, parseTime } from "../time.mjs";
import { createTradierClient, quotaAwareFetch, TRADIER_CONNECT_BUCKET, TRADIER_OAUTH_PATHS, TRADIER_RATE_PER_SEC, TRADIER_SCOPE, tradierHosts } from "./client.mjs";
import {
  tradierAccountRows,
  tradierAccountSummary,
  tradierHistoryFills,
  tradierOrderFills,
  tradierOrders,
  tradierPosition,
  tradierProfile,
  tradierProfileId,
  tradierQuoteMap,
  tradierTokenError,
} from "./mapping.mjs";

/**
 * Tradier Brokerage, read only (docs/real-backend.md, sections 8 to 11). One package, two methods:
 *
 * - tradier_token (flow api_key): a pasted personal API token. Tradier's API is "intended for
 *   personal use only" unless you are a Tradier partner, so a Live token is the platform owner's own
 *   account only: BROKER_AUDIENCE tradier_token=superadmin, and this adapter refuses a Live token
 *   from anyone but the superadmin whatever the audience says (tradier_token=all only means
 *   something with Paper tokens on; without them the method reports itself not set up, so users are
 *   never offered a dialog that always fails). A Sandbox token is the user's own
 *   paper account (labelled Paper, never sample data), accepted only once Tradier agrees in writing
 *   (TRADIER_SANDBOX_TOKENS, off by default: the method then offers Live only, and stored paper
 *   connections are not read). The token is checked with GET /v1/user/profile on the host of the
 *   chosen account type and stored sealed as { token, host }. A personal token never expires; a 401
 *   means it was regenerated: the connection becomes expired and renew answers next.kind "api_key".
 * - tradier_oauth (flow oauth2_platform): Nasscord's own partner client (TRADIER_CLIENT_ID and
 *   TRADIER_CLIENT_SECRET), unavailable until those are set (src/registry.mjs) and opened to users
 *   with BROKER_AUDIENCE once Tradier accepts Nasscord as a partner. The authorize URL carries no
 *   redirect_uri (Tradier uses the one registered with the client:
 *   https://nasscord.com/api/broker/callback/tradier) and asks for "read market"; the token
 *   endpoints take HTTP Basic. The access token lives 24 hours. Without refresh tokens (a separate
 *   Tradier approval, TRADIER_REFRESH_TOKENS) session_expires_at is that end, the scheduler expires
 *   the connection then, and Reconnect asks the user to approve again. With them the access token is
 *   refreshed lazily when under an hour is left, at /v1/oauth/refreshtoken, and the login does not
 *   end on its own.
 *
 * Both name the login by the profile id (external_ref), so the same Tradier login connected twice,
 * or by token and then by OAuth, is one connection. Reads are the same for both: balances, positions
 * valued with quotes (market data), today's orders, and fills (today's from the orders, earlier ones
 * from the history). Tradier has no token revocation API: Disconnect deletes what Nasscord stored.
 *
 * Nothing here logs a token, code, account number or query string.
 */

/** Sentences on the connection (status_detail) and in read errors. */
export const TRADIER_DETAIL = Object.freeze({
  tokenRefused: "Tradier no longer accepts this token. Paste the new token.",
  daily: "Tradier ends Nasscord's access every 24 hours. Reconnect to approve again.",
  ended: "Tradier no longer accepts Nasscord's access. Reconnect to approve again.",
  noAccounts: "This Tradier login has no open account to connect.",
  ownerOnly:
    "Only the platform owner can connect a Live Tradier token: Tradier's API is for personal use unless you are a Tradier partner.",
  sandboxOff: "Tradier sandbox (paper) tokens are not accepted on this server yet.",
  sandboxOffRead: "Tradier sandbox (paper) tokens are no longer accepted on this server. Disconnect this connection.",
  noQuotes: "Tradier did not send prices, so positions are not shown. Try again in a moment.",
  /** @param {string[]} symbols */
  noPrice: (symbols) => `Tradier sent no price for ${symbols.slice(0, 5).join(", ")}${symbols.length > 5 ? ` and ${symbols.length - 5} more` : ""}, so ${symbols.length === 1 ? "its" : "their"} market value is not shown.`,
  /** @param {string} what @param {string} display */
  accountRead: (what, display) => `Tradier did not send the ${what} of account ${display}.`,
  /** For the owner (GET /v1/options): BROKER_AUDIENCE opened tokens to everyone, but only Paper tokens can be anyone's. */
  audienceNeedsSandbox:
    "BROKER_AUDIENCE tradier_token=all lets everyone paste a Tradier token, but a Live token can only be the owner's and TRADIER_SANDBOX_TOKENS is off. Set tradier_token=superadmin, or turn on TRADIER_SANDBOX_TOKENS",
});

/** The access token's life when Tradier's answer does not say (it says 86399 seconds). */
export const TRADIER_ACCESS_MS = 24 * 3_600_000;
/** With refresh tokens, a refresh once less than this is left. */
const REFRESH_BEFORE_MS = 60 * 60_000;
/** Earlier fills are read from the history for this many days back. */
export const TRADIER_HISTORY_DAYS = 60;
/** The history changes once a day: it is read again at most this often per account. */
const HISTORY_TTL_MS = 10 * 60_000;
/** Raw orders are shared by orders() and executions() for this long. */
const ORDERS_RAW_TTL_MS = 10_000;
/** last_ok_at is written at most this often per connection. */
const OK_WRITE_MS = 60_000;
const TOKEN_SHAPE = /^[\x21-\x7e]{8,512}$/;

const READ_TTL = Object.freeze({ portfolio: 15_000, orders: 30_000, executions: 60_000 });

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("../db.mjs").Environment} Environment
 * @typedef {import("../oauth2.mjs").OAuthProfile} OAuthProfile
 * @typedef {import("../oauth2.mjs").OAuthSecret} OAuthSecret
 * @typedef {import("./client.mjs").TradierHost} TradierHost
 * @typedef {import("./client.mjs").TradierClient} TradierClient
 * @typedef {{ token: string, host: TradierHost }} TradierTokenSecret
 * @typedef {{ kind: "token", token: string, host: TradierHost, secret: TradierTokenSecret } | { kind: "oauth", token: string, host: "live" }} TradierAuth
 * @typedef {{ connectionId: string, message: string }} PartialError
 */

/** @param {Environment} environment @returns {TradierHost} */
const hostOf = (environment) => (environment === "paper" ? "sandbox" : "live");

/** @param {unknown} s @returns {s is TradierTokenSecret} */
const isTokenSecret = (s) =>
  !!s && typeof s === "object" && typeof (/** @type {any} */ (s).token) === "string" && ["live", "sandbox"].includes(/** @type {any} */ (s).host);

/** "2026-11-16" -> "2026-11-15" (calendar arithmetic on the New York date). @param {string} key @param {number} days */
function shiftDate(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from one date key to a later one. @param {string} from @param {string} to */
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** "orders of account 6YA•••01", for the sentences of one account's reads. @param {string} what @param {{ display_number: string }} account */
const ofAccount = (what, account) => `${what} of account ${account.display_number}`;

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
  const { config, store, oauth2, locks, cache, log, now } = deps;
  const settings = config.brokers.tradier;
  const hosts = tradierHosts(deps.urls, config.production);
  const platform = settings.clientId && settings.clientSecret ? { clientId: settings.clientId, clientSecret: settings.clientSecret } : null;
  // Tradier's "Quota Violation" is a 400 with the end in its body: quotaAwareFetch turns it into the
  // Retry-After that src/http.mjs pauses the bucket for (same limiter and fetch as deps.http).
  const quotaFetch = quotaAwareFetch(deps.fetch, now);
  /** @type {(o: Omit<import("../http.mjs").BrokerHttpOptions, "limiter" | "fetch" | "now">) => import("../http.mjs").BrokerHttp} */
  const makeHttp = (o) => createBrokerHttp({ ...o, limiter: deps.limiter, fetch: quotaFetch, now });
  /** @type {Map<string, number>} last last_ok_at write per connection */
  const lastOkWrite = new Map();

  /** @returns {OAuthProfile} */
  function profileOf() {
    return {
      brokerId: "tradier",
      name: "Tradier",
      authorizeUrl: `${hosts.oauth}${TRADIER_OAUTH_PATHS.authorize}`,
      tokenUrl: `${hosts.oauth}${TRADIER_OAUTH_PATHS.token}`,
      refreshUrl: `${hosts.oauth}${TRADIER_OAUTH_PATHS.refresh}`,
      clientAuth: "basic",
      // Tradier takes the redirect URI registered with the client, never one in the request.
      sendRedirectUri: false,
      scope: TRADIER_SCOPE,
      pkce: false,
      platformClient: platform,
      refresh: settings.refreshTokens
        ? { kind: "fixed", accessFallbackMs: TRADIER_ACCESS_MS, refreshBeforeMs: REFRESH_BEFORE_MS }
        : { kind: "none", accessFallbackMs: TRADIER_ACCESS_MS },
      expiredDetail: settings.refreshTokens ? TRADIER_DETAIL.ended : TRADIER_DETAIL.daily,
      tokenRatePerSec: 1,
      parseTokenError: tradierTokenError,
    };
  }

  /**
   * @param {TradierHost} host
   * @param {string} token
   * @param {string} bucketKey
   */
  const clientFor = (host, token, bucketKey) => createTradierClient({ makeHttp, base: hosts[host], token, bucketKey, ratePerSec: TRADIER_RATE_PER_SEC[host] });

  /** @param {ConnectionRow} conn @param {TradierAuth} auth */
  const clientOf = (conn, auth) => clientFor(auth.host, auth.token, `tradier:${conn.id}`);

  /** @param {string} id */
  async function touch(id) {
    const t = now();
    if (t - (lastOkWrite.get(id) ?? 0) < OK_WRITE_MS) return;
    lastOkWrite.set(id, t);
    await store.updateConnectionIf(id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /**
   * The token of a personal-token connection is gone or refused: expired, renew asks for the new one.
   * @param {ConnectionRow} conn @param {number | null} brokerStatus
   * @returns {Promise<never>}
   */
  async function tokenEnded(conn, brokerStatus) {
    cache.invalidate(conn.id);
    lastOkWrite.delete(conn.id);
    await store.updateConnectionIf(conn.id, ["active"], { status: "expired", status_detail: TRADIER_DETAIL.tokenRefused });
    log.info("tradier token refused; connection expired", { connectionId: conn.id, brokerStatus });
    throw new SessionExpiredError(TRADIER_DETAIL.tokenRefused, { reauth: "api_key" });
  }

  /**
   * The OAuth login was refused: tokens dropped, expired, Reconnect starts a new login.
   * @param {ConnectionRow} conn @param {string} detail
   * @returns {Promise<never>}
   */
  async function loginEnded(conn, detail) {
    lastOkWrite.delete(conn.id);
    await oauth2.expire(conn, detail);
    throw new SessionExpiredError(detail, { reauth: "redirect" });
  }

  /**
   * The token a read uses: the stored personal token, or a live OAuth access token (refreshed by
   * the engine under the token lock when refresh tokens are on).
   * @param {ConnectionRow} conn
   * @returns {Promise<TradierAuth>}
   */
  async function authOf(conn) {
    if (conn.method === "tradier_token") {
      if (conn.status !== "active") throw new SessionExpiredError(conn.status_detail || TRADIER_DETAIL.tokenRefused, { reauth: "api_key" });
      if (conn.environment === "paper" && !settings.sandboxTokens) throw conflict(TRADIER_DETAIL.sandboxOffRead, "sandbox_tokens_off");
      const secret = await oauth2.loadSecret(conn.id);
      if (!isTokenSecret(secret)) return tokenEnded(conn, null);
      const host = hostOf(conn.environment);
      // The token was checked on this host when it was stored; a token of the other host never reads here.
      if (secret.host !== host) throw new Error("tradier: the stored token is for another host than the connection");
      return { kind: "token", token: secret.token, host, secret };
    }
    if (conn.environment !== "production") throw new Error("tradier: OAuth connections are Live only");
    return { kind: "oauth", token: await oauth2.accessToken(conn, profileOf()), host: "live" };
  }

  /**
   * Tradier refused an access token Nasscord still thought valid: mark it stale (under the engine's
   * token lock, only if no other call refreshed it already) so the next authOf() refreshes.
   * @param {ConnectionRow} conn @param {string} token
   */
  async function markStale(conn, token) {
    await locks.run(`token:${conn.id}`, async () => {
      const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id, { fresh: true }));
      if (s?.accessToken === token) await oauth2.saveSecret(conn.id, { ...s, accessExpiresAt: iso(0) });
    });
  }

  /**
   * Runs a read with the connection's token. A 401 or 403 is checked against /v1/user/profile: if
   * the profile reads, only this endpoint refused (a scope, one account) and the read fails alone;
   * if the token itself is refused, a personal token ends (next.kind api_key), and an OAuth login
   * gets one refresh and one retry when refresh tokens are on, else it ends (next.kind redirect).
   * @template T
   * @param {ConnectionRow} conn
   * @param {string} what for the sentence ("prices", or ofAccount("orders", account))
   * @param {(client: TradierClient) => Promise<T>} fn
   * @param {boolean} [profileCall] fn is the profile call itself
   * @returns {Promise<T>}
   */
  async function withAuth(conn, what, fn, profileCall = false) {
    let auth = await authOf(conn);
    for (let attempt = 0; ; attempt++) {
      const client = clientOf(conn, auth);
      let status = 0;
      try {
        const out = await fn(client);
        await touch(conn.id);
        return out;
      } catch (e) {
        if (!(e instanceof BrokerAuthError)) throw e;
        status = e.brokerStatus;
      }
      if (!profileCall) {
        let tokenRefused = false;
        try {
          await client.profile();
        } catch (e2) {
          if (!(e2 instanceof BrokerAuthError)) throw e2;
          status = e2.brokerStatus;
          tokenRefused = true;
        }
        if (!tokenRefused) throw badGateway(`Tradier refused to send the ${what} (${status}).`, "broker_forbidden");
      }
      if (auth.kind === "token") {
        // A token replaced while the read ran reads next time; the old one ending changes nothing.
        const current = await oauth2.loadSecret(conn.id, { fresh: true }).catch(() => null);
        if (isTokenSecret(current) && current.token !== auth.token) {
          throw new HttpError(409, "The Tradier token of this connection was just replaced. Refresh to read with the new token.", { code: "key_replaced" });
        }
        return tokenEnded(conn, status);
      }
      if (settings.refreshTokens && attempt === 0) {
        await markStale(conn, auth.token);
        auth = await authOf(conn);
        continue;
      }
      log.info("tradier refused the access token; login needed", { connectionId: conn.id, brokerStatus: status });
      return loginEnded(conn, TRADIER_DETAIL.ended);
    }
  }

  /**
   * Today's orders of one account, shared by orders() and executions() for a few seconds.
   * @param {ConnectionRow} conn @param {AccountRow} account
   * @returns {Promise<any[]>}
   */
  const rawOrders = (conn, account) =>
    cache.get(`${conn.id}:tradier-orders:${account.id}`, () => withAuth(conn, ofAccount("orders", account), (c) => c.orders(account.external_id)), ORDERS_RAW_TTL_MS);

  /**
   * Every trade event of one account over the last days up to `end`. An account with more events
   * than one read takes (MAX_HISTORY_PAGES full pages) is read again over half the days, until the
   * read is whole: the fills shown cover fewer days then, but never a day with fills missing. Only
   * a single day that still does not fit is kept as read (and logged).
   * @param {ConnectionRow} conn @param {AccountRow} account @param {TradierClient} client
   * @param {string} start @param {string} end
   */
  async function historyOf(conn, account, client, start, end) {
    let from = start;
    for (;;) {
      const { events, complete } = await client.history(account.external_id, from, end);
      if (complete) return events;
      const days = daysBetween(from, end);
      if (days <= 0) {
        log.info("tradier history holds more trades on one day than one read takes", { connectionId: conn.id });
        return events;
      }
      from = shiftDate(end, -Math.floor(days / 2));
    }
  }

  /**
   * Trade events of one account from `start` to `end` (New York dates), kept 10 minutes.
   * @param {ConnectionRow} conn @param {AccountRow} account @param {string} start @param {string} end
   * @returns {Promise<any[]>}
   */
  const rawHistory = (conn, account, start, end) =>
    cache.get(
      `${conn.id}:tradier-history:${account.id}:${start}:${end}`,
      () => withAuth(conn, ofAccount("trade history", account), (c) => historyOf(conn, account, c, start, end)),
      HISTORY_TTL_MS,
    );

  /**
   * Balances and positions of every account, the positions valued with one quote read. One
   * account's refusal is an error entry and the others still show; a quote failure leaves the
   * positions out (never shown at an invented price) and keeps the balances.
   * @param {ConnectionRow} conn @param {AccountRow[]} accounts
   */
  async function portfolio(conn, accounts) {
    /** @type {PartialError[]} */
    const errors = [];
    const reads = await Promise.all(
      accounts.map(async (account) => {
        const [b, p] = await Promise.all([
          settle(withAuth(conn, ofAccount("balances", account), (c) => c.balances(account.external_id))),
          settle(withAuth(conn, ofAccount("positions", account), (c) => c.positions(account.external_id))),
        ]);
        for (const r of [b, p]) if (!r.ok && !accountScoped(r.error)) throw r.error;
        return { account, b, p };
      }),
    );
    /** @type {import("../mapping.mjs").AccountSummary[]} */
    const summaries = [];
    /** @type {Array<{ account: AccountRow, list: any[] }>} */
    const held = [];
    for (const { account, b, p } of reads) {
      if (b.ok) summaries.push(tradierAccountSummary(b.value, account));
      else errors.push({ connectionId: conn.id, message: TRADIER_DETAIL.accountRead("balances", account.display_number) });
      if (p.ok) held.push({ account, list: p.value.filter((x) => Number(x?.quantity) !== 0) });
      else errors.push({ connectionId: conn.id, message: TRADIER_DETAIL.accountRead("positions", account.display_number) });
    }

    const symbols = [...new Set(held.flatMap((h) => h.list.map((x) => clean(x?.symbol).toUpperCase())).filter(Boolean))];
    /** @type {Map<string, import("./mapping.mjs").Quote>} */
    let quotes = new Map();
    if (symbols.length > 0) {
      try {
        quotes = tradierQuoteMap(await withAuth(conn, "prices", (c) => c.quotes(symbols)));
      } catch (e) {
        if (e instanceof SessionExpiredError || !(e instanceof HttpError)) throw e;
        log.info("tradier quotes not available; positions left out", { connectionId: conn.id, status: e.status });
        return { accounts: summaries, positions: [], errors: [...errors, { connectionId: conn.id, message: TRADIER_DETAIL.noQuotes }] };
      }
    }
    /** @type {import("../mapping.mjs").Position[]} */
    const positions = [];
    /** @type {Set<string>} */
    const unpriced = new Set();
    for (const { account, list } of held) {
      for (const raw of list) {
        const symbol = clean(raw?.symbol).toUpperCase();
        if (!symbol) continue;
        const quote = quotes.get(symbol);
        if (quote?.price === undefined) unpriced.add(symbol);
        positions.push(tradierPosition(raw, account, quote));
      }
    }
    if (unpriced.size > 0) errors.push({ connectionId: conn.id, message: TRADIER_DETAIL.noPrice([...unpriced]) });
    return { accounts: summaries, positions, errors };
  }

  /** @param {ConnectionRow} conn @param {AccountRow[]} accounts */
  async function orders(conn, accounts) {
    const t = now();
    const lists = await Promise.all(accounts.map((a) => rawOrders(conn, a)));
    return lists.flatMap((list, i) => tradierOrders(list, accounts[i], t));
  }

  /**
   * Today's fills from today's orders, earlier ones from the history up to yesterday (New York),
   * so a fill is never counted twice. /orders is the present session; when it still holds an
   * earlier day's filled order (after New York midnight, before Tradier clears the list), that fill
   * is shown from the order only until the history holds a trade of the same symbol on that day.
   * @param {ConnectionRow} conn @param {AccountRow[]} accounts
   */
  async function executions(conn, accounts) {
    const t = now();
    const today = etDateKey(t);
    const start = shiftDate(today, -TRADIER_HISTORY_DAYS);
    const end = shiftDate(today, -1);
    /** @param {{ tradedAt: string, symbol: string }} f */
    const dayAndSymbol = (f) => `${etDateKey(Date.parse(f.tradedAt))}|${f.symbol}`;
    const per = await Promise.all(
      accounts.map(async (account) => {
        const [list, events] = await Promise.all([rawOrders(conn, account), rawHistory(conn, account, start, end)]);
        const earlier = tradierHistoryFills(events, account, { before: today });
        const booked = new Set(earlier.map(dayAndSymbol));
        const fromOrders = tradierOrderFills(list, account, t).filter((f) => etDateKey(Date.parse(f.tradedAt)) >= today || !booked.has(dayAndSymbol(f)));
        return [...fromOrders, ...earlier];
      }),
    );
    return per.flat();
  }

  /** The open accounts of the connection's login. @param {ConnectionRow} conn */
  async function listAccounts(conn) {
    const json = await withAuth(conn, "account list", (c) => c.profile(), true);
    return tradierAccountRows(tradierProfile(json), conn.environment);
  }

  /**
   * The login's identity from its profile: the profile id, else (never seen) a hash of the
   * account numbers. Refuses a login without an open account.
   * @param {any} json
   * @param {Environment} environment
   */
  function identityOf(json, environment) {
    const profile = tradierProfile(json);
    const accounts = tradierAccountRows(profile, environment);
    if (accounts.length === 0) throw badRequest(TRADIER_DETAIL.noAccounts, "tradier_no_accounts");
    const ref = tradierProfileId(profile) ?? loginRef({ key: "tradier", members: accounts.map((a) => a.external_id) });
    if (!ref) throw badGateway("Tradier sent a reply Nasscord could not read.", "broker_reply");
    return { ref, accounts };
  }

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const tokenAdapter = {
    descriptor: {
      method: "tradier_token",
      brokers: ["tradier"],
      name: "Tradier",
      environments: ["production", "paper"],
      readTtlMs: READ_TTL,
      lazyAccounts: false,
      sweepEveryMs: null,
    },

    // Paper (the user's own sandbox account) only once Tradier agrees in writing.
    environmentsFor: (c) => (c.brokers.tradier.sandboxTokens ? ["production", "paper"] : ["production"]),

    // A Live token is the owner's alone (connectKey refuses it from anyone else). Opened to everyone
    // without Paper tokens, the method would offer users a Connect dialog that always fails: it is
    // reported as not set up instead, with the fix for the owner.
    configured: () => (config.audience[gateKey("tradier_token")] === "all" && !settings.sandboxTokens ? TRADIER_DETAIL.audienceNeedsSandbox : null),

    async connectKey(ctx, input) {
      const token = input.secret;
      if (!TOKEN_SHAPE.test(token)) throw badRequest("Paste the Tradier API access token exactly as Tradier shows it.", "bad_secret");
      const owner = ctx.claims.role === "superadmin";
      const asked = input.environment ?? ctx.existing?.environment ?? null;
      if (asked === "sandbox") throw badRequest("Choose Live or Paper for Tradier.", "bad_environment");
      if (asked === "paper" && !settings.sandboxTokens) throw badRequest(TRADIER_DETAIL.sandboxOff, "sandbox_tokens_off");
      if (asked === "production" && !owner) throw forbidden(TRADIER_DETAIL.ownerOnly, "tradier_personal_only");
      /** @type {Environment[]} */
      const order = asked ? [asked] : [...(owner ? /** @type {Environment[]} */ (["production"]) : []), ...(settings.sandboxTokens ? /** @type {Environment[]} */ (["paper"]) : [])];
      if (order.length === 0) throw forbidden(TRADIER_DETAIL.ownerOnly, "tradier_personal_only");

      /** @type {unknown} */
      let failure = null;
      for (const environment of order) {
        const host = hostOf(environment);
        let json;
        try {
          json = await clientFor(host, token, TRADIER_CONNECT_BUCKET).profile();
        } catch (e) {
          // Refused here: maybe a token of the other host. A 429 stops the check; any other failure
          // (Tradier down) is answered only if no host takes the token.
          if (e instanceof BrokerAuthError) continue;
          if (e instanceof HttpError && e.status === 429) throw e;
          failure ??= e;
          continue;
        }
        const { ref, accounts } = identityOf(json, environment);
        return {
          environment,
          externalRef: ref,
          secret: /** @type {TradierTokenSecret} */ ({ token, host }),
          accounts,
          scope: null,
          sessionExpiresAt: null,
        };
      }
      if (failure) throw failure;
      const where =
        order.length > 1
          ? "Copy it again from the API Access page in Tradier."
          : order[0] === "paper"
            ? "Copy the token under Sandbox Account Access (Paper trading) on Tradier's API Access page."
            : "Copy the token under Production Account Access on Tradier's API Access page.";
      throw badRequest(`Tradier did not accept this token${order.length > 1 ? "" : order[0] === "paper" ? " as a Paper token" : " as a Live token"}. ${where}`, "tradier_token_rejected");
    },

    listAccounts,
    portfolio,
    orders,
    executions,

    /**
     * Renew and Reconnect (flows.genericRenew): does the stored token still work? A refused token
     * is "expired" and renew asks for the new one.
     */
    async refresh(conn) {
      try {
        await withAuth(conn, "account list", (c) => c.profile(), true);
        return "ok";
      } catch (e) {
        if (e instanceof SessionExpiredError) return "expired";
        throw e;
      }
    },

    /** Tradier has no API to revoke a personal token; Disconnect deletes the stored one. */
    async revoke() {},

    forget(id) {
      lastOkWrite.delete(id);
    },
  };

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const oauthAdapter = {
    descriptor: {
      method: "tradier_oauth",
      brokers: ["tradier"],
      name: "Tradier",
      // Tradier documents OAuth for Live only.
      environments: ["production"],
      readTtlMs: READ_TTL,
      lazyAccounts: false,
      // Expires the connection at its 24-hour end (no refresh tokens), or keeps it refreshed.
      sweepEveryMs: 5 * 60_000,
      clients: ["platform"],
    },

    configured: (client) => (client === "platform" ? null : "Tradier logins use Nasscord's own partner client only"),

    oauthProfile: () => profileOf(),

    /** After the code exchange (canonical host): the profile names the login. */
    async identify(conn, tokens) {
      const json = await clientFor("live", tokens.accessToken, `tradier:${conn.id}`).profile();
      return { externalRef: identityOf(json, "production").ref, scope: tokens.scope ?? null };
    },

    listAccounts,
    portfolio,
    orders,
    executions,

    /**
     * The scheduler (every 5 minutes) and Reconnect: expired at the 24-hour end without refresh
     * tokens; with them the access token is refreshed once under an hour is left. The stored
     * session end follows the setting, so the Brokers page warns only when the login really ends.
     */
    async refresh(conn) {
      try {
        await authOf(conn);
      } catch (e) {
        if (e instanceof SessionExpiredError) return "expired";
        throw e;
      }
      const secret = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
      const end = oauth2.sessionExpiry(profileOf(), secret);
      if ((parseTime(end) ?? null) !== (parseTime(conn.session_expires_at) ?? null)) {
        await store.updateConnectionIf(conn.id, ["active"], { session_expires_at: end }).catch(() => {});
      }
      return "ok";
    },

    // No revoke: Tradier publishes no token revocation. Disconnect deletes Nasscord's tokens.

    forget(id) {
      lastOkWrite.delete(id);
    },
  };

  return [tokenAdapter, oauthAdapter];
}
