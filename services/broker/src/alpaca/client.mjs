import { createHash } from "node:crypto";
import { badGateway } from "../errors.mjs";
import { clean } from "../mapping.mjs";
import { parseTime } from "../time.mjs";

/**
 * Alpaca Trading API v2 for one account, with that account's own key pair (contract "Connect
 * flows", api_key). Every read goes through createBrokerHttp with the read-only allowlist below:
 * an Alpaca key can trade, so the allowlist is what keeps the reads read-only. Order entry has its
 * own clients and allowlists (createAlpacaTradeClient, at the end), used only by src/alpaca/orders.mjs
 * after the order core's gate. Nothing here logs.
 *
 * - Live and Paper are separate hosts, and a key works on its own host only. Every paper account
 *   has its own key pair and is its own connection.
 * - The key travels in the APCA-API-KEY-ID and APCA-API-SECRET-KEY headers, never in a URL.
 * - Alpaca allows 200 requests a minute per account, shared with any bot the user runs on it. The
 *   bucket is 3 a second per connection, and the read cache (15 s balances and positions, 30 s
 *   orders and fills) keeps a polling terminal at about 8 calls a minute. A key check (Connect,
 *   Reconnect with a new key) has a bucket of its own key pair (keyCheckTag), never a shared one:
 *   a 429 on one user's account pauses only that pair.
 */

/** @typedef {"live" | "paper"} AlpacaHost */

/** Alpaca's own hosts. Local fakes replace them outside production only (alpacaHosts). */
export const ALPACA_HOSTS = Object.freeze(
  /** @type {Record<AlpacaHost, string>} */ ({
    live: "https://api.alpaca.markets",
    paper: "https://paper-api.alpaca.markets",
  }),
);

/**
 * The read endpoints, and nothing else: no order, position, watchlist or configuration change.
 * Alpaca key auth has no token endpoint.
 * @type {import("../http.mjs").AllowRule[]}
 */
export const ALPACA_READ_ALLOW = /** @type {import("../http.mjs").AllowRule[]} */ (
  Object.freeze([
    Object.freeze(["GET", /^\/v2\/account$/]),
    Object.freeze(["GET", /^\/v2\/positions$/]),
    Object.freeze(["GET", /^\/v2\/orders$/]),
    Object.freeze(["GET", /^\/v2\/account\/activities(\/FILL)?$/]),
    Object.freeze(["GET", /^\/v2\/account\/portfolio\/history$/]),
  ])
);

/** Requests a second per connection (Alpaca: 200 a minute per account). */
export const ALPACA_RATE_PER_SEC = 3;
export const ORDER_PAGE = 500;
export const FILL_PAGE = 100;
/** At most 2,000 open orders, 2,000 recent orders and 1,000 fills a read (4, 4 and 10 calls), so a
 * busy account cannot spend the 200-a-minute budget it shares with the user's own tools. */
const MAX_OPEN_PAGES = 4;
const MAX_ORDER_PAGES = 4;
const MAX_FILL_PAGES = 10;

/**
 * The tag of the bucket that checks one key pair (a new key has no connection yet): a hash of the
 * pair, never the key itself. Alpaca's limit belongs to each account, so a 429 pauses the checks of
 * that pair only. The bucket key is `alpaca:<tag>`; limiter.forget(tag) drops it.
 * @param {string} keyId
 * @param {string} secretKey
 */
export function keyCheckTag(keyId, secretKey) {
  return `keycheck-${createHash("sha256").update(`${keyId}\n${secretKey}`).digest("hex").slice(0, 24)}`;
}

/**
 * The hosts this server calls: BROKER_URL_OVERRIDES ({"alpaca":{"live":..,"paper":..}}) apply
 * outside production only, so a local fake can never stand in for Alpaca in front of users.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 * @returns {Record<AlpacaHost, string>}
 */
export function alpacaHosts(urls, production) {
  if (production) return { ...ALPACA_HOSTS };
  return { live: urls?.live || ALPACA_HOSTS.live, paper: urls?.paper || ALPACA_HOSTS.paper };
}

/** Alpaca's market data host: one host for live and paper keys (order entry quotes only). */
export const ALPACA_DATA_HOST = "https://data.alpaca.markets";

/**
 * The market data host this server calls: BROKER_URL_OVERRIDES.alpaca.data outside production only.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 */
export function alpacaDataHost(urls, production) {
  if (production) return ALPACA_DATA_HOST;
  return urls?.data || ALPACA_DATA_HOST;
}

// ── Order entry (src/alpaca/orders.mjs, docs/real-backend.md section 13). The read client above and
// ALPACA_READ_ALLOW do not change: the order core builds this trading client only after its gate.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The trading reads and the cancel of one order. Never: DELETE /v2/orders (cancel all), DELETE
 * /v2/positions and /v2/positions/{id} (close), any PATCH (replace, configurations), watchlists,
 * options, crypto.
 * @type {import("../http.mjs").AllowRule[]}
 */
export const ALPACA_TRADE_ALLOW = /** @type {import("../http.mjs").AllowRule[]} */ (
  Object.freeze([
    Object.freeze(["GET", /^\/v2\/account$/]),
    Object.freeze(["GET", /^\/v2\/clock$/]),
    Object.freeze(["GET", /^\/v2\/assets\/[A-Z][A-Z0-9.]{0,9}$/]),
    Object.freeze(["GET", new RegExp(`^/v2/positions/${UUID}$`)]),
    Object.freeze(["GET", /^\/v2\/orders$/]),
    Object.freeze(["GET", new RegExp(`^/v2/orders/${UUID}$`)]),
    Object.freeze(["GET", /^\/v2\/orders:by_client_order_id$/]),
    Object.freeze(["DELETE", new RegExp(`^/v2/orders/${UUID}$`)]),
  ])
);

/**
 * The one order write. Its client has no rate bucket: orders.mjs takes the token itself before the POST,
 * so a limiter refusal is "not sent" and a 429 the POST answers can only be Alpaca's own.
 * @type {import("../http.mjs").AllowRule[]}
 */
export const ALPACA_SEND_ALLOW = /** @type {import("../http.mjs").AllowRule[]} */ (Object.freeze([Object.freeze(["POST", /^\/v2\/orders$/])]));

/** The latest quote of one symbol on the market data host. @type {import("../http.mjs").AllowRule[]} */
export const ALPACA_DATA_ALLOW = /** @type {import("../http.mjs").AllowRule[]} */ (
  Object.freeze([Object.freeze(["GET", /^\/v2\/stocks\/[A-Z][A-Z0-9.]{0,9}\/quotes\/latest$/])])
);

/**
 * The order entry clients of one Alpaca key: `trade` (reads and the cancel, on the connection's bucket),
 * `send` (POST /v2/orders only, no bucket) and `data` (quotes, a bucket of its own). Every call of the
 * trading part uses `raw: true`, so Alpaca's 403 and 422 bodies are read and never expire the connection.
 * @param {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   dataBase: string,
 *   keyId: string,
 *   secretKey: string,
 *   bucketKey: string,
 * }} o
 */
export function createAlpacaTradeClient(o) {
  const headers = () => ({ "APCA-API-KEY-ID": o.keyId, "APCA-API-SECRET-KEY": o.secretKey });
  return {
    trade: o.http({ name: "Alpaca", base: o.base, allow: ALPACA_TRADE_ALLOW, bucket: { key: o.bucketKey, ratePerSec: ALPACA_RATE_PER_SEC }, headers, timeoutMs: 10_000 }),
    send: o.http({ name: "Alpaca", base: o.base, allow: ALPACA_SEND_ALLOW, bucket: null, headers, timeoutMs: 10_000 }),
    data: o.http({ name: "Alpaca market data", base: o.dataBase, allow: ALPACA_DATA_ALLOW, bucket: { key: `${o.bucketKey}:data`, ratePerSec: 3 }, headers, timeoutMs: 5_000 }),
  };
}

/** @typedef {ReturnType<typeof createAlpacaTradeClient>} AlpacaTradeClient */

const unreadable = () => badGateway("Alpaca sent a reply Nasscord could not read.", "broker_reply");

/** @param {unknown} v @returns {any[]} */
function listOf(v) {
  if (!Array.isArray(v)) throw unreadable();
  return v;
}

/**
 * @param {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   keyId: string,
 *   secretKey: string,
 *   bucketKey: string,
 * }} o
 */
export function createAlpacaClient(o) {
  const http = o.http({
    name: "Alpaca",
    base: o.base,
    allow: ALPACA_READ_ALLOW,
    bucket: { key: o.bucketKey, ratePerSec: ALPACA_RATE_PER_SEC },
    headers: () => ({ "APCA-API-KEY-ID": o.keyId, "APCA-API-SECRET-KEY": o.secretKey }),
  });

  /**
   * Orders newest first, paged by `until`. `until` is exclusive and Alpaca's timestamps carry
   * microseconds, so the next page asks up to 1 ms past the oldest order seen and drops repeats:
   * an order sharing that millisecond is read again rather than skipped.
   * @param {Record<string, string | number | undefined>} query with `nested` ("true" or "false")
   * @param {number} maxPages
   */
  async function orderPages(query, maxPages) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {any[]} */
    const out = [];
    /** @type {string | undefined} */
    let until;
    for (let page = 0; page < maxPages; page++) {
      const list = listOf(await http.get("/v2/orders", { ...query, limit: ORDER_PAGE, direction: "desc", until }));
      let fresh = 0;
      /** @type {number | null} */
      let oldest = null;
      for (const order of list) {
        const id = clean(order?.id);
        const t = parseTime(order?.submitted_at) ?? parseTime(order?.created_at);
        if (t !== null && (oldest === null || t < oldest)) oldest = t;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(order);
        fresh++;
      }
      if (list.length < ORDER_PAGE || fresh === 0 || oldest === null) break;
      until = new Date(oldest + 1).toISOString();
    }
    return out;
  }

  return {
    /** For the allowlist tests only. */
    http,

    /** GET /v2/account: the key's one account (its id names the login). */
    async account() {
      const a = await http.get("/v2/account");
      if (!a || typeof a !== "object" || Array.isArray(a) || !clean(a.id)) throw unreadable();
      return a;
    },

    /** GET /v2/positions */
    async positions() {
      return listOf(await http.get("/v2/positions"));
    },

    /**
     * Every open order, however old (a GTC order can be months old), plus every order submitted
     * since `sinceIso`. Duplicates are left for the mapping to merge.
     * - Open orders are read flat (nested=false): an open leg of an older bracket or OTO whose
     *   entry has filled then comes back as an order of its own, where under its filled parent it
     *   would be left out. They are paged by `until` as well (newest first, up to MAX_OPEN_PAGES).
     * - Recent orders are nested, so their legs know their parent (the mapping keeps that copy).
     * @param {string} sinceIso
     */
    async orders(sinceIso) {
      const open = await orderPages({ status: "open", nested: "false" }, MAX_OPEN_PAGES);
      const recent = await orderPages({ status: "all", after: sinceIso, nested: "true" }, MAX_ORDER_PAGES);
      return [...open, ...recent];
    },

    /**
     * FILL activities (fills and partial fills) since `sinceIso`, newest first, paged by
     * page_token (the id of the last activity of the previous page).
     * @param {string} sinceIso
     */
    async fills(sinceIso) {
      /** @type {Set<string>} */
      const seen = new Set();
      /** @type {any[]} */
      const out = [];
      /** @type {string | undefined} */
      let token;
      for (let page = 0; page < MAX_FILL_PAGES; page++) {
        const list = listOf(await http.get("/v2/account/activities/FILL", { direction: "desc", page_size: FILL_PAGE, after: sinceIso, page_token: token }));
        let fresh = 0;
        for (const a of list) {
          const id = clean(a?.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(a);
          fresh++;
        }
        if (list.length < FILL_PAGE || fresh === 0) break;
        token = clean(list[list.length - 1]?.id) || undefined;
        if (!token) break;
      }
      return out;
    },
  };
}

/** @typedef {ReturnType<typeof createAlpacaClient>} AlpacaClient */
