import { badGateway, HttpError } from "../errors.mjs";
import { ACCOUNT_ID } from "./mapping.mjs";

/**
 * TradeStation API v3, read calls only (docs/real-backend.md, "Read-only release").
 *
 * - Hosts: sign-in (Auth0) at https://signin.tradestation.com for both environments; the API at
 *   https://api.tradestation.com (Live) or https://sim-api.tradestation.com (SIM, Paper). Outside
 *   production BROKER_URL_OVERRIDES {"tradestation":{"signin":..,"live":..,"sim":..}} point them at
 *   a local fake; in production the overrides are ignored.
 * - The allowlist below is the whole API surface: six GET endpoints. The token endpoint is called by
 *   the OAuth engine (src/oauth2.mjs) with its own one-path allowlist (POST /oauth/token).
 *   /oauth/revoke is never called (it revokes every refresh token of the key), and order entry
 *   (/v3/orderexecution/*) is refused before any network call.
 * - Account ids go in the path, comma-separated, at most 10 per call (TradeStation takes 25).
 * - Rate limits are per user, per key and per resource category: 320 calls per 5 minutes each for
 *   accounts, balances, positions and order details. Each connection gets one bucket per category
 *   at 4 calls a second, which is also its burst, so a read of a few batches and pages goes out at
 *   once instead of one call a second. What keeps a login under 320 per 5 minutes is the read cache
 *   (index.mjs: balances and positions 15 s, today's orders 30 s, closed orders 2 minutes): a few
 *   dozen calls per category per 5 minutes. A 429 still pauses that bucket only.
 * - Time: a call waits at most 6 s (the app waits 8 s for a whole read across every broker).
 *   Balances and positions read their batches at once. Order paging has a time budget
 *   (OrderBudget): a call starts only with enough time left, and when the time runs out the read
 *   keeps what came so far and says so (`cut`).
 * - Nothing here logs: no URL, query, header or body reaches a log line (src/http.mjs).
 */

/** @typedef {"live" | "sim"} TsApiHost */

/** TradeStation's own hosts. Local fakes replace them outside production only (tradestationHosts). */
export const TRADESTATION_HOSTS = Object.freeze({
  signin: "https://signin.tradestation.com",
  live: "https://api.tradestation.com",
  sim: "https://sim-api.tradestation.com",
});

/** The Auth0 audience every TradeStation login asks for (Live and SIM alike). */
export const TRADESTATION_AUDIENCE = "https://api.tradestation.com";
/** Read-only: accounts, balances, positions and orders. Trade is added only when order entry ships. */
export const TRADESTATION_SCOPE = "openid offline_access ReadAccount";
export const TRADESTATION_OAUTH_PATHS = Object.freeze({ authorize: "/authorize", token: "/oauth/token" });

/** Account ids per call (TradeStation allows 25 and recommends 10). */
export const ACCOUNT_BATCH = 10;
/**
 * Calls a second per connection and resource category, and the burst (the bucket holds this many).
 * TradeStation allows 320 per 5 minutes; the read cache keeps a connection far below that.
 */
export const TRADESTATION_RATE_PER_SEC = 4;
/** One call's limit when nothing shorter applies (the app gives a whole read 8 s). */
export const CALL_TIMEOUT_MS = 6_000;
/** A later call of a paged read starts only with at least this much of its budget left. */
export const MIN_CALL_MS = 750;
/** Orders per page (TradeStation's maximum). */
export const PAGE_SIZE = 600;
/** Pages of today's and open orders per batch of accounts (1,200 orders). */
export const MAX_CURRENT_PAGES = 2;
/** Pages of closed orders per batch of accounts (3,000 orders, newest first). */
export const MAX_HISTORY_PAGES = 5;

const IDS = "[A-Za-z0-9][A-Za-z0-9_-]{0,39}(?:,[A-Za-z0-9][A-Za-z0-9_-]{0,39}){0,24}";

/**
 * The read-only allowlist (method, whole-path RegExp).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const TRADESTATION_READ_ALLOW = Object.freeze([
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/v3\/brokerage\/accounts$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v3/brokerage/accounts/${IDS}/balances$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v3/brokerage/accounts/${IDS}/bodbalances$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v3/brokerage/accounts/${IDS}/positions$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v3/brokerage/accounts/${IDS}/orders$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v3/brokerage/accounts/${IDS}/historicalorders$`)]),
]);

/**
 * The hosts this server calls: BROKER_URL_OVERRIDES apply outside production only, so a local fake
 * can never stand in for TradeStation in front of users.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 * @returns {{ signin: string, live: string, sim: string }}
 */
export function tradestationHosts(urls, production) {
  if (production) return { ...TRADESTATION_HOSTS };
  return {
    signin: urls?.signin || TRADESTATION_HOSTS.signin,
    live: urls?.live || TRADESTATION_HOSTS.live,
    sim: urls?.sim || TRADESTATION_HOSTS.sim,
  };
}

/**
 * The rate category of an API path (TradeStation counts each separately).
 * @param {string} path
 */
export function categoryOf(path) {
  if (/\/(bod)?balances$/.test(path)) return "balances";
  if (/\/positions$/.test(path)) return "positions";
  if (/\/(historical)?orders$/.test(path)) return "orders";
  return "accounts";
}

const unreadable = () => badGateway("TradeStation sent a reply Nasscord could not read.", "broker_reply");

/** @param {unknown} v @returns {Record<string, any>} */
function objectOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw unreadable();
  return /** @type {Record<string, any>} */ (v);
}

/** @param {unknown} v @returns {any[]} */
const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * Account ids for a path, checked and in batches of ACCOUNT_BATCH.
 * @param {string[]} ids
 * @returns {string[][]}
 */
export function batches(ids) {
  const unique = [...new Set(ids)];
  for (const id of unique) if (!ACCOUNT_ID.test(id)) throw new Error("tradestation: an account id that is not letters, digits, _ or - was refused");
  /** @type {string[][]} */
  const out = [];
  for (let i = 0; i < unique.length; i += ACCOUNT_BATCH) out.push(unique.slice(i, i + ACCOUNT_BATCH));
  return out;
}

/** "2026-08-18": the date TradeStation's `since` takes. @param {number} ms */
export const sinceDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @typedef {{ items: any[], errors: import("./mapping.mjs").TsError[], cut: null | "pages" | "time" }} Batched
 * - cut (paged reads only): TradeStation had more orders than were read. "pages": a batch reached
 *   the page cap with a NextToken left. "time": the time budget ran out before every page or batch
 *   was read (a slow moment; a later read may get further).
 *
 * The time one order read may take, shared by its calls (today's orders, then closed orders).
 * `calls` counts the calls that answered.
 * @typedef {{ deadline: number, calls: number }} OrderBudget
 */

/**
 * A budget of `ms` from now.
 * @param {() => number} now
 * @param {number} ms
 * @returns {OrderBudget}
 */
export const orderBudget = (now, ms) => ({ deadline: now() + ms, calls: 0 });

/** @param {unknown} e */
const timedOut = (e) => e instanceof HttpError && e.code === "broker_timeout";

/**
 * One connection's API client with one access token.
 * @param {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   token: string,
 *   bucketPrefix: string,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} o
 *   bucketPrefix: "tradestation:<connectionId>" (limiter.forget(connectionId) drops the buckets on
 *   disconnect), or "tradestation:*:connect" for the identity check of a new login.
 *   now: the clock order budgets are measured on (the service's).
 */
export function createTradeStationClient(o) {
  const callTimeoutMs = o.timeoutMs ?? CALL_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  const http = o.http({
    name: "TradeStation",
    base: o.base,
    allow: [...TRADESTATION_READ_ALLOW],
    bucket: { key: (path) => `${o.bucketPrefix}:${categoryOf(path)}`, ratePerSec: TRADESTATION_RATE_PER_SEC },
    timeoutMs: callTimeoutMs,
    headers: () => ({ authorization: `Bearer ${o.token}` }),
  });

  /**
   * One endpoint over every batch of ids, the batches at once (the category's bucket spaces them
   * past its burst): `field` items and Errors[] merged in batch order.
   * @param {string[]} ids @param {string} what path suffix @param {string} field
   * @param {{ timeoutMs?: number }} [opts] a shorter limit per call (for an optional read)
   * @returns {Promise<Batched>}
   */
  async function perBatch(ids, what, field, opts = {}) {
    const bodies = await Promise.all(
      batches(ids).map(async (group) => objectOf(await http.get(`/v3/brokerage/accounts/${group.join(",")}/${what}`, undefined, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}))),
    );
    /** @type {Batched} */
    const out = { items: [], errors: [], cut: null };
    for (const body of bodies) {
      out.items.push(...listOf(body[field]));
      out.errors.push(...listOf(body.Errors));
    }
    return out;
  }

  /**
   * Paged orders over every batch of ids. A nextToken works for the very next request only and
   * lasts an hour, so pages are read one after another.
   *
   * With a budget, a call waits at most the time left (at least MIN_CALL_MS). The read's first call
   * (budget.calls 0) is always made, and its failure is the read's failure. After that, a call
   * starts only with MIN_CALL_MS left, and running out of time (or a call that times out) ends the
   * read with what came so far, marked `cut`.
   * @param {string[]} ids @param {"orders" | "historicalorders"} what
   * @param {Record<string, string | number>} query @param {number} maxPages
   * @param {OrderBudget | undefined} budget
   * @returns {Promise<Batched>}
   */
  async function paged(ids, what, query, maxPages, budget) {
    /** @type {Batched} */
    const out = { items: [], errors: [], cut: null };
    for (const group of batches(ids)) {
      /** @type {string | undefined} */
      let next;
      for (let page = 0; page < maxPages; page++) {
        /** @type {{ timeoutMs?: number }} */
        const opts = {};
        if (budget) {
          const left = budget.deadline - now();
          if (budget.calls > 0 && left < MIN_CALL_MS) {
            out.cut = "time";
            return out;
          }
          opts.timeoutMs = Math.min(callTimeoutMs, Math.max(left, MIN_CALL_MS));
        }
        /** @type {Record<string, any>} */
        let body;
        try {
          body = objectOf(await http.get(`/v3/brokerage/accounts/${group.join(",")}/${what}`, { ...query, pageSize: PAGE_SIZE, nextToken: next }, opts));
        } catch (e) {
          if (budget && budget.calls > 0 && timedOut(e)) {
            out.cut = "time";
            return out;
          }
          throw e;
        }
        if (budget) budget.calls += 1;
        out.items.push(...listOf(body.Orders));
        if (page === 0) out.errors.push(...listOf(body.Errors));
        const token = typeof body.NextToken === "string" ? body.NextToken.trim() : "";
        if (!token || token.length > 2048) break;
        if (page === maxPages - 1) {
          out.cut = "pages";
          break;
        }
        next = token;
      }
    }
    return out;
  }

  return {
    /** For the allowlist tests only. */
    http,

    /** GET /v3/brokerage/accounts: every account under the login. */
    async accounts() {
      const body = objectOf(await http.get("/v3/brokerage/accounts"));
      if (!Array.isArray(body.Accounts)) throw unreadable();
      return body.Accounts;
    },

    /** @param {string[]} ids */
    balances: (ids) => perBatch(ids, "balances", "Balances"),

    /**
     * Beginning-of-day balances (day P&L when TodaysProfitLoss is missing).
     * @param {string[]} ids @param {{ timeoutMs?: number }} [opts]
     */
    bodBalances: (ids, opts) => perBatch(ids, "bodbalances", "BODBalances", opts),

    /** @param {string[]} ids */
    positions: (ids) => perBatch(ids, "positions", "Positions"),

    /**
     * Today's orders and every open order.
     * @param {string[]} ids @param {OrderBudget} [budget]
     */
    orders: (ids, budget) => paged(ids, "orders", {}, MAX_CURRENT_PAGES, budget),

    /**
     * Closed orders since a date (YYYY-MM-DD; TradeStation serves about 90 days), newest first.
     * @param {string[]} ids @param {string} since @param {OrderBudget} [budget]
     */
    historicalOrders: (ids, since, budget) => paged(ids, "historicalorders", { since }, MAX_HISTORY_PAGES, budget),
  };
}

/** @typedef {ReturnType<typeof createTradeStationClient>} TradeStationClient */
