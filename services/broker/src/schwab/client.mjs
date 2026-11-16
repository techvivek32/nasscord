import { sha256Hex } from "../oauth2.mjs";
import { iso } from "../time.mjs";

/**
 * Charles Schwab Trader API, read calls only (docs/real-backend.md, "Read-only release").
 *
 * - One host for OAuth and the Trader API: https://api.schwabapi.com. BROKER_URL_OVERRIDES
 *   {"schwab":{"api":"http://127.0.0.1:9100"}} points both at a local fake outside production
 *   ("oauth" overrides the OAuth host alone).
 * - Every account path takes the account's hashValue from /accounts/accountNumbers, never the plain
 *   account number.
 * - The allowlist below is the whole surface: five GET endpoints. The token endpoint is called by the
 *   OAuth engine (src/oauth2.mjs) with its own one-path allowlist. Order placement, preview, replace
 *   and cancel (POST/PUT/DELETE under /orders, /previewOrder) are refused before any network call.
 * - Rate limit: Schwab allows about 120 non-order requests a minute per app, so the bucket is per
 *   app (the user's own App Key, by a short hash of it; Nasscord's platform client has one bucket
 *   for everyone). Reads are cached for 10 to 30 seconds, so the steady rate of one app stays far
 *   below that; the bucket leaves a page load room for its burst (4 a second for a user's app, 2 for
 *   the shared platform client), and a 429 from Schwab pauses it (src/http.mjs).
 * - Nothing here logs: no URL, query, header or body reaches a log line (src/http.mjs).
 */

export const SCHWAB_API = "https://api.schwabapi.com";
export const SCHWAB_OAUTH_PATHS = Object.freeze({ authorize: "/v1/oauth/authorize", token: "/v1/oauth/token" });
/** Requests a second per rate bucket: a user's own app, and Nasscord's shared platform client. */
export const SCHWAB_RATE_PER_SEC = Object.freeze({ app: 4, platform: 2 });

/** An account hashValue as it may appear in a path: letters and digits only. */
export const HASH_SHAPE = /^[A-Za-z0-9]{1,128}$/;
const HASH = "[A-Za-z0-9]{1,128}";

/**
 * The read-only allowlist (method, whole-path RegExp).
 * @type {ReadonlyArray<import("../http.mjs").AllowRule>}
 */
export const SCHWAB_READ_ALLOW = Object.freeze([
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/trader\/v1\/accounts\/accountNumbers$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/trader\/v1\/accounts$/]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/trader/v1/accounts/${HASH}/orders$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", new RegExp(`^/trader/v1/accounts/${HASH}/transactions$`)]),
  /** @type {import("../http.mjs").AllowRule} */ (["GET", /^\/trader\/v1\/userPreference$/]),
]);

/** Orders per account per read: Schwab allows a few thousand; 60 days of an active trader fit. */
const MAX_ORDERS = 3000;

/**
 * The rate bucket of one app: "schwab:app:<16 hex of sha256(App Key)>" for a user's own app,
 * "schwab:platform" for Nasscord's client. The key itself never appears.
 * @param {"user" | "platform"} client
 * @param {string} clientId
 */
export function bucketFor(client, clientId) {
  return client === "platform" ? "schwab:platform" : `schwab:app:${sha256Hex(clientId).slice(0, 16)}`;
}

/** @typedef {{ token: string, bucket: string }} SchwabAuth a bearer token and the bucket of its app */

/** @param {string} hash */
function hashSegment(hash) {
  if (!HASH_SHAPE.test(hash)) throw new Error("schwab: an account hash that is not letters and digits was refused");
  return hash;
}

/**
 * @param {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   timeoutMs?: number,
 * }} o
 */
export function createSchwabClient(o) {
  /** @type {Map<string, import("../http.mjs").BrokerHttp>} one client per rate bucket (per app) */
  const clients = new Map();

  /** @param {string} bucket */
  function httpFor(bucket) {
    let c = clients.get(bucket);
    if (!c) {
      if (clients.size >= 1_000) clients.clear();
      c = o.http({
        name: "Schwab",
        base: o.base,
        allow: [...SCHWAB_READ_ALLOW],
        bucket: { key: bucket, ratePerSec: bucket === "schwab:platform" ? SCHWAB_RATE_PER_SEC.platform : SCHWAB_RATE_PER_SEC.app },
        timeoutMs: o.timeoutMs ?? 6_000,
      });
      clients.set(bucket, c);
    }
    return c;
  }

  /**
   * @param {SchwabAuth} auth
   * @param {string} path
   * @param {Record<string, string | number>} [query]
   */
  const get = (auth, path, query) => httpFor(auth.bucket).get(path, query, { headers: { authorization: `Bearer ${auth.token}` } });

  return {
    httpFor,

    /** [{ accountNumber, hashValue }] of the accounts the user shared. @param {SchwabAuth} auth */
    accountNumbers: (auth) => get(auth, "/trader/v1/accounts/accountNumbers"),

    /**
     * [{ securitiesAccount, aggregatedBalance }] of every shared account; positions only when asked.
     * @param {SchwabAuth} auth @param {{ positions?: boolean }} [opt]
     */
    accounts: (auth, opt = {}) => get(auth, "/trader/v1/accounts", opt.positions ? { fields: "positions" } : undefined),

    /**
     * Orders entered in [fromMs, toMs]. Schwab requires both bounds (ISO-8601, at most a year apart).
     * @param {SchwabAuth} auth @param {string} hash @param {number} fromMs @param {number} toMs
     */
    orders: (auth, hash, fromMs, toMs) =>
      get(auth, `/trader/v1/accounts/${hashSegment(hash)}/orders`, {
        fromEnteredTime: /** @type {string} */ (iso(fromMs)),
        toEnteredTime: /** @type {string} */ (iso(toMs)),
        maxResults: MAX_ORDERS,
      }),

    /**
     * TRADE transactions in [fromMs, toMs] (both bounds required, at most a year apart).
     * @param {SchwabAuth} auth @param {string} hash @param {number} fromMs @param {number} toMs
     */
    transactions: (auth, hash, fromMs, toMs) =>
      get(auth, `/trader/v1/accounts/${hashSegment(hash)}/transactions`, {
        types: "TRADE",
        startDate: /** @type {string} */ (iso(fromMs)),
        endDate: /** @type {string} */ (iso(toMs)),
      }),

    /** Account nicknames (only `accounts[].nickName` and `type` are read). @param {SchwabAuth} auth */
    userPreference: (auth) => get(auth, "/trader/v1/userPreference"),
  };
}

/** @typedef {ReturnType<typeof createSchwabClient>} SchwabClient */
