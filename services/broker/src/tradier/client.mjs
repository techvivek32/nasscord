import { badGateway } from "../errors.mjs";
import { collection, quotaExpiry } from "./mapping.mjs";

/**
 * Tradier Brokerage API v1, read calls only (docs/real-backend.md, "Read-only release").
 *
 * - Two hosts that do not share tokens: Live (api.tradier.com, also the OAuth host) and Sandbox
 *   (sandbox.tradier.com, the user's own paper account). A token of one host answers 401 on the
 *   other. BROKER_URL_OVERRIDES {"tradier":{"live":..,"sandbox":..,"oauth":..}} points them at local
 *   fakes outside production only.
 * - The allowlist below is the whole read surface: six GET endpoints. The OAuth engine
 *   (src/oauth2.mjs) calls the two token endpoints with its own one-path allowlist. Order
 *   placement, preview, change and cancel (POST, PUT and DELETE under /orders), the streaming
 *   session and watchlists are refused before any network call. A personal token, and an OAuth
 *   grant with the trade scope, could trade; the allowlist is what keeps Nasscord read-only.
 * - The token travels in the Authorization header, never in a URL.
 * - Rate limits are per token and minute: 120 a minute for account reads and 120 for market data
 *   on Live, 60 each on Sandbox. The buckets are per connection (one token each) and split the same
 *   way (TRADIER_RATE_PER_SEC). Over the limit Tradier answers HTTP 400 "Quota Violation: Expires <ms>"
 *   rather than 429; quotaAwareFetch() turns the stated end into a Retry-After, so src/http.mjs
 *   pauses the bucket until then and answers 429 with that Retry-After.
 * - Nothing here logs: no URL, query, header or body reaches a log line.
 */

/** @typedef {"live" | "sandbox"} TradierHost */

/** Tradier's own hosts. */
export const TRADIER_HOSTS = Object.freeze(
  /** @type {Record<TradierHost, string>} */ ({
    live: "https://api.tradier.com",
    sandbox: "https://sandbox.tradier.com",
  }),
);

/** OAuth 2.0 (partners only): the authorize page and the two token endpoints, on the Live host. */
export const TRADIER_OAUTH_PATHS = Object.freeze({
  authorize: "/v1/oauth/authorize",
  token: "/v1/oauth/accesstoken",
  refresh: "/v1/oauth/refreshtoken",
});

/** What Nasscord asks a Tradier login for: account reads, and market data to value positions. */
export const TRADIER_SCOPE = "read market";

/** An account number as it may appear in a path: letters and digits only. */
export const ACCOUNT_SHAPE = /^[A-Za-z0-9]{1,32}$/;
const ACCT = "[A-Za-z0-9]{1,32}";

/**
 * The read-only allowlist (method, whole-path RegExp).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const TRADIER_READ_ALLOW = Object.freeze([
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/v1\/user\/profile$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v1/accounts/${ACCT}/balances$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v1/accounts/${ACCT}/positions$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v1/accounts/${ACCT}/orders$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/v1/accounts/${ACCT}/history$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/v1\/markets\/quotes$/]),
]);

/**
 * The only non-GET calls Nasscord makes to Tradier: the OAuth token endpoints (src/oauth2.mjs).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const TRADIER_TOKEN_ALLOW = Object.freeze([
  /** @type {import("../http.mjs").AllowRule} */ (["POST", /^\/v1\/oauth\/accesstoken$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["POST", /^\/v1\/oauth\/refreshtoken$/]),
]);

/**
 * Requests a second per bucket. Tradier allows 120 a minute on Live and 60 on Sandbox, per token and
 * per kind (account reads, market data). Reads are cached (15 s balances and positions, 30 s orders,
 * 60 s fills, 10 minutes history), so the steady rate of a connection with two accounts is about 30
 * a minute; the bucket leaves a page load room for its burst, and a Quota Violation still pauses it
 * until Tradier's stated end.
 */
export const TRADIER_RATE_PER_SEC = Object.freeze(/** @type {Record<TradierHost, number>} */ ({ live: 4, sandbox: 2 }));
/** The process-wide bucket of token checks (a pasted token has no connection yet). */
export const TRADIER_CONNECT_BUCKET = "tradier:*:connect";
/** Symbols per quotes call (they travel in the query string). */
export const QUOTE_CHUNK = 100;
/**
 * Orders per page. Without a limit Tradier sends only 25 orders; its docs name 1000 as the way to
 * get "all your orders from this market session in one call". Further pages are read while a page
 * comes back full, up to MAX_ORDER_PAGES.
 */
export const ORDERS_PAGE = 1000;
export const MAX_ORDER_PAGES = 5;
/** Trade events per history page, and the pages one read takes at most (2,000 events). */
export const HISTORY_PAGE = 500;
export const MAX_HISTORY_PAGES = 4;

/**
 * The hosts this server calls. BROKER_URL_OVERRIDES apply outside production only, so a local fake
 * can never stand in for Tradier in front of users.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 * @returns {{ live: string, sandbox: string, oauth: string }}
 */
export function tradierHosts(urls, production) {
  if (production) return { ...TRADIER_HOSTS, oauth: TRADIER_HOSTS.live };
  const live = (urls?.live || TRADIER_HOSTS.live).replace(/\/+$/, "");
  return { live, sandbox: (urls?.sandbox || TRADIER_HOSTS.sandbox).replace(/\/+$/, ""), oauth: (urls?.oauth || live).replace(/\/+$/, "") };
}

/**
 * A fetch that gives Tradier's "Quota Violation" (HTTP 400, plain text) the Retry-After header the
 * shared HTTP client reads, from the stated end (X-Ratelimit-Expiry or the body). Every other
 * answer passes through untouched.
 * @param {typeof fetch} inner
 * @param {() => number} now
 * @returns {typeof fetch}
 */
export function quotaAwareFetch(inner, now) {
  return /** @type {typeof fetch} */ (
    async (input, init) => {
      const res = await inner(input, init);
      if (res.status !== 400 || res.headers.has("retry-after")) return res;
      const text = await res.text().catch(() => "");
      const headers = new Headers(res.headers);
      if (/quota violation/i.test(text)) {
        const end = quotaExpiry(text, res.headers);
        if (end !== null) headers.set("retry-after", String(Math.max(1, Math.ceil((end - now()) / 1000))));
      }
      return new Response(text, { status: res.status, statusText: res.statusText, headers });
    }
  );
}

/** @param {string} id */
function accountSegment(id) {
  if (!ACCOUNT_SHAPE.test(id)) throw new Error("tradier: an account number that is not letters and digits was refused");
  return id;
}

/**
 * @param {{
 *   makeHttp: (o: Omit<import("../http.mjs").BrokerHttpOptions, "limiter" | "fetch" | "now">) => import("../http.mjs").BrokerHttp,
 *   base: string,
 *   token: string,
 *   bucketKey: string,
 *   ratePerSec: number,
 *   timeoutMs?: number,
 * }} o
 */
export function createTradierClient(o) {
  const http = o.makeHttp({
    name: "Tradier",
    base: o.base,
    allow: [...TRADIER_READ_ALLOW],
    // Account reads and market data are counted apart by Tradier, so they are two buckets here.
    bucket: { key: (path) => (path.startsWith("/v1/markets/") ? `${o.bucketKey}:markets` : o.bucketKey), ratePerSec: o.ratePerSec },
    timeoutMs: o.timeoutMs ?? 6_000,
    headers: () => ({ authorization: `Bearer ${o.token}` }),
  });

  return {
    /** For the allowlist tests only. */
    http,

    /** GET /v1/user/profile: the login (profile id) and its accounts. */
    async profile() {
      const json = await http.get("/v1/user/profile");
      if (!json || typeof json !== "object" || !json.profile || typeof json.profile !== "object") throw badGateway("Tradier sent a reply Nasscord could not read.", "broker_reply");
      return json;
    },

    /** GET /v1/accounts/{id}/balances (the whole answer). @param {string} account */
    async balances(account) {
      return http.get(`/v1/accounts/${accountSegment(account)}/balances`);
    },

    /** The account's positions (collapsed arrays normalised). @param {string} account */
    async positions(account) {
      return collection(await http.get(`/v1/accounts/${accountSegment(account)}/positions`), "positions", "position");
    },

    /**
     * Today's orders of the account (Tradier keeps only the present session here), ORDERS_PAGE a
     * page. An order already read on an earlier page is not taken twice, and a page that adds
     * nothing new ends the read (a server that ignored `page` would repeat the first one).
     * @param {string} account
     */
    async orders(account) {
      const path = `/v1/accounts/${accountSegment(account)}/orders`;
      /** @type {any[]} */
      const out = [];
      /** @type {Set<string>} */
      const seen = new Set();
      for (let page = 1; page <= MAX_ORDER_PAGES; page++) {
        const list = collection(await http.get(path, { includeTags: "true", limit: ORDERS_PAGE, page }), "orders", "order");
        let added = 0;
        for (const o of list) {
          const id = typeof o?.id === "number" || typeof o?.id === "string" ? String(o.id) : "";
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          out.push(o);
          added += 1;
        }
        if (list.length < ORDERS_PAGE || added === 0) break;
      }
      return out;
    },

    /**
     * Trade events from `start` to `end` (YYYY-MM-DD, both included), page by page. `complete` is
     * false when MAX_HISTORY_PAGES full pages came back: Tradier may hold more events in the window.
     * @param {string} account @param {string} start @param {string} end
     * @returns {Promise<{ events: any[], complete: boolean }>}
     */
    async history(account, start, end) {
      /** @type {any[]} */
      const events = [];
      for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
        const list = collection(await http.get(`/v1/accounts/${accountSegment(account)}/history`, { type: "trade", start, end, limit: HISTORY_PAGE, page }), "history", "event");
        events.push(...list);
        if (list.length < HISTORY_PAGE) return { events, complete: true };
      }
      return { events, complete: false };
    },

    /**
     * Quotes of these symbols (stocks and OCC option symbols), QUOTE_CHUNK a call. Symbols Tradier
     * does not know are simply missing from the answer.
     * @param {string[]} symbols
     */
    async quotes(symbols) {
      /** @type {any[]} */
      const out = [];
      for (let i = 0; i < symbols.length; i += QUOTE_CHUNK) {
        const chunk = symbols.slice(i, i + QUOTE_CHUNK);
        out.push(...collection(await http.get("/v1/markets/quotes", { symbols: chunk.join(","), greeks: "false" }), "quotes", "quote"));
      }
      return out;
    },
  };
}

/** @typedef {ReturnType<typeof createTradierClient>} TradierClient */
