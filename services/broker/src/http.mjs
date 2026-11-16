import { badGateway, BrokerAuthError, HttpError, rateLimited, ReadOnlyViolation } from "./errors.mjs";

/**
 * One HTTP client per broker host for the adapters (contract section "Read-only release").
 *
 * - Allowlist: a request whose method and path are not on `allow` throws ReadOnlyViolation before
 *   any network call. Adapters list their read endpoints and the OAuth token endpoint only, so a key
 *   or a scope that could trade still cannot place an order through Nasscord.
 * - Paths are plain absolute paths ("/v2/account"); the query goes in `query`, never in the path.
 *   "..", "//", backslashes, "?" and "#" in a path are refused.
 * - Rate limits: every call takes a token from the adapter's bucket (and the process-wide one). A
 *   429, or Tradier's "Quota Violation" 400, pauses the bucket (Retry-After or X-Ratelimit-Reset
 *   when sent) and answers rateLimited.
 * - 401/403 -> BrokerAuthError (the adapter decides). Other 4xx -> 502 broker_http. 5xx, timeouts
 *   and network failures -> 502 with the broker's name.
 * - Nothing is logged here: no URL, query, header or body ever reaches a log line.
 */

/**
 * @typedef {[string, RegExp]} AllowRule method and a RegExp the whole path must match
 * @typedef {{
 *   name: string,
 *   base: string,
 *   allow: AllowRule[],
 *   limiter?: import("./limits.mjs").Limiter | null,
 *   bucket?: { key: string | ((path: string) => string), ratePerSec: number } | null,
 *   timeoutMs?: number,
 *   headers?: () => Record<string, string> | Promise<Record<string, string>>,
 *   fetch?: typeof fetch,
 *   now?: () => number,
 * }} BrokerHttpOptions
 * @typedef {{
 *   query?: Record<string, string | number | boolean | null | undefined | Array<string | number>>,
 *   json?: unknown,
 *   form?: Record<string, string | number | boolean | null | undefined>,
 *   headers?: Record<string, string>,
 *   raw?: boolean,
 *   timeoutMs?: number,
 * }} RequestOpts
 * @typedef {{ status: number, headers: Headers, json: any, text: string }} RawResponse
 */

// Dot segments, empty segments, backslashes, query or fragment, whitespace, control characters, and
// the percent-encoded dot, slash and backslash (URL parsers turn "%2e%2e" back into "..").
const BAD_PATH = /(^|\/)\.\.?(\/|$)|\/\/|\\|[?#\s\x00-\x1f]|%2e|%2f|%5c/i;

/**
 * True when `method path` is on the allowlist. Exported for the adapters' own allowlist tests.
 * @param {AllowRule[]} allow
 * @param {string} method
 * @param {string} path
 */
export function isAllowed(allow, method, path) {
  if (typeof path !== "string" || !path.startsWith("/") || BAD_PATH.test(path)) return false;
  const m = method.toUpperCase();
  return allow.some(([am, re]) => am.toUpperCase() === m && fullMatch(re, path));
}

/**
 * The rule must cover the whole path: a rule without ^...$ would otherwise let "/v2/orders" pass as
 * part of "/v2/account/../orders".
 * @param {RegExp} re @param {string} path
 */
function fullMatch(re, path) {
  const m = new RegExp(re.source, re.flags.replace(/[gy]/g, "")).exec(path);
  return !!m && m.index === 0 && m[0].length === path.length;
}

/**
 * Seconds to wait from Retry-After (seconds or an HTTP date) or X-Ratelimit-Reset (epoch seconds).
 * @param {Headers} headers
 * @param {number} nowMs
 */
export function retryAfterMs(headers, nowMs) {
  const ra = headers.get("retry-after");
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n) && n > 0) {
      // Epoch seconds (Tradier, Alpaca) or a delay in seconds (some brokers send that).
      const ms = n > 1e9 ? n * 1000 - nowMs : n * 1000;
      if (ms > 0) return ms;
    }
  }
  return 0;
}

/**
 * @param {BrokerHttpOptions} opts
 */
export function createBrokerHttp(opts) {
  const { name, allow, limiter = null, bucket = null, timeoutMs = 6_000, now = Date.now } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const base = String(opts.base).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(base)) throw new Error(`${name}: the base URL is not an http(s) URL`);
  if (!Array.isArray(allow) || allow.length === 0) throw new Error(`${name}: an allowlist is required`);

  /**
   * @param {string} method
   * @param {string} path
   * @param {RequestOpts} [o]
   * @returns {Promise<any>}
   */
  async function request(method, path, o = {}) {
    const m = method.toUpperCase();
    if (!isAllowed(allow, m, path)) throw new ReadOnlyViolation(name, m);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) qs.set(k, v.join(","));
      else qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.size ? `?${qs.toString()}` : ""}`;

    /** @type {Record<string, string>} */
    const headers = { accept: "application/json", ...(opts.headers ? await opts.headers() : {}), ...(o.headers ?? {}) };
    /** @type {string | undefined} */
    let body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers["content-type"] = "application/json";
    } else if (o.form) {
      const f = new URLSearchParams();
      for (const [k, v] of Object.entries(o.form)) if (v !== undefined && v !== null) f.set(k, String(v));
      body = f.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }

    const key = bucket ? (typeof bucket.key === "function" ? bucket.key(path) : bucket.key) : null;
    if (limiter && bucket && key) await limiter.take(key, bucket.ratePerSec, name);

    const wait = o.timeoutMs ?? timeoutMs;
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(url, { method: m, headers, body, redirect: "manual", signal: AbortSignal.timeout(wait) });
    } catch (e) {
      const n = e instanceof Error ? e.name : "";
      if (n === "TimeoutError" || n === "AbortError") {
        throw badGateway(`${name} did not answer within ${Math.round(wait / 1000)} seconds. Try again in a moment.`, "broker_timeout");
      }
      throw badGateway(`${name} cannot be reached right now. Try again in a moment.`, "broker_unreachable");
    }

    const text = await res.text().catch(() => "");
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    const quota = res.status === 400 && /quota violation/i.test(text);
    if (res.status === 429 || quota) {
      const ms = retryAfterMs(res.headers, now());
      const paused = limiter && key ? limiter.backoff(key, bucket?.ratePerSec, ms) : Math.max(ms, 5_000);
      throw rateLimited(`${name} is limiting requests right now. Try again in a few seconds.`, Math.max(1, Math.ceil(paused / 1000)));
    }
    if (limiter && key) limiter.ok(key);

    if (o.raw) return /** @type {RawResponse} */ ({ status: res.status, headers: res.headers, json, text });

    if (res.status === 401 || res.status === 403) throw new BrokerAuthError(name, res.status);
    if (res.status >= 500) throw badGateway(`${name} is not answering right now (${res.status}). Try again in a moment.`, "broker_down");
    if (res.status >= 300) throw new HttpError(502, `${name} could not answer this request (${res.status}).`, { code: "broker_http" });
    if (text && json === null) throw badGateway(`${name} sent a reply Nasscord could not read.`, "broker_reply");
    return json;
  }

  return {
    name,
    base,
    request,
    /** @param {string} path @param {RequestOpts["query"]} [query] @param {Omit<RequestOpts, "query">} [o] */
    get: (path, query, o = {}) => request("GET", path, { ...o, query }),
    /** @param {string} path @param {RequestOpts} [o] */
    post: (path, o = {}) => request("POST", path, o),
    /** @param {string} method @param {string} path */
    allows: (method, path) => isAllowed(allow, method, path),
  };
}

/** @typedef {ReturnType<typeof createBrokerHttp>} BrokerHttp */
