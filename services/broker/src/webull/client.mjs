import { iso } from "../time.mjs";
import { signRequest } from "./signer.mjs";

/**
 * Webull Connect API, read calls only (docs/real-backend.md, "Read-only release").
 *
 * - Hosts: production https://us-oauth-open-api.webull.com, sandbox (Webull's required testing,
 *   developers only, refused in production) https://oauth-open-api.sandbox.webull.com. The OAuth
 *   endpoints and the trading endpoints share the host; the browser sign-in itself happens on
 *   passport.webull.com, which the authorize endpoint redirects to. BROKER_URL_OVERRIDES
 *   {"webull":{"api":"http://127.0.0.1:9300"}} points both environments at a local fake outside
 *   production; in production overrides are ignored.
 * - The allowlist below is the whole read surface: six GET endpoints. The token endpoint is called
 *   by the OAuth engine (src/oauth2.mjs) with its own one-path allowlist. Preview, place, replace,
 *   cancel and batch-place (POST /trading/orders/*) are refused before any network call, whatever
 *   scope Webull granted.
 * - Rate limits (developer.webull.com/apis/docs/rate-limits): in production Webull allows 2 calls
 *   per 2 seconds per endpoint for balances, positions, open orders and order history, 600 per 60
 *   seconds for cash activities and 10 per 30 seconds for the account list; its sandbox allows 30
 *   per 60 seconds on every endpoint. On Connect all of one authorized user's calls must stay under
 *   90 a minute, and repeated 429s can get the calling IP blocked for everyone. So every endpoint
 *   has its own bucket per connection a little under its limit (WEBULL_RATES), the adapter reads
 *   one account after another on each endpoint, and a connection stops at 80 calls a minute.
 * - Resource calls carry "Authorization: Bearer <access token>", as Webull's Connect guide shows.
 *   TODO(webull-onboarding): Webull issues Connect apps an app_key and app_secret "for request
 *   signing", but its Connect pages show resource calls with the Bearer token only and never say
 *   whether they must be signed too. Ask Webull (connect.api@webull-us.com) during onboarding and
 *   confirm in the sandbox; `signReads` turns the HMAC headers on for every read if they must.
 * - Nothing here logs: no URL, query, header or body reaches a log line (src/http.mjs).
 */

export const WEBULL_HOSTS = Object.freeze({
  production: "https://us-oauth-open-api.webull.com",
  sandbox: "https://oauth-open-api.sandbox.webull.com",
});
export const WEBULL_OAUTH_PATHS = Object.freeze({ authorize: "/oauth2/auth-codes/get", token: "/oauth2/tokens/create" });
/** x-version of the token endpoint (its reference accepts only v2) and of the trading endpoints. */
export const WEBULL_VERSIONS = Object.freeze({ token: "v2", trading: "v3" });

export const WEBULL_PATHS = Object.freeze({
  accounts: "/trading/accounts/list",
  balances: "/trading/assets/balances/get",
  positions: "/trading/assets/positions/list",
  openOrders: "/trading/orders/open-orders/list",
  historicalOrders: "/trading/orders/historical-orders/list",
  cashActivities: "/trading/activities/cash-activities/list",
});

/**
 * The read-only allowlist (method, whole-path RegExp).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const WEBULL_READ_ALLOW = Object.freeze(
  Object.values(WEBULL_PATHS).map((p) => /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)])),
);

/**
 * Calls a second per endpoint and connection, a little under Webull's limits for room against
 * network jitter. endpoint: balances, positions, open orders, order history (production 2 per 2
 * seconds); cash: cash activities (600 per 60 seconds); accounts: the account list (10 per 30
 * seconds). The sandbox allows 30 per 60 seconds on every endpoint.
 */
export const WEBULL_RATES = Object.freeze({
  production: Object.freeze({ endpoint: 0.9, cash: 9, accounts: 0.3 }),
  sandbox: Object.freeze({ endpoint: 0.45, cash: 0.45, accounts: 0.3 }),
});
/** Calls a minute per connection (Webull: under 90 per authorized user). */
export const WEBULL_USER_BUDGET = 80;
/** Pages read per list before stopping (a page is about 100 orders or activities). */
const MAX_PAGES = 20;

/** An account_id as it may go into a query: Webull's ids are letters and digits. */
export const ACCOUNT_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The API base of an environment. Overrides (local fakes) only outside production.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 * @param {"production" | "sandbox"} environment
 */
export function webullBase(urls, production, environment) {
  if (!production && urls.api) return urls.api.replace(/\/+$/, "");
  return WEBULL_HOSTS[environment];
}

/**
 * [from, to] cut at each UTC new year: Webull's cash activities refuse a range that crosses a
 * calendar year. Both ends inclusive, in milliseconds.
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {Array<[number, number]>}
 */
export function splitByYear(fromMs, toMs) {
  /** @type {Array<[number, number]>} */
  const out = [];
  let start = fromMs;
  while (start <= toMs) {
    const nextYear = Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1);
    const end = Math.min(toMs, nextYear - 1);
    out.push([start, end]);
    start = nextYear;
  }
  return out;
}

/**
 * @typedef {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   token: string,
 *   connectionId: string,
 *   budget: import("../limits.mjs").WindowCounter,
 *   signing?: { appKey: string, appSecret: string } | null,
 *   now: () => number,
 *   timeoutMs?: number,
 *   environment?: "production" | "sandbox",
 * }} WebullClientOptions
 * signing: set when reads must carry the HMAC headers (see the TODO above). environment: whose
 * rate limits apply (default production).
 */

/**
 * One client per connection and access token.
 * @param {WebullClientOptions} o
 */
export function createWebullClient(o) {
  const rates = WEBULL_RATES[o.environment === "sandbox" ? "sandbox" : "production"];
  // One bucket per endpoint and connection ("webull:<id>:<path>"), so limiter.forget(id) drops them.
  /** @param {number} ratePerSec @param {string} [only] a fixed key for a client of one endpoint */
  const client = (ratePerSec, only) =>
    o.http({
      name: "Webull",
      base: o.base,
      allow: [...WEBULL_READ_ALLOW],
      bucket: { key: only ? `webull:${o.connectionId}:${only}` : (path) => `webull:${o.connectionId}:${path}`, ratePerSec },
      timeoutMs: o.timeoutMs ?? 8_000,
    });
  const http = client(rates.endpoint);
  const accountsHttp = client(rates.accounts, "accounts");
  const cashHttp = client(rates.cash, WEBULL_PATHS.cashActivities);

  /**
   * @param {string} path
   * @param {Record<string, string>} [query]
   */
  async function get(path, query = {}) {
    o.budget.take(`webull:${o.connectionId}`, WEBULL_USER_BUDGET, 60_000, "Webull limits how often Nasscord may read one login. Try again in a minute.");
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${o.token}` };
    if (o.signing) {
      // The same query string src/http.mjs builds, so the signed URL is the one sent.
      const u = new URL(`${o.base}${path}`);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      Object.assign(headers, signRequest({ ...o.signing, url: u, now: o.now(), version: WEBULL_VERSIONS.trading }));
    }
    const c = path === WEBULL_PATHS.accounts ? accountsHttp : path === WEBULL_PATHS.cashActivities ? cashHttp : http;
    return c.get(path, query, { headers });
  }

  /**
   * Every page of a paged list ({ data: [], pagination_key }).
   * @param {string} path
   * @param {Record<string, string>} query
   * @returns {Promise<any[]>}
   */
  async function pages(path, query) {
    /** @type {any[]} */
    const out = [];
    /** @type {Set<string>} */
    const seen = new Set();
    let key = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await get(path, key ? { ...query, pagination_key: key } : query);
      const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      out.push(...data);
      const next = typeof body?.pagination_key === "string" ? body.pagination_key : "";
      if (!next || seen.has(next) || data.length === 0) break;
      seen.add(next);
      key = next;
    }
    return out;
  }

  /** @param {string} id */
  const account = (id) => {
    if (!ACCOUNT_ID_SHAPE.test(id)) throw new Error("webull: an account id that is not letters and digits was refused");
    return id;
  };

  return {
    /** Every account of the login (one per product: stock, IRA, futures, crypto, events). */
    accounts: () => get(WEBULL_PATHS.accounts),
    /** @param {string} accountId */
    balances: async (accountId) => get(WEBULL_PATHS.balances, { account_id: account(accountId) }),
    /** @param {string} accountId */
    positions: async (accountId) => get(WEBULL_PATHS.positions, { account_id: account(accountId) }),
    /** Open order groups ({ combo_type, orders[] }). @param {string} accountId */
    openOrders: async (accountId) => pages(WEBULL_PATHS.openOrders, { account_id: account(accountId) }),
    /**
     * Order groups placed in [fromMs, toMs] (Webull's default is only the last 7 days).
     * @param {string} accountId @param {number} fromMs @param {number} toMs
     */
    historicalOrders: async (accountId, fromMs, toMs) =>
      pages(WEBULL_PATHS.historicalOrders, {
        account_id: account(accountId),
        start_time: /** @type {string} */ (iso(fromMs)),
        end_time: /** @type {string} */ (iso(toMs)),
      }),
    /**
     * TRADE cash activities in [fromMs, toMs], one request per calendar year the range touches.
     * @param {string} accountId @param {number} fromMs @param {number} toMs
     */
    async tradeActivities(accountId, fromMs, toMs) {
      /** @type {any[]} */
      const out = [];
      for (const [from, to] of splitByYear(fromMs, toMs)) {
        out.push(
          ...(await pages(WEBULL_PATHS.cashActivities, {
            account_id: account(accountId),
            activity_types: "TRADE",
            start_time: /** @type {string} */ (iso(from)),
            end_time: /** @type {string} */ (iso(to)),
          })),
        );
      }
      return out;
    },
  };
}

/** @typedef {ReturnType<typeof createWebullClient>} WebullClient */

