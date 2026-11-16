import { itemsOf } from "./mapping.mjs";

/**
 * tastytrade Open API, read calls only (docs/real-backend.md, "Read-only release").
 *
 * - Two environments that share nothing (separate users, OAuth apps and tokens):
 *   production: REST https://api.tastyworks.com, login page https://my.tastytrade.com/auth.html;
 *   cert (sample data, resets every day, developers only): REST https://api.cert.tastyworks.com,
 *   login page https://cert-my.staging-tasty.works/auth.html. In production only the first exists:
 *   a cert host is refused here as well as by the config (TASTYTRADE_ENV=cert) and the registry.
 *   BROKER_URL_OVERRIDES {"tastytrade":{"api":..,"authorize":..}} points both at a local fake
 *   outside production only.
 * - Every call carries "User-Agent: nasscord/<version>" (tastytrade answers 401 with an HTML body
 *   without one) and "Accept-Version: <TASTYTRADE_API_VERSION>" (20261012: order searches need
 *   start-date or start-at). The access token travels in the Authorization header, never in a URL.
 * - The allowlist below is the whole read surface: seven GET endpoints. The OAuth engine
 *   (src/oauth2.mjs) calls the token endpoint (POST /oauth/token) with its own one-path allowlist.
 *   Order placement, dry runs, replace, edit and cancel (POST, PUT, PATCH and DELETE under
 *   /orders and /complex-orders), the quote-streamer token and every other path are refused before
 *   any network call. Nasscord asks for the "read" scope only, and the allowlist is what keeps it
 *   read-only even if a grant carried "trade".
 * - tastytrade publishes no per-endpoint limits ("reasonable thresholds", 429 without headers).
 *   One bucket per connection (5 a second) plus the process-wide bucket; reads are cached 15 to 60
 *   seconds, so the steady rate stays low. Too many failed logins block the service IP for about 8
 *   hours: the token endpoint has the engine's circuit breaker (src/oauth2.mjs, profile `circuit`).
 * - Lists come as { data: { items }, pagination }; paged() follows page-offset up to total-pages,
 *   with a page cap so one account can never loop, and says when the cap cut a list short.
 * - Nothing here logs: no URL, query, header or body reaches a log line (src/http.mjs).
 */

/** @typedef {"production" | "cert"} TastytradeEnv */

/** tastytrade's own hosts per environment. */
export const TASTYTRADE_HOSTS = Object.freeze(
  /** @type {Record<TastytradeEnv, { api: string, authorize: string }>} */ ({
    production: Object.freeze({ api: "https://api.tastyworks.com", authorize: "https://my.tastytrade.com/auth.html" }),
    cert: Object.freeze({ api: "https://api.cert.tastyworks.com", authorize: "https://cert-my.staging-tasty.works/auth.html" }),
  }),
);

/** The token endpoint (authorization_code and refresh_token, JSON body), on the API host. */
export const TASTYTRADE_TOKEN_PATH = "/oauth/token";
/** What Nasscord asks a tastytrade login for: account reads only (no "trade" in this release). */
export const TASTYTRADE_SCOPE = "read";
/** Requests a second per connection. */
export const TASTYTRADE_RATE_PER_SEC = 5;

/** An account number as it may appear in a path: letters and digits only. */
export const ACCOUNT_SHAPE = /^[A-Za-z0-9]{1,20}$/;
const ACCT = "[A-Za-z0-9]{1,20}";

/**
 * The read-only allowlist (method, whole-path RegExp).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const TASTYTRADE_READ_ALLOW = Object.freeze([
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/customers\/me$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/customers\/me\/accounts$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/accounts/${ACCT}/balances$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/accounts/${ACCT}/positions$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/accounts/${ACCT}/orders/live$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/accounts/${ACCT}/orders$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/accounts/${ACCT}/transactions$`)]),
]);

/**
 * The only non-GET call Nasscord makes to tastytrade: the OAuth token endpoint (src/oauth2.mjs).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const TASTYTRADE_TOKEN_ALLOW = Object.freeze([/** @type {import("../http.mjs").AllowRule} */ (["POST", /^\/oauth\/token$/])]);

/**
 * Page sizes (tastytrade's maximums: orders 200, transactions 2000) and page caps per read: up to
 * 1000 orders per list and 5000 trades in the history window per account.
 */
export const ORDERS_PER_PAGE = 200;
export const TRANSACTIONS_PER_PAGE = 1000;
export const MAX_ORDER_PAGES = 5;
export const MAX_TRANSACTION_PAGES = 5;

/**
 * The hosts of one environment on this server. BROKER_URL_OVERRIDES apply outside production only,
 * so a local fake can never stand in for tastytrade in front of users, and the cert sandbox (sample
 * data) is refused in production whatever the caller asks.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 * @param {TastytradeEnv} env
 * @returns {{ api: string, authorize: string }}
 */
export function tastytradeHosts(urls, production, env) {
  if (env === "cert" && production) throw new Error("tastytrade: the cert sandbox serves sample data and is refused in production");
  const own = TASTYTRADE_HOSTS[env === "cert" ? "cert" : "production"];
  if (production) return { ...own };
  return {
    api: (urls?.api || own.api).replace(/\/+$/, ""),
    authorize: urls?.authorize || own.authorize,
  };
}

/** @param {string} n */
function accountSegment(n) {
  if (!ACCOUNT_SHAPE.test(n)) throw new Error("tastytrade: an account number that is not letters and digits was refused");
  return n;
}

/** @typedef {{ items: any[], truncated: boolean }} Paged a list, and whether the page cap cut it short */

/**
 * Pages through a list endpoint until tastytrade's total-pages, a short page, or `maxPages`.
 * `truncated` is true when the cap stopped it while tastytrade still had more (the oldest items,
 * as every list is read newest first).
 * @param {(offset: number) => Promise<any>} page
 * @param {number} perPage
 * @param {number} maxPages
 * @returns {Promise<Paged>}
 */
export async function paged(page, perPage, maxPages) {
  /** @type {any[]} */
  const items = [];
  for (let offset = 0; offset < maxPages; offset++) {
    const json = await page(offset);
    const got = itemsOf(json);
    items.push(...got);
    const raw = json?.pagination?.["total-pages"];
    const total = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    const more = Number.isFinite(total) ? offset + 1 < total : got.length >= perPage;
    if (!more || got.length === 0) return { items, truncated: false };
  }
  return { items, truncated: true };
}

/** @typedef {{ token: string, bucket: string }} TastytradeAuth a bearer token and its rate bucket */

/**
 * @param {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   userAgent: string,
 *   apiVersion: string,
 *   timeoutMs?: number,
 * }} o
 */
export function createTastytradeClient(o) {
  /** @type {Map<string, import("../http.mjs").BrokerHttp>} one client per rate bucket (per connection) */
  const clients = new Map();
  const headers = () => ({ "user-agent": o.userAgent, "accept-version": o.apiVersion });

  /** @param {string} bucket */
  function httpFor(bucket) {
    let c = clients.get(bucket);
    if (!c) {
      if (clients.size >= 1_000) clients.clear();
      c = o.http({
        name: "tastytrade",
        base: o.base,
        allow: [...TASTYTRADE_READ_ALLOW],
        bucket: { key: bucket, ratePerSec: TASTYTRADE_RATE_PER_SEC },
        timeoutMs: o.timeoutMs ?? 8_000,
        headers,
      });
      clients.set(bucket, c);
    }
    return c;
  }

  /**
   * @param {TastytradeAuth} auth
   * @param {string} path
   * @param {Record<string, string | number | boolean>} [query]
   */
  const get = (auth, path, query) => httpFor(auth.bucket).get(path, query, { headers: { authorization: `Bearer ${auth.token}` } });

  return {
    httpFor,
    /** @param {string} bucket */
    drop: (bucket) => clients.delete(bucket),

    /**
     * The signed-in customer. Only `external-id` is ever read from it: the answer also holds names,
     * the masked tax number and the birth date, which Nasscord never stores or logs.
     * @param {TastytradeAuth} auth
     */
    customer: async (auth) => (await get(auth, "/customers/me"))?.data ?? null,

    /** [{ account, authority-level }] of every account the login can see. @param {TastytradeAuth} auth */
    accounts: async (auth) => itemsOf(await get(auth, "/customers/me/accounts")),

    /** @param {TastytradeAuth} auth @param {string} n */
    balances: async (auth, n) => (await get(auth, `/accounts/${accountSegment(n)}/balances`))?.data ?? null,

    /** Positions with current marks. @param {TastytradeAuth} auth @param {string} n */
    positions: async (auth, n) => itemsOf(await get(auth, `/accounts/${accountSegment(n)}/positions`, { "include-marks": true })),

    /**
     * Orders created or updated during the current trading day, in any status, plus older orders
     * still working (a GTC placed months ago): tastytrade's own description of /orders/live.
     * @param {TastytradeAuth} auth @param {string} n
     */
    liveOrders: (auth, n) =>
      paged((offset) => get(auth, `/accounts/${accountSegment(n)}/orders/live`, { "per-page": ORDERS_PER_PAGE, "page-offset": offset }), ORDERS_PER_PAGE, MAX_ORDER_PAGES),

    /**
     * The order search since `startDate` (New York date), newest first. Under Accept-Version
     * 20261012 start-date (or start-at) is required.
     * @param {TastytradeAuth} auth @param {string} n @param {string} startDate
     */
    searchOrders: (auth, n, startDate) =>
      paged(
        (offset) =>
          get(auth, `/accounts/${accountSegment(n)}/orders`, {
            "start-date": startDate,
            sort: "Desc",
            "per-page": ORDERS_PER_PAGE,
            "page-offset": offset,
          }),
        ORDERS_PER_PAGE,
        MAX_ORDER_PAGES,
      ),

    /** Trade transactions since `startDate` (New York date), newest first. @param {TastytradeAuth} auth @param {string} n @param {string} startDate */
    trades: (auth, n, startDate) =>
      paged(
        (offset) =>
          get(auth, `/accounts/${accountSegment(n)}/transactions`, {
            type: "Trade",
            "start-date": startDate,
            sort: "Desc",
            "per-page": TRANSACTIONS_PER_PAGE,
            "page-offset": offset,
          }),
        TRANSACTIONS_PER_PAGE,
        MAX_TRANSACTION_PAGES,
      ),
  };
}

/** @typedef {ReturnType<typeof createTastytradeClient>} TastytradeClient */
