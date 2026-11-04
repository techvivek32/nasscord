import { badGateway, HttpError, rateLimited } from "../errors.mjs";
import { authorizationHeader, createOAuth1Signer, parseForm, percentEncode } from "./oauth1.mjs";

/**
 * E*TRADE API client for one consumer key (contract section 8).
 * - OAuth endpoints live on api.etrade.com for both production and sandbox keys.
 * - Data calls go to api.etrade.com (production) or apisb.etrade.com (sandbox).
 * - An HTTP 400 with an HTML body is E*TRADE's rate limiter: the bucket backs off and the caller
 *   gets a 429.
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
 * }} opts
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

  return {
    environment,
    apiBase,

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
