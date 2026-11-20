import { badGateway, HttpError, rateLimited, ReadOnlyViolation } from "../errors.mjs";
import { isAllowed } from "../http.mjs";
import { authorizationHeader, createOAuth1Signer, parseForm, percentEncode } from "./oauth1.mjs";

/**
 * E*TRADE API client for one consumer key (contract section 8).
 * - OAuth endpoints live on api.etrade.com for both production and sandbox keys.
 * - Data calls go to api.etrade.com (production) or apisb.etrade.com (sandbox).
 * - An HTTP 400 with an HTML body is E*TRADE's rate limiter: the bucket backs off and the caller
 *   gets a 429.
 * - Reads use signedGet (GET only). Order calls (docs/real-backend.md section 13) use signedSend, which
 *   sends only what ETRADE_WRITE_ALLOW lists, sends once, never retries, and never throws once the
 *   request has started to go out: it answers what happened instead.
 */

/**
 * The only E*TRADE calls that are not reads: order preview, place and cancel. Only the trading part
 * (src/etrade/orders.mjs) calls signedSend, from the order core, after the workspace switch.
 */
export const ETRADE_WRITE_ALLOW = /** @type {import("../http.mjs").AllowRule[]} */ (
  Object.freeze([
    ["POST", /^\/v1\/accounts\/[A-Za-z0-9_-]{1,64}\/orders\/preview\.json$/],
    ["POST", /^\/v1\/accounts\/[A-Za-z0-9_-]{1,64}\/orders\/place\.json$/],
    ["PUT", /^\/v1\/accounts\/[A-Za-z0-9_-]{1,64}\/orders\/cancel\.json$/],
  ])
);

/** @typedef {"PreviewOrderRequest" | "PlaceOrderRequest" | "CancelOrderRequest"} OrderBodyRoot */

/** @param {string} s */
const xmlText = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * One element per key in insertion order; an array repeats its element once per item; an object
 * nests; a string, number or boolean is escaped text; null and undefined are left out.
 * @param {Record<string, unknown>} value
 * @returns {string}
 */
function toXml(value) {
  let out = "";
  for (const [key, v] of Object.entries(value)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (item === null || item === undefined) continue;
      if (typeof item === "object") out += `<${key}>${toXml(/** @type {Record<string, unknown>} */ (item))}</${key}>`;
      else out += `<${key}>${xmlText(String(item))}</${key}>`;
    }
  }
  return out;
}

/**
 * The body of an order call. E*TRADE's v1 docs name no request content type; its own samples and
 * clients send XML to the ".json" paths, so XML is the default and JSON a switch
 * (ETRADE_ORDER_BODY). The path keeps ".json" either way, so answers come back as JSON.
 * @param {OrderBodyRoot} root
 * @param {Record<string, unknown>} value
 * @param {"xml" | "json"} [format]
 * @returns {{ contentType: string, body: string }}
 */
export function encodeOrderBody(root, value, format = "xml") {
  if (format === "json") return { contentType: "application/json", body: JSON.stringify({ [root]: value }) };
  return { contentType: "application/xml", body: `<${root}>${toXml(value)}</${root}>` };
}

/** @param {string} s */
const xmlUnescape = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * E*TRADE's error body: JSON ({ "Error": { code, message } }, also "error") or XML (<code>, <message>).
 * The message is cut to 200 characters.
 * @param {string} text
 * @returns {{ code: number | null, message: string | null }}
 */
export function parseEtradeError(text) {
  const s = typeof text === "string" ? text : "";
  /** @param {unknown} c */
  const codeOf = (c) => {
    const n = typeof c === "number" ? c : typeof c === "string" && /^\s*-?\d+\s*$/.test(c) ? Number(c) : NaN;
    return Number.isSafeInteger(n) ? n : null;
  };
  /** @param {unknown} m */
  const messageOf = (m) => (typeof m === "string" && m.trim() ? m.trim().slice(0, 200).trim() : null);
  try {
    const j = JSON.parse(s);
    const err = j && typeof j === "object" ? (j.Error ?? j.error) : null;
    if (err && typeof err === "object") return { code: codeOf(err.code), message: messageOf(err.message) };
  } catch {
    /* not JSON */
  }
  const code = /<code>\s*(-?\d+)\s*<\/code>/i.exec(s);
  const message = /<message>([^<]*)<\/message>/i.exec(s);
  return { code: code ? codeOf(code[1]) : null, message: message ? messageOf(xmlUnescape(message[1])) : null };
}

/**
 * What an order call answered (signedSend never throws once the request has started to go out).
 * @typedef {(
 *   { kind: "ok", status: number, json: any }
 *   | { kind: "rejected", status: number, code: number, message: string | null }
 *   | { kind: "rate_limited" }
 *   | { kind: "auth", problem: string }
 *   | { kind: "unknown", reason: string, code?: number | null, message?: string | null }
 * )} SendResult
 */

/**
 * @typedef {{
 *   oauthBase: string,
 *   apiBase: { production: string, sandbox: string },
 *   authorizeUrl: string,
 * }} EtradeUrls
 * @typedef {{ token: string, secret: string }} TokenPair
 */

export const ETRADE_URLS = Object.freeze({
  oauthBase: "https://api.etrade.com",
  apiBase: Object.freeze({ production: "https://api.etrade.com", sandbox: "https://apisb.etrade.com" }),
  authorizeUrl: "https://us.etrade.com/e/t/etws/authorize",
});

/** E*TRADE rejected the token or the key (HTTP 401). `problem` is E*TRADE's oauth_problem. */
export class EtradeAuthError extends HttpError {
  /** @param {string} problem */
  constructor(problem) {
    super(409, "E*TRADE ended the session. Reconnect to continue.", { code: "etrade_auth" });
    this.name = "EtradeAuthError";
    this.problem = problem || "unauthorized";
  }
}

/**
 * Where a path belongs for E*TRADE's per-module rate limits.
 * @param {string} path
 */
export function etradeModule(path) {
  if (path.startsWith("/oauth/")) return "oauth";
  if (path.startsWith("/v1/market/")) return "market";
  if (/\/orders(\/|$|\?)/.test(path)) return "order";
  return "accounts";
}

/**
 * Reads oauth_problem out of a 401 body or WWW-Authenticate header.
 * @param {string} body
 * @param {string | null} wwwAuth
 */
function oauthProblem(body, wwwAuth) {
  const fromBody = /oauth_problem=([a-z_]+)/i.exec(body ?? "");
  if (fromBody) return fromBody[1];
  const fromHeader = /oauth_problem="?([a-z_]+)/i.exec(wwwAuth ?? "");
  return fromHeader ? fromHeader[1] : "";
}

/**
 * @param {{
 *   environment: "production" | "sandbox",
 *   consumerKey: string,
 *   consumerSecret: string,
 *   connectionId: string,
 *   urls?: EtradeUrls,
 *   fetch?: typeof fetch,
 *   signer?: import("./oauth1.mjs").OAuth1Signer,
 *   limiter?: import("../limits.mjs").Limiter,
 *   timeoutMs?: number,
 *   orderBody?: "xml" | "json",
 * }} opts
 *   orderBody: the request body format of order calls (ETRADE_ORDER_BODY), XML unless set.
 */
export function createEtradeClient(opts) {
  const {
    environment,
    consumerKey,
    consumerSecret,
    connectionId,
    urls = ETRADE_URLS,
    fetch: doFetch = globalThis.fetch,
    signer = createOAuth1Signer(),
    limiter,
    timeoutMs = 15_000,
    orderBody = "xml",
  } = opts;
  if (environment !== "production" && environment !== "sandbox") throw new Error("environment must be production or sandbox");
  const apiBase = urls.apiBase[environment];

  /**
   * One signed GET.
   * @param {string} base
   * @param {string} path
   * @param {{ query?: Record<string, string | number | boolean>, token?: string, tokenSecret?: string, extra?: Record<string, string>, accept?: string }} [o]
   */
  async function signedGet(base, path, o = {}) {
    const qs = Object.entries(o.query ?? {})
      .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
      .join("&");
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;
    const module = etradeModule(path);
    const bucketKey = `etrade:${connectionId}:${module}`;
    if (limiter) await limiter.etrade(connectionId, module);

    const { params } = signer.sign({
      method: "GET",
      url,
      consumerKey,
      consumerSecret,
      token: o.token,
      tokenSecret: o.tokenSecret,
      extra: o.extra,
    });

    let res;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: {
          authorization: authorizationHeader(params, ""),
          accept: o.accept ?? "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw badGateway("E*TRADE did not respond. Try again in a moment.", "etrade_network", e);
    }
    const body = await res.text();
    const type = res.headers.get("content-type") ?? "";

    if (res.status === 400 && (/html/i.test(type) || /^\s*</.test(body))) {
      const ms = limiter ? limiter.backoff(bucketKey) : 5_000;
      throw rateLimited("E*TRADE is limiting requests right now. Try again in a few seconds.", Math.ceil(ms / 1000));
    }
    if (res.status === 401) throw new EtradeAuthError(oauthProblem(body, res.headers.get("www-authenticate")));
    if (res.status === 204) {
      limiter?.ok(bucketKey);
      return { status: 204, body: "", type };
    }
    if (!res.ok) {
      let detail = "";
      try {
        const j = JSON.parse(body);
        const err = j.Error ?? j.error ?? j;
        if (err && typeof err.message === "string") detail = ` E*TRADE said: ${err.message.slice(0, 160)}`;
      } catch {
        /* not JSON */
      }
      throw badGateway(`E*TRADE answered with an error (${res.status}).${detail}`, "etrade_http");
    }
    limiter?.ok(bucketKey);
    return { status: res.status, body, type };
  }

  /** @param {string} body */
  function tokenPair(body) {
    const map = new Map(parseForm(body.trim()));
    const token = map.get("oauth_token");
    const secret = map.get("oauth_token_secret");
    if (!token || !secret) throw badGateway("E*TRADE did not return a token. Check the consumer key and secret.", "etrade_token");
    return { token, secret };
  }

  /**
   * One signed order call (preview, place or cancel). It throws only before the request goes out: a
   * method or path off ETRADE_WRITE_ALLOW (ReadOnlyViolation) or the limiter (429). From the fetch on
   * it answers what happened, sends once and never retries.
   * @param {string} method
   * @param {string} path without a query
   * @param {TokenPair} t the access token
   * @param {{ root: OrderBodyRoot, value: Record<string, unknown> }} payload
   * @param {{ timeoutMs?: number, timeLeft?: () => number, minLeftMs?: number }} [o]
   *   timeLeft: what is left of the caller's deadline, measured again after the limiter's wait. Under
   *   `minLeftMs` (default 1 ms) nothing is sent: HttpError 504 with code "not_sent". Else the timeout
   *   is at most what is left, so no call starts after the deadline (design 1.10).
   * @returns {Promise<SendResult>}
   */
  async function signedSend(method, path, { token, secret }, { root, value }, { timeoutMs: sendTimeoutMs = 15_000, timeLeft, minLeftMs = 1 } = {}) {
    const m = String(method ?? "").toUpperCase();
    if (!isAllowed(ETRADE_WRITE_ALLOW, m, path)) throw new ReadOnlyViolation("E*TRADE", m);
    const bucketKey = `etrade:${connectionId}:order`;
    if (limiter) await limiter.etrade(connectionId, "order");
    if (typeof timeLeft === "function") {
      const left = timeLeft();
      if (!(left >= Math.max(1, minLeftMs))) throw new HttpError(504, "No time was left to send this call to E*TRADE.", { code: "not_sent" });
      sendTimeoutMs = Math.min(Number.isFinite(sendTimeoutMs) ? sendTimeoutMs : 15_000, left);
    }
    const url = `${apiBase}${path}`;
    const { contentType, body } = encodeOrderBody(root, value, orderBody);
    // The XML or JSON body is not part of the OAuth 1.0a base string (RFC 5849 3.4.1.3.1).
    const { params } = signer.sign({ method: m, url, consumerKey, consumerSecret, token, tokenSecret: secret });
    const headers = { authorization: authorizationHeader(params, ""), accept: "application/json", "content-type": contentType };
    const ms = Math.max(1, Math.floor(Number.isFinite(sendTimeoutMs) ? sendTimeoutMs : 15_000));

    // From here on nothing throws: the request may have reached E*TRADE.
    /** @type {Response} */
    let res;
    let text = "";
    try {
      res = await doFetch(url, { method: m, headers, body, redirect: "manual", signal: AbortSignal.timeout(ms) });
      text = await res.text();
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? e.name : "";
      return { kind: "unknown", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
    }
    try {
      const status = res.status;
      if (status === 400 && /exceeded the rate limit/i.test(text)) {
        // E*TRADE does not process a rate-limited request.
        limiter?.backoff(bucketKey);
        return { kind: "rate_limited" };
      }
      if (status === 401) return { kind: "auth", problem: oauthProblem(text, res.headers.get("www-authenticate")) || "unauthorized" };
      if (status >= 200 && status < 300) {
        /** @type {any} */
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        if (!json || typeof json !== "object") return { kind: "unknown", reason: "unreadable" };
        limiter?.ok(bucketKey);
        return { kind: "ok", status, json };
      }
      const err = parseEtradeError(text);
      if (status >= 400 && status < 500 && err.code !== null) return { kind: "rejected", status, code: err.code, message: err.message };
      return { kind: "unknown", reason: `status_${status}`, code: err.code, message: err.message };
    } catch {
      return { kind: "unknown", reason: "unreadable" };
    }
  }

  return {
    environment,
    apiBase,
    signedSend,

    /**
     * Step 1: request token with oauth_callback=oob. Lives 5 minutes.
     * @returns {Promise<TokenPair>}
     */
    async requestToken() {
      const r = await signedGet(urls.oauthBase, "/oauth/request_token", {
        extra: { oauth_callback: "oob" },
        accept: "*/*",
      });
      return tokenPair(r.body);
    },

    /**
     * Step 2: the page where the user approves access and reads the verification code.
     * @param {string} requestToken
     */
    authorizeUrl(requestToken) {
      return `${urls.authorizeUrl}?key=${encodeURIComponent(consumerKey)}&token=${encodeURIComponent(requestToken)}`;
    },

    /**
     * Step 3: exchange the request token and the code for an access token.
     * @param {TokenPair & { verifier: string }} t
     * @returns {Promise<TokenPair>}
     */
    async accessToken({ token, secret, verifier }) {
      const r = await signedGet(urls.oauthBase, "/oauth/access_token", {
        token,
        tokenSecret: secret,
        extra: { oauth_verifier: verifier },
        accept: "*/*",
      });
      return tokenPair(r.body);
    },

    /** Same-day renewal; also wakes a token idle for 2 hours. @param {TokenPair} t */
    async renewAccessToken({ token, secret }) {
      await signedGet(urls.oauthBase, "/oauth/renew_access_token", { token, tokenSecret: secret, accept: "*/*" });
    },

    /** @param {TokenPair} t */
    async revokeAccessToken({ token, secret }) {
      await signedGet(urls.oauthBase, "/oauth/revoke_access_token", { token, tokenSecret: secret, accept: "*/*" });
    },

    /**
     * A signed JSON read on the API host. Returns null for 204 (E*TRADE's "nothing here").
     * @param {string} path e.g. "/v1/accounts/list"
     * @param {TokenPair} t
     * @param {Record<string, string | number | boolean>} [query]
     */
    async getJson(path, { token, secret }, query) {
      const r = await signedGet(apiBase, path, { token, tokenSecret: secret, query });
      if (r.status === 204 || !r.body.trim()) return null;
      try {
        return JSON.parse(r.body);
      } catch {
        throw badGateway("E*TRADE sent an answer the service could not read. Try again.", "etrade_parse");
      }
    },
  };
}

/** @typedef {ReturnType<typeof createEtradeClient>} EtradeClient */
