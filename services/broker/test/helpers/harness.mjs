import { randomUUID } from "node:crypto";
import { badGateway, badRequest, BrokerAuthError, SessionExpiredError } from "../../src/errors.mjs";
import { createLogger } from "../../src/log.mjs";
import { maskAccountNumber } from "../../src/mapping.mjs";
import { randomToken, sha256Hex } from "../../src/oauth2.mjs";
import { createBrokerService } from "../../src/server.mjs";
import { iso } from "../../src/time.mjs";
import { call, jwtFor, listen, testConfig } from "./common.mjs";
import { simulateBrowserApproval } from "./fake-oauth2.mjs";
import { createMemoryDb } from "./memory-db.mjs";

/**
 * The broker service with a memory database, a movable clock, a captured log and fake adapters, for
 * the framework tests (registry, flows, scheduler). Broker packages are left out (`packages: []`)
 * so these tests never clash with a real adapter landing in src/<broker>/.
 *
 * The clock runs (real time plus an offset) so rate buckets refill; advance(ms) jumps ahead.
 */

/**
 * @typedef {import("../../src/adapter-types.mjs").AdapterFactory} AdapterFactory
 * @typedef {import("../../src/adapter-types.mjs").AdapterDeps} AdapterDeps
 */

/**
 * @param {{
 *   env?: Record<string, string>,
 *   adapters?: Array<[string, AdapterFactory | null]>,
 * }} [opts]
 */
export async function createHarness(opts = {}) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const db = createMemoryDb({ now });
  /** @type {string[]} */
  const logLines = [];
  const log = createLogger({ level: "debug", write: (line) => logLines.push(line) });
  const svc = createBrokerService(testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist", LOG_LEVEL: "debug", ...(opts.env ?? {}) }), {
    db,
    now,
    log,
    packages: [],
    adapters: opts.adapters ?? [],
  });
  const api = await listen((req, res) => svc.api.handle(req, res));
  const wid = randomUUID();
  const user = randomUUID();
  db.tables.set("members", [{ user_id: user, email: "trader@example.com", role: "trader", workspace_id: wid }]);
  db.tables.set("workspaces", [{ id: wid, name: "Desk One" }]);

  /** @param {{ sub?: string, wid?: string | null, role?: string }} [c] */
  const token = (c = {}) => {
    const iat = Math.floor(now() / 1000);
    return jwtFor({ sub: user, wid, ...c, iat, exp: iat + 60 });
  };
  /** The app's signer for the canonical-host steps (any valid service JWT; the nil user). */
  const flowToken = () => token({ sub: "00000000-0000-0000-0000-000000000000", wid: null, role: "trader" });

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, token?: string, headers?: Record<string, string> }} [o]
   */
  const req = (path, o = {}) => call(`${api.url}${path}`, { ...o, token: o.token ?? token() });

  /** @param {string} t */
  const rows = (t) => db.tables.get(t) ?? [];

  return {
    db,
    svc,
    api,
    now,
    log,
    logLines,
    wid,
    user,
    token,
    flowToken,
    req,
    rows,
    /** @param {number} ms */
    advance(ms) {
      offset += ms;
    },
    close: () => api.close(),
  };
}

/** A binding nonce and its hash, as the app makes them (oauth-return.ts). */
export function newBinding() {
  const nonce = randomToken();
  return { nonce, hash: sha256Hex(nonce) };
}

/**
 * The whole OAuth connect as the app and the browser run it: start (user's host) -> hop (canonical)
 * -> broker approval -> complete (canonical callback) -> claim (user's host).
 * @param {Awaited<ReturnType<typeof createHarness>>} h
 * @param {{ start?: Record<string, unknown>, token?: string, connectionId?: string, renewBody?: boolean, skipClaim?: boolean }} o
 */
export async function runOAuthLogin(h, o) {
  const binding = newBinding();
  let connectionId = o.connectionId ?? null;
  if (!connectionId) {
    const start = await h.req("/v1/oauth/start", {
      method: "POST",
      token: o.token,
      body: { returnOrigin: "http://localhost:3000", bindingHash: binding.hash, ...(o.start ?? {}) },
    });
    if (start.status !== 200) return { failedAt: "start", res: start, binding };
    connectionId = start.json.connectionId;
  } else {
    const renew = await h.req(`/v1/connections/${connectionId}/renew`, {
      method: "POST",
      token: o.token,
      body: { returnOrigin: "http://localhost:3000", bindingHash: binding.hash },
    });
    if (renew.status !== 200) return { failedAt: "renew", res: renew, binding };
  }
  const hop = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId, binding: binding.nonce } });
  if (hop.status !== 200) return { failedAt: "hop", res: hop, binding, connectionId };
  const approval = await simulateBrowserApproval(hop.json.redirectUrl);
  const complete = await h.req("/v1/oauth/complete", {
    method: "POST",
    token: h.flowToken(),
    body: { brokerId: o.start?.brokerId ?? "schwab", state: approval.state, code: approval.code, error: approval.error, bindings: { [String(connectionId)]: binding.nonce } },
  });
  if (complete.status !== 200) return { failedAt: "complete", res: complete, binding, connectionId, approval, hop };
  if (o.skipClaim) return { binding, connectionId, approval, hop, complete };
  const claim = await h.req("/v1/connect/claim", { method: "POST", token: o.token, body: { connectionId, ticket: complete.json.ticket, binding: binding.nonce } });
  if (claim.status !== 200) return { failedAt: "claim", res: claim, binding, connectionId, approval, hop, complete };
  return { binding, connectionId, approval, hop, complete, claim, connection: claim.json.connection };
}

// ─────────────────────────────────────────────────────────────── fake adapters

/**
 * An api_key adapter (method alpaca_key) over an in-memory key list. Keys: secret -> account.
 * @param {{ keys: Map<string, { account: string, environment: "production" | "paper", accounts?: string[] }> }} o
 * @returns {AdapterFactory}
 */
export function fakeKeyAdapter(o) {
  return (deps) => ({
    descriptor: {
      method: "alpaca_key",
      brokers: ["alpaca"],
      name: "Alpaca",
      environments: ["production", "paper"],
      readTtlMs: { portfolio: 15_000, orders: 30_000, executions: 30_000 },
    },
    async connectKey(_ctx, input) {
      const k = o.keys.get(input.secret);
      if (!k || (input.environment && input.environment !== k.environment)) throw badRequest("Alpaca did not accept this key.", "alpaca_key_rejected");
      return {
        environment: k.environment,
        externalRef: k.account,
        secret: { keyId: input.keyId, secretKey: input.secret, host: k.environment === "paper" ? "paper" : "live" },
        accounts: (k.accounts ?? [k.account]).map((id) => ({
          broker_id: /** @type {const} */ ("alpaca"),
          external_id: id,
          display_number: maskAccountNumber(id),
          label: k.environment === "paper" ? "Alpaca Paper" : "Alpaca Individual",
          type: /** @type {"paper" | "individual"} */ (k.environment === "paper" ? "paper" : "individual"),
        })),
      };
    },
    async refresh(conn) {
      const s = await deps.oauth2.loadSecret(conn.id);
      if (s && o.keys.has(s.secretKey)) return "ok";
      await deps.store.updateConnectionIf(conn.id, ["active"], { status: "expired", status_detail: "Alpaca no longer accepts this key. Paste the new key." });
      return "expired";
    },
    async balances(_c, accounts) {
      return { accounts: accounts.map((a) => ({ accountId: a.id, netLiq: 1000, currency: "USD" })) };
    },
    async positions() {
      return [];
    },
    async orders() {
      return [];
    },
    async executions() {
      return [];
    },
  });
}

/**
 * An OAuth adapter (schwab_oauth by default) over a fake-oauth2 server: identify through /api/me,
 * accounts through /api/accounts, refresh through the engine.
 * @param {{
 *   server: Awaited<ReturnType<typeof import("./fake-oauth2.mjs").startFakeOAuth2>>,
 *   method?: "schwab_oauth" | "tradestation_oauth" | "tastytrade_oauth" | "alpaca_oauth",
 *   brokerId?: "schwab" | "tradestation" | "tastytrade" | "alpaca",
 *   refresh?: import("../../src/oauth2.mjs").OAuthProfile["refresh"],
 *   pkce?: boolean,
 *   sweepEveryMs?: number,
 *   lazyAccounts?: boolean,
 *   ref?: (sub: string) => string,
 * }} o
 * - ref: the external_ref identify() answers for the fake server's user (default `sub:<sub>`).
 * @returns {AdapterFactory}
 */
export function fakeOAuthAdapter(o) {
  const method = o.method ?? "schwab_oauth";
  const brokerId = o.brokerId ?? "schwab";
  const name = { schwab: "Schwab", tradestation: "TradeStation", tastytrade: "tastytrade", alpaca: "Alpaca" }[brokerId];
  const ref = o.ref ?? ((/** @type {string} */ sub) => `sub:${sub}`);
  return (deps) => {
    const http = deps.http({
      name,
      base: o.server.urls.api,
      allow: [
        ["GET", /^\/api\/me$/],
        ["GET", /^\/api\/accounts$/],
      ],
      bucket: { key: `${brokerId}:*`, ratePerSec: 50 },
    });
    /** @type {(env: string, client: "user" | "platform") => import("../../src/oauth2.mjs").OAuthProfile} */
    const profile = (_env, client) => ({
      brokerId,
      name,
      authorizeUrl: o.server.urls.authorize,
      tokenUrl: o.server.urls.token,
      clientAuth: o.server.cfg.clientAuth,
      scope: "readonly",
      pkce: o.pkce ?? false,
      platformClient: client === "platform" ? { clientId: o.server.cfg.clientId, clientSecret: o.server.cfg.clientSecret } : null,
      refresh: o.refresh ?? { kind: "fixed", hardExpiryMs: 7 * 24 * 3_600_000, accessFallbackMs: 30 * 60_000 },
      expiredDetail: `${name} requires a new login. Reconnect to continue.`,
    });
    /** @param {import("../../src/db.mjs").ConnectionRow} conn */
    const bearer = async (conn) => {
      const s = await deps.oauth2.loadSecret(conn.id);
      const token = await deps.oauth2.accessToken(conn, profile(conn.environment, s?.client ?? "user"));
      return { authorization: `Bearer ${token}` };
    };
    return {
      descriptor: {
        method,
        brokers: [brokerId],
        name,
        environments: ["production"],
        readTtlMs: { portfolio: 5_000, orders: 5_000, executions: 5_000 },
        lazyAccounts: o.lazyAccounts ?? true,
        sweepEveryMs: o.sweepEveryMs ?? null,
        clients: method === "tastytrade_oauth" || method === "alpaca_oauth" ? ["platform"] : ["user", "platform"],
      },
      oauthProfile: profile,
      async identify(_conn, tokens) {
        const me = await http.get("/api/me", undefined, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
        return { externalRef: ref(me.sub) };
      },
      async listAccounts(conn) {
        const body = await http.get("/api/accounts", undefined, { headers: await bearer(conn) });
        return body.accounts.map((/** @type {any} */ a) => ({
          broker_id: /** @type {any} */ (brokerId),
          external_id: a.id,
          display_number: maskAccountNumber(a.id),
          label: a.name,
          type: a.type ?? "individual",
        }));
      },
      async refresh(conn) {
        try {
          await http.get("/api/me", undefined, { headers: await bearer(conn) });
          return "ok";
        } catch (e) {
          if (e instanceof SessionExpiredError) return "expired";
          if (e instanceof BrokerAuthError) {
            await deps.oauth2.expire(conn, `${name} requires a new login. Reconnect to continue.`);
            return "expired";
          }
          throw e;
        }
      },
      async portfolio(conn, accounts) {
        await http.get("/api/me", undefined, { headers: await bearer(conn) });
        return { accounts: accounts.map((a) => ({ accountId: a.id, cash: 10, currency: "USD" })), positions: [] };
      },
      async orders() {
        return [];
      },
      async executions() {
        return [];
      },
    };
  };
}

/**
 * The SnapTrade-shaped aggregator adapter: a portal link back to the canonical callback, an
 * authorization id as the login's identity, and a webhook that checks a test header.
 * @param {{ webhookCalls?: Array<{ body: string }>, failPortal?: { count: number } }} [o]
 * - failPortal: the next `count` portal links fail like a SnapTrade outage (502).
 * @returns {AdapterFactory}
 */
export function fakeAggregatorAdapter(o = {}) {
  return (deps) => ({
    descriptor: {
      method: "snaptrade",
      brokers: ["fidelity", "robinhood", "public", "moomoo", "webull"],
      name: "SnapTrade",
      environments: ["production"],
      readTtlMs: { portfolio: 600_000, orders: 600_000, executions: 600_000 },
      lazyAccounts: true,
    },
    async portalUrl(req) {
      if (o.failPortal && o.failPortal.count > 0) {
        o.failPortal.count -= 1;
        throw badGateway("SnapTrade is not answering right now (503). Try again in a moment.", "broker_down");
      }
      const u = new URL("https://portal.example.test/connect");
      u.searchParams.set("broker", req.brokerId.toUpperCase());
      u.searchParams.set("customRedirect", req.redirectUrl);
      if (req.reconnect) u.searchParams.set("reconnect", req.reconnect);
      return u.toString();
    },
    async aggregatorComplete(_conn, input) {
      if (input.authorizationId.startsWith("other")) throw badRequest("This connection is for another brokerage. Start again from Brokers.", "wrong_brokerage");
      return { externalRef: input.authorizationId, dataAsOf: iso(deps.now()) };
    },
    async listAccounts(conn) {
      return [
        {
          broker_id: conn.broker_id,
          external_id: `${conn.external_ref ?? "auth"}-1`,
          display_number: "Z12•••34",
          label: "Brokerage",
          type: /** @type {const} */ ("individual"),
        },
      ];
    },
    async balances(_c, accounts) {
      return { accounts: accounts.map((a) => ({ accountId: a.id, netLiq: 5, currency: "USD" })) };
    },
    async positions() {
      return [];
    },
    async orders() {
      return [];
    },
    async executions() {
      return [];
    },
    async webhook(req) {
      o.webhookCalls?.push({ body: req.rawBody.toString("utf8") });
      return req.headers["x-test-signature"] === "ok" ? { status: 200, body: { received: true } } : { status: 401 };
    },
  });
}
