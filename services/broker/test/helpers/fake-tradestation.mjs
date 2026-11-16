import { randomBytes } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake TradeStation for the adapter tests: an Auth0-style sign-in host and the v3 API on a Live
 * and a SIM host. It behaves like the real one where the adapter depends on it:
 *
 * Sign-in (signin):
 * - GET /authorize needs response_type=code, a known client_id, audience=https://api.tradestation.com,
 *   a scope with openid, and a redirect_uri on the key's Allowed Callback URLs. A new key allows only
 *   TradeStation's localhost defaults, so Nasscord's callback must be added (addCallback). An unknown
 *   key or a callback that is not allowed gets TradeStation's own error page (400), no redirect.
 * - POST /oauth/token (form body, client_id and client_secret in it): authorization_code (single use,
 *   60 s, same redirect_uri) and refresh_token. offline_access gives a refresh token. A rotating key
 *   answers a new refresh token on every refresh, kills the old one, and refuses a refresh token
 *   unused for 30 minutes or a login older than 24 hours (403 invalid_grant). A wrong secret is
 *   401 access_denied, as Auth0 answers it.
 * - POST /oauth/revoke kills every refresh token of the key, and is counted (the adapter never calls it).
 *
 * API (live, sim): GET /v3/brokerage/accounts and /v3/brokerage/accounts/{ids}/{balances,
 * bodbalances, positions, orders, historicalorders} with comma-separated ids (at most 25), Errors[]
 * entries for ids the login does not have (or set in `errors`), paging with single-use NextTokens,
 * and 429 knobs per resource category. Anything else is counted as a trade call and refused.
 *
 * The clock is the test's (opts.now), so tokens expire when the test moves time. Every request is
 * recorded as host, method and path only: never a query or a body.
 */

export const TS_DEFAULT_CALLBACKS = Object.freeze([
  "http://localhost",
  "http://localhost:80",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:8080",
  "http://localhost:31022",
]);
const AUDIENCE = "https://api.tradestation.com";
const ACCESS_TTL_SEC = 1200;
const CODE_TTL_MS = 60_000;
const ROTATION_IDLE_MS = 30 * 60_000;
const ROTATION_ABSOLUTE_MS = 24 * 3_600_000;

/** @typedef {"live" | "sim"} EnvName */
/**
 * @typedef {{
 *   accounts: any[],
 *   balances: any[],
 *   bodBalances: any[],
 *   positions: any[],
 *   orders: any[],
 *   history: any[],
 *   errors: Map<string, { Error: string, Message: string }>,
 * }} EnvData
 */

/** @returns {EnvData} */
const emptyEnv = () => ({ accounts: [], balances: [], bodBalances: [], positions: [], orders: [], history: [], errors: new Map() });

/** A mixed-case Auth0-style client id (32 letters and digits). */
export function auth0ClientId() {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(32), (b) => abc[b % abc.length]).join("");
}

/**
 * @param {{ now?: () => number }} [opts]
 */
export async function startFakeTradeStation(opts = {}) {
  const now = () => (opts.now ? opts.now() : Date.now());
  const tok = () => randomBytes(24).toString("base64url");

  const state = {
    /** @type {Map<string, { secret: string, callbacks: Set<string>, rotate: boolean, scopes: string[] | null, offline: boolean }>} */
    keys: new Map(),
    /** @type {Map<string, { live: EnvData, sim: EnvData }>} */
    users: new Map(),
    /** the TradeStation login that approves the next authorize */
    loginAs: "ts-user-1",
    deny: false,
    sendIdToken: true,
    /** @type {Map<string, { clientId: string, redirectUri: string, sub: string, scope: string, at: number, used: boolean }>} */
    codes: new Map(),
    /** @type {Map<string, { clientId: string, sub: string, scope: string, loginAt: number, issuedAt: number }>} */
    refresh: new Map(),
    /** @type {Map<string, { clientId: string, sub: string, exp: number }>} */
    access: new Map(),
    /** @type {Array<{ host: string, method: string, path: string }>} */
    calls: [],
    /** every token, code and secret this fake handed out (none may leak) */
    /** @type {string[]} */
    issued: [],
    tokenCalls: 0,
    refreshCalls: 0,
    /** @type {Map<string, number>} refresh grants per client id */
    refreshCallsBy: new Map(),
    revokeCalls: 0,
    tradeCalls: 0,
    /** @type {{ status: number, body: unknown } | null} the next /oauth/token answer */
    failToken: /** @type {{ status: number, body: unknown } | null} */ (null),
    /** every API call answers 401 while set (TradeStation refusing the login) */
    refuseApi: false,
    /** @type {Set<string>} endpoints ("bodbalances", "positions", ...) that answer 403 while listed */
    forbidden: new Set(),
    /** category -> the next n calls answer 429 */
    /** @type {Map<string, number>} */
    rateLimit: new Map(),
    /** at most this many orders per page, whatever pageSize asks */
    pageCap: 600,
    maxIdsSeen: 0,
    /** @type {string[]} the `since` of every historicalorders call */
    sinceSeen: [],
    /** @type {Map<string, string>} next token -> "<host>|<path>|<offset>" */
    pages: new Map(),
  };

  /** @param {string} sub */
  function user(sub) {
    let u = state.users.get(sub);
    if (!u) {
      u = { live: emptyEnv(), sim: emptyEnv() };
      state.users.set(sub, u);
    }
    return u;
  }

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} text */
  const page = (res, status, text) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(`<!doctype html><title>TradeStation</title><p>${text}</p>`);
  };

  /** @param {string} sub @param {string} scope */
  function idToken(sub, scope) {
    const enc = (/** @type {unknown} */ v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    return `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ sub, aud: "client", iss: "https://signin.tradestation.com/", scope })}.c2ln`;
  }

  /** @param {string} clientId @param {string} sub @param {string} scope */
  function issueAccess(clientId, sub, scope) {
    const access = tok();
    state.access.set(access, { clientId, sub, exp: now() + ACCESS_TTL_SEC * 1000 });
    state.issued.push(access);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SEC, scope };
  }

  /** @param {string} clientId @param {string} sub @param {string} scope @param {number} loginAt */
  function issueRefresh(clientId, sub, scope, loginAt) {
    const r = tok();
    state.refresh.set(r, { clientId, sub, scope, loginAt, issuedAt: now() });
    state.issued.push(r);
    return r;
  }

  // ── sign-in host

  const signin = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    state.calls.push({ host: "signin", method: req.method ?? "GET", path: url.pathname });
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && url.pathname === "/authorize") {
        const q = url.searchParams;
        const key = state.keys.get(q.get("client_id") ?? "");
        if (!key) return page(res, 400, "Unknown client");
        const redirectUri = q.get("redirect_uri") ?? "";
        if (!key.callbacks.has(redirectUri)) return page(res, 400, "Callback URL mismatch. The provided redirect_uri is not in the list of allowed callback URLs.");
        const back = new URL(redirectUri);
        const st = q.get("state");
        if (st) back.searchParams.set("state", st);
        const scope = (q.get("scope") ?? "").split(" ").filter(Boolean);
        if (q.get("response_type") !== "code" || q.get("audience") !== AUDIENCE || !scope.includes("openid")) {
          back.searchParams.set("error", "invalid_request");
        } else if (state.deny) {
          back.searchParams.set("error", "access_denied");
        } else {
          const granted = scope.filter((s) => (s === "offline_access" ? key.offline : s === "openid" || !key.scopes || key.scopes.includes(s)));
          const code = tok();
          state.issued.push(code);
          state.codes.set(code, { clientId: q.get("client_id") ?? "", redirectUri, sub: state.loginAs, scope: granted.join(" "), at: now(), used: false });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (req.method === "POST" && url.pathname === "/oauth/revoke") {
        state.revokeCalls += 1;
        let clientId = "";
        try {
          clientId = JSON.parse(text).client_id ?? "";
        } catch {
          /* ignore */
        }
        for (const [r, v] of state.refresh) if (v.clientId === clientId) state.refresh.delete(r);
        return send(res, 200, {});
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        state.tokenCalls += 1;
        if (state.failToken) {
          const f = state.failToken;
          state.failToken = null;
          return send(res, f.status, f.body);
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return send(res, 400, { error: "invalid_request" });
        const f = Object.fromEntries(new URLSearchParams(text));
        const key = state.keys.get(f.client_id ?? "");
        if (!key || key.secret !== f.client_secret) return send(res, 401, { error: "access_denied", error_description: "Unauthorized" });
        if (f.grant_type === "authorization_code") {
          const c = state.codes.get(f.code ?? "");
          if (!c || c.used || c.clientId !== f.client_id || now() - c.at > CODE_TTL_MS) return send(res, 403, { error: "invalid_grant", error_description: "Invalid authorization code" });
          c.used = true;
          if (f.redirect_uri !== c.redirectUri) return send(res, 403, { error: "invalid_grant", error_description: "Invalid redirect_uri" });
          /** @type {Record<string, unknown>} */
          const out = issueAccess(c.clientId, c.sub, c.scope);
          if (c.scope.split(" ").includes("offline_access")) out.refresh_token = issueRefresh(c.clientId, c.sub, c.scope, now());
          if (state.sendIdToken) out.id_token = idToken(c.sub, c.scope);
          return send(res, 200, out);
        }
        if (f.grant_type === "refresh_token") {
          state.refreshCalls += 1;
          state.refreshCallsBy.set(f.client_id ?? "", (state.refreshCallsBy.get(f.client_id ?? "") ?? 0) + 1);
          const r = state.refresh.get(f.refresh_token ?? "");
          if (!r || r.clientId !== f.client_id) return send(res, 403, { error: "invalid_grant", error_description: "Unknown or invalid refresh token." });
          if (key.rotate) {
            const t = now();
            if (t - r.issuedAt > ROTATION_IDLE_MS || t - r.loginAt > ROTATION_ABSOLUTE_MS) {
              state.refresh.delete(/** @type {string} */ (f.refresh_token));
              return send(res, 403, { error: "invalid_grant", error_description: "Unknown or invalid refresh token." });
            }
            state.refresh.delete(/** @type {string} */ (f.refresh_token));
            return send(res, 200, { ...issueAccess(r.clientId, r.sub, r.scope), refresh_token: issueRefresh(r.clientId, r.sub, r.scope, r.loginAt) });
          }
          return send(res, 200, issueAccess(r.clientId, r.sub, r.scope));
        }
        return send(res, 400, { error: "unsupported_grant_type" });
      }
      page(res, 404, "Not found");
    });
  });

  // ── API hosts

  /**
   * @param {EnvName} env
   * @returns {import("node:http").RequestListener}
   */
  const api = (env) => (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    state.calls.push({ host: env, method: req.method ?? "GET", path: url.pathname });
    req.resume();
    req.on("end", () => {
      if (req.method !== "GET" || url.pathname.startsWith("/v3/orderexecution")) {
        state.tradeCalls += 1;
        return send(res, 405, { Error: "MethodNotAllowed", Message: "Not allowed." });
      }
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      const a = state.access.get(bearer);
      if (state.refuseApi || !a || a.exp <= now()) return send(res, 401, { Error: "Unauthorized", Message: "Unauthorized" });
      const data = user(a.sub)[env];
      if (url.pathname === "/v3/brokerage/accounts") return send(res, 200, { Accounts: data.accounts });
      const m = /^\/v3\/brokerage\/accounts\/([^/]+)\/(balances|bodbalances|positions|orders|historicalorders)$/.exec(url.pathname);
      if (!m) return send(res, 404, { Error: "NotFound", Message: "Not found." });
      const ids = m[1].split(",");
      const what = m[2];
      if (ids.length > 25) return send(res, 400, { Error: "BadRequest", Message: "Too many accounts." });
      state.maxIdsSeen = Math.max(state.maxIdsSeen, ids.length);
      if (state.forbidden.has(what)) return send(res, 403, { Error: "Forbidden", Message: "Forbidden." });
      const category = what === "bodbalances" ? "balances" : what === "historicalorders" ? "orders" : what;
      const limited = state.rateLimit.get(category) ?? 0;
      if (limited > 0) {
        state.rateLimit.set(category, limited - 1);
        return send(res, 429, { Error: "TooManyRequests", Message: "Rate limit exceeded." }, { "retry-after": "1" });
      }
      const mine = new Set(data.accounts.map((x) => x.AccountID));
      /** @type {any[]} */
      const errors = [];
      const ok = ids.filter((id) => {
        const forced = data.errors.get(`${id}:${what}`) ?? data.errors.get(id);
        if (forced) {
          errors.push({ AccountID: id, ...forced });
          return false;
        }
        if (!mine.has(id)) {
          errors.push({ AccountID: id, Error: "Forbidden", Message: `Account ${id} is not available to this login.` });
          return false;
        }
        return true;
      });
      const of = (/** @type {any[]} */ list) => list.filter((x) => ok.includes(x.AccountID));
      if (what === "balances") return send(res, 200, { Balances: of(data.balances), Errors: errors });
      if (what === "bodbalances") return send(res, 200, { BODBalances: of(data.bodBalances), Errors: errors });
      if (what === "positions") return send(res, 200, { Positions: of(data.positions), Errors: errors });
      if (what === "historicalorders") {
        const since = url.searchParams.get("since");
        if (!since) return send(res, 400, { Error: "BadRequest", Message: "since is required." });
        state.sinceSeen.push(since);
      }
      const list = of(what === "orders" ? data.orders : data.history);
      const size = Math.min(Number(url.searchParams.get("pageSize") ?? 600) || 600, state.pageCap);
      let offset = 0;
      const next = url.searchParams.get("nextToken");
      if (next) {
        const p = state.pages.get(next);
        state.pages.delete(next);
        if (!p || !p.startsWith(`${env}|${url.pathname}|`)) return send(res, 400, { Error: "BadRequest", Message: "Invalid nextToken." });
        offset = Number(p.split("|")[2]);
      }
      const slice = list.slice(offset, offset + size);
      /** @type {Record<string, unknown>} */
      const out = { Orders: slice, Errors: offset === 0 ? errors : [] };
      if (offset + size < list.length) {
        const t = tok();
        state.pages.set(t, `${env}|${url.pathname}|${offset + size}`);
        out.NextToken = t;
      }
      return send(res, 200, out);
    });
  };

  const live = await listen(api("live"));
  const sim = await listen(api("sim"));

  return {
    state,
    urls: { signin: signin.url, live: live.url, sim: sim.url },
    user,

    /**
     * A new API key, as TradeStation Client Experience issues it: only localhost callbacks until one
     * is added. `scopes`: the API scopes the key grants (all requested ones when not set);
     * `offline: false`: the key gives no refresh tokens.
     * @param {{ clientId?: string, rotate?: boolean, callbacks?: string[], scopes?: string[], offline?: boolean }} [o]
     */
    addKey(o = {}) {
      const clientId = o.clientId ?? auth0ClientId();
      const clientSecret = tok();
      state.issued.push(clientSecret);
      state.keys.set(clientId, { secret: clientSecret, callbacks: new Set([...TS_DEFAULT_CALLBACKS, ...(o.callbacks ?? [])]), rotate: !!o.rotate, scopes: o.scopes ?? null, offline: o.offline ?? true });
      return { clientId, clientSecret };
    },

    /** Client Experience adds a callback URL to a key. @param {string} clientId @param {string} url */
    addCallback(clientId, url) {
      state.keys.get(clientId)?.callbacks.add(url);
    },

    /** The user removed Nasscord's access: every token of the login dies. @param {string} sub */
    revokeLogin(sub) {
      for (const [k, v] of state.refresh) if (v.sub === sub) state.refresh.delete(k);
      for (const [k, v] of state.access) if (v.sub === sub) state.access.delete(k);
    },

    /** Access tokens die before their end; refresh tokens still work. */
    killAccess() {
      state.access.clear();
    },

    /** Refresh grants of one key. @param {string} clientId */
    refreshesOf: (clientId) => state.refreshCallsBy.get(clientId) ?? 0,

    /** Calls to the API hosts (method and path), for the read-only checks. */
    apiCalls: () => state.calls.filter((c) => c.host !== "signin"),

    async close() {
      await Promise.all([signin.close(), live.close(), sim.close()]);
    },
  };
}
