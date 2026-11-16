import { createHash, randomBytes } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A generic OAuth 2.0 authorization server for tests, driven by a profile like the brokers':
 * - GET  /authorize: answers 302 to redirect_uri with code and state (what the broker does after the
 *   user approves). `deny: true` answers error=access_denied instead.
 * - POST /token: authorization_code and refresh_token grants, with the client authenticated by HTTP
 *   Basic, form fields or a JSON body. Knobs: rotating refresh tokens, a refresh token lifetime, a
 *   forced failure for the next call, PKCE.
 * - GET  /api/me and /api/accounts with "Authorization: Bearer <access token>", for the fake
 *   adapters' identify and account calls.
 * Every request is recorded (method and path only).
 *
 * @param {{
 *   clientId?: string, clientSecret?: string,
 *   clientAuth?: "basic" | "body" | "json",
 *   requireRedirectUri?: boolean,
 *   rotate?: boolean,
 *   accessTtlSec?: number,
 *   refreshTtlSec?: number | null,
 *   sub?: string,
 *   accounts?: Array<{ id: string, name: string, type?: string }>,
 *   pkce?: boolean,
 * }} [opts]
 */
export async function startFakeOAuth2(opts = {}) {
  const cfg = {
    clientId: opts.clientId ?? "fake-client-id",
    clientSecret: opts.clientSecret ?? "fake-client-secret",
    clientAuth: opts.clientAuth ?? "basic",
    requireRedirectUri: opts.requireRedirectUri ?? true,
    rotate: opts.rotate ?? false,
    accessTtlSec: opts.accessTtlSec ?? 1800,
    refreshTtlSec: opts.refreshTtlSec ?? null,
    pkce: opts.pkce ?? false,
  };
  const state = {
    sub: opts.sub ?? "user-1",
    accounts: opts.accounts ?? [
      { id: "ACC-1", name: "Individual", type: "individual" },
      { id: "ACC-2", name: "Roth IRA", type: "roth" },
    ],
    /** @type {Map<string, { redirectUri: string, challenge: string | null, used: boolean, sub: string }>} */
    codes: new Map(),
    /** @type {Map<string, string>} refresh token -> sub */
    refresh: new Map(),
    /** @type {Map<string, string>} access token -> sub */
    access: new Map(),
    /** @type {Array<{ method: string, path: string }>} */
    calls: [],
    tokenCalls: 0,
    /** @type {{ status: number, body: unknown } | null} the next /token answer */
    failNext: /** @type {{ status: number, body: unknown } | null} */ (null),
    deny: false,
    /** milliseconds to wait before answering /token */
    tokenDelayMs: 0,
    /** the next this many /api/accounts calls answer 500 */
    failAccounts: 0,
  };
  const token = () => randomBytes(18).toString("base64url");

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {Record<string, string>} fields
   */
  function clientOk(req, fields) {
    if (cfg.clientAuth === "basic") {
      const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ""));
      if (!m) return false;
      const [id, secret] = Buffer.from(m[1], "base64").toString("utf8").split(":");
      return id === cfg.clientId && secret === cfg.clientSecret;
    }
    return fields.client_id === cfg.clientId && fields.client_secret === cfg.clientSecret;
  }

  /** @param {string} sub */
  function issue(sub, withRefresh = true) {
    const access = token();
    state.access.set(access, sub);
    /** @type {Record<string, unknown>} */
    const out = { access_token: access, token_type: "Bearer", expires_in: cfg.accessTtlSec, scope: "read" };
    if (withRefresh) {
      const refresh = token();
      state.refresh.set(refresh, sub);
      out.refresh_token = refresh;
      if (cfg.refreshTtlSec) out.refresh_token_expires_in = cfg.refreshTtlSec;
    }
    return out;
  }

  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    state.calls.push({ method: req.method ?? "GET", path: url.pathname });
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && url.pathname === "/authorize") {
        if (url.searchParams.get("client_id") !== cfg.clientId) return send(res, 400, { error: "invalid_client" });
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (cfg.requireRedirectUri && !redirectUri) return send(res, 400, { error: "invalid_request" });
        const back = new URL(redirectUri || "http://callback.invalid/");
        const st = url.searchParams.get("state");
        if (st) back.searchParams.set("state", st);
        if (state.deny) {
          back.searchParams.set("error", "access_denied");
        } else {
          const code = token();
          state.codes.set(code, { redirectUri, challenge: url.searchParams.get("code_challenge"), used: false, sub: state.sub });
          back.searchParams.set("code", code);
        }
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (req.method === "POST" && url.pathname === "/token") {
        state.tokenCalls += 1;
        if (state.tokenDelayMs) await new Promise((r) => setTimeout(r, state.tokenDelayMs));
        if (state.failNext) {
          const f = state.failNext;
          state.failNext = null;
          return send(res, f.status, f.body);
        }
        /** @type {Record<string, string>} */
        let fields = {};
        try {
          fields = cfg.clientAuth === "json" ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
        } catch {
          return send(res, 400, { error: "invalid_request" });
        }
        if (!clientOk(req, fields)) return send(res, 401, { error: "invalid_client" });
        if (fields.grant_type === "authorization_code") {
          const c = state.codes.get(fields.code ?? "");
          if (!c || c.used) return send(res, 400, { error: "invalid_grant" });
          c.used = true;
          if (cfg.requireRedirectUri && fields.redirect_uri !== c.redirectUri) return send(res, 400, { error: "invalid_grant" });
          if (cfg.pkce) {
            const want = createHash("sha256").update(fields.code_verifier ?? "").digest("base64url");
            if (!c.challenge || want !== c.challenge) return send(res, 400, { error: "invalid_grant" });
          }
          return send(res, 200, { ...issue(c.sub), id_token: `e30.${Buffer.from(JSON.stringify({ sub: c.sub })).toString("base64url")}.sig` });
        }
        if (fields.grant_type === "refresh_token") {
          const sub = state.refresh.get(fields.refresh_token ?? "");
          if (!sub) return send(res, 400, { error: "invalid_grant" });
          if (cfg.rotate) {
            state.refresh.delete(fields.refresh_token);
            return send(res, 200, issue(sub, true));
          }
          return send(res, 200, issue(sub, false));
        }
        return send(res, 400, { error: "unsupported_grant_type" });
      }
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      const sub = state.access.get(bearer);
      if (req.method === "GET" && url.pathname === "/api/me") {
        if (!sub) return send(res, 401, { error: "unauthorized" });
        return send(res, 200, { sub });
      }
      if (req.method === "GET" && url.pathname === "/api/accounts") {
        if (!sub) return send(res, 401, { error: "unauthorized" });
        if (state.failAccounts > 0) {
          state.failAccounts -= 1;
          return send(res, 500, { error: "server_error" });
        }
        return send(res, 200, { accounts: state.accounts });
      }
      send(res, 404, { error: "not found" });
    });
  });

  return {
    ...server,
    cfg,
    state,
    urls: { authorize: `${server.url}/authorize`, token: `${server.url}/token`, api: server.url },
    /** Forget every issued access token (the broker revoked them). */
    revokeAccess() {
      state.access.clear();
    },
    /** Forget every refresh token (the user deleted the grant). */
    revokeRefresh() {
      state.refresh.clear();
    },
  };
}

/**
 * What the user's browser does at the broker: open the authorize URL, approve, and follow the 302
 * back. Returns the callback URL's query (code, state or error) without loading the callback.
 * @param {string} authorizeUrl
 */
export async function simulateBrowserApproval(authorizeUrl) {
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) throw new Error(`the authorize page answered ${res.status}`);
  const back = new URL(location);
  return {
    callbackUrl: `${back.origin}${back.pathname}`,
    code: back.searchParams.get("code"),
    state: back.searchParams.get("state"),
    error: back.searchParams.get("error"),
  };
}
