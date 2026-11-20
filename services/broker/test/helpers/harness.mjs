import { randomUUID } from "node:crypto";
import { badGateway, badRequest, BrokerAuthError, SessionExpiredError } from "../../src/errors.mjs";
import { createLogger } from "../../src/log.mjs";
import { maskAccountNumber } from "../../src/mapping.mjs";
import { randomToken, sha256Hex } from "../../src/oauth2.mjs";
import { OrderNotSentError } from "../../src/order-contract.mjs";
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
    /** Puts the clock at an instant (it keeps running from there). @param {number} ms */
    setTime(ms) {
      offset = ms - Date.now();
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

// ─────────────────────────────────────────────────────────────── order entry fakes

/**
 * @typedef {import("../../src/order-contract.mjs").TradingCapabilities} TradingCapabilities
 * @typedef {import("../../src/order-contract.mjs").PositionState} PositionState
 * @typedef {import("../../src/order-contract.mjs").PlaceOutcome} PlaceOutcome
 * @typedef {import("../../src/order-contract.mjs").ReconcileOutcome} ReconcileOutcome
 * @typedef {import("../../src/order-contract.mjs").CancelOutcome} CancelOutcome
 * @typedef {import("../../src/order-contract.mjs").Ticket} Ticket
 */

/** Every type, both terms, brackets with either stop: what the fake allows unless a test says otherwise. */
export const FAKE_CAPS = Object.freeze({
  types: /** @type {Array<"MKT" | "LMT" | "STP" | "STP_LMT">} */ (["MKT", "LMT", "STP", "STP_LMT"]),
  tif: /** @type {Array<"DAY" | "GTC">} */ (["DAY", "GTC"]),
  marketGtc: true,
  bracket: { entryTypes: /** @type {Array<"MKT" | "LMT">} */ (["MKT", "LMT"]), stopTypes: /** @type {Array<"STP" | "STP_LMT">} */ (["STP", "STP_LMT"]) },
  notes: /** @type {string[]} */ ([]),
});

/**
 * The fake trading part's knobs and counters.
 * Knobs: caps (or { blocked }, or null), position (symbol -> PositionState; default flat with the
 * working orders read), referencePrice (default 100), quote, instrument, marketOpen (default true;
 * undefined lets the core use its NYSE calendar), previewError, positionError, notices, warnings,
 * place (queue of PlaceOutcome | "throw" | "not_sent"; default placed with brokerOrderId "fake-<n>"),
 * slowPlaceMs, slowReconcileMs, reconcile (queue of ReconcileOutcome; default { found: false }),
 * cancel (CancelOutcome or an HttpError).
 * Counters: calls.{ preview, positionState, place, reconcile, cancel }, sent: [{ clientOrderId, ticket }]
 * and lastPlaceInput (acknowledged, approvedMessages, position, previousClientOrderIds).
 * @param {Record<string, unknown>} [over]
 */
export function fakeTradingState(over = {}) {
  return {
    /** @type {TradingCapabilities | { blocked: string } | null} */
    caps: /** @type {TradingCapabilities | { blocked: string } | null} */ ({ ...FAKE_CAPS, types: [...FAKE_CAPS.types], tif: [...FAKE_CAPS.tif], notes: [] }),
    /** @type {Record<string, PositionState>} */
    position: {},
    /** @type {number | null} */
    referencePrice: 100,
    /** @type {import("../../src/order-contract.mjs").Quote | null} */
    quote: { bid: 99.99, ask: 100.01, source: "Fake quote" },
    /** @type {import("../../src/order-contract.mjs").Instrument | null} */
    instrument: { name: "Fake Instrument Inc", exchange: "FAKE" },
    /** @type {boolean | undefined} */
    marketOpen: true,
    /** @type {Error | null} */
    previewError: null,
    /** @type {Error | null} */
    positionError: null,
    /** @type {import("../../src/order-contract.mjs").OrderNotice[]} */
    notices: [],
    /** @type {import("../../src/order-contract.mjs").OrderWarning[]} */
    warnings: [],
    /** @type {Array<PlaceOutcome | "throw" | "not_sent">} */
    place: [],
    slowPlaceMs: 0,
    slowReconcileMs: 0,
    /** @type {ReconcileOutcome[]} */
    reconcile: [],
    /** @type {CancelOutcome | Error | null} */
    cancel: null,
    calls: { preview: 0, positionState: 0, place: 0, reconcile: 0, cancel: 0 },
    /** @type {Array<{ clientOrderId: string, ticket: Ticket }>} */
    sent: [],
    /** @type {any} */
    lastPlaceInput: null,
    /** @type {any} */
    lastReconcileInput: null,
    /** @type {string[]} */
    cancelled: [],
    ...over,
  };
}

/** @param {number} ms */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An alpaca_key adapter with a fake trading part (src/order-contract.mjs) over `o.state`: the order
 * core's tests (and the app's order route tests) run against it. Reads are trivial.
 * @param {{ state: ReturnType<typeof fakeTradingState> }} o
 * @returns {AdapterFactory} method alpaca_key, broker alpaca, environments production and paper, trivial reads.
 */
export function fakeTradingAdapter(o) {
  const st = o.state;
  /** @param {Ticket} ticket @returns {PositionState} */
  const positionOf = (ticket) => st.position[ticket.symbol] ?? { qty: 0, workingSell: 0, workingBuy: 0, working: true };
  return () => ({
    descriptor: {
      method: "alpaca_key",
      brokers: ["alpaca"],
      name: "Alpaca",
      environments: ["production", "paper"],
      readTtlMs: { portfolio: 15_000, orders: 30_000, executions: 30_000 },
    },
    async connectKey() {
      throw badRequest("The fake trading adapter does not connect keys.", "fake");
    },
    async balances(_c, accounts) {
      return { accounts: accounts.map((a) => ({ accountId: a.id, netLiq: 100_000, currency: "USD" })) };
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
    trading: {
      capabilities() {
        return st.caps;
      },
      async previewOrder(_ctx, ticket) {
        st.calls.preview += 1;
        if (st.previewError) throw st.previewError;
        if (st.positionError) throw st.positionError;
        const price = ticket.limitPrice ?? ticket.stopPrice ?? st.referencePrice ?? 0;
        return {
          position: positionOf(ticket),
          referencePrice: st.referencePrice,
          quote: st.quote,
          instrument: st.instrument,
          estimate: { notional: ticket.quantity * price, source: "Fake broker" },
          ...(st.marketOpen === undefined ? {} : { marketOpen: st.marketOpen }),
          warnings: [...st.warnings],
          notices: [...st.notices],
          brokerState: { fake: true },
        };
      },
      async positionState(_ctx, ticket) {
        st.calls.positionState += 1;
        if (st.positionError) throw st.positionError;
        return positionOf(ticket);
      },
      async placeOrder(_ctx, input) {
        st.calls.place += 1;
        st.lastPlaceInput = {
          acknowledged: [...input.acknowledged],
          approvedMessages: [...input.approvedMessages],
          position: input.position,
          previousClientOrderIds: [...input.previousClientOrderIds],
          clientOrderId: input.clientOrderId,
        };
        if (st.slowPlaceMs) await pause(st.slowPlaceMs);
        const next = st.place.shift();
        if (next === "not_sent") throw new OrderNotSentError(409, "The fake broker did not take the order. Nothing was placed.", "fake_not_sent");
        st.sent.push({ clientOrderId: input.clientOrderId, ticket: input.ticket });
        if (next === "throw") throw new Error("socket hang up");
        if (next) return next;
        return { status: "placed", brokerOrderId: `fake-${st.sent.length}` };
      },
      async reconcileOrder(_ctx, input) {
        st.calls.reconcile += 1;
        st.lastReconcileInput = input;
        if (st.slowReconcileMs) await pause(st.slowReconcileMs);
        return st.reconcile.shift() ?? { found: false };
      },
      async cancelOrder(_ctx, brokerOrderId) {
        st.calls.cancel += 1;
        if (st.cancel instanceof Error) throw st.cancel;
        st.cancelled.push(brokerOrderId);
        return st.cancel ?? { status: "cancel_requested", message: "The fake broker received the cancel." };
      },
    },
  });
}

/** Broker of each connect method, for seeded connection rows. */
const SEED_BROKER = /** @type {Record<string, string>} */ ({
  alpaca_key: "alpaca",
  alpaca_oauth: "alpaca",
  ibkr_gateway: "ibkr",
  ibkr_oauth: "ibkr",
  etrade_oauth1: "etrade",
  schwab_oauth: "schwab",
});

/**
 * Inserts an active alpaca_key connection (user_id = o.userId ?? the harness user) and one included
 * account in the harness workspace (owner_id = o.ownerId ?? the harness user), sets
 * workspaces.orders_enabled (default true) and status "active", and answers { connectionId, accountId }.
 * o.externalId and o.method override the defaults (o.environment too: default "paper").
 * @param {Awaited<ReturnType<typeof createHarness>>} h
 * @param {{ userId?: string, ownerId?: string | null, ordersEnabled?: boolean, externalId?: string, method?: string,
 *   environment?: "production" | "paper" | "sandbox", status?: string, included?: boolean, workspaceStatus?: string }} [o]
 */
export async function seedTradingAccount(h, o = {}) {
  const method = o.method ?? "alpaca_key";
  const brokerId = SEED_BROKER[method] ?? "alpaca";
  const environment = o.environment ?? "paper";
  const [conn] = await h.db.insert("broker_connections", {
    workspace_id: h.wid,
    user_id: o.userId ?? h.user,
    broker_id: brokerId,
    method,
    environment,
    status: o.status ?? "active",
  });
  const externalId = o.externalId ?? `PA${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const [account] = await h.db.insert("broker_accounts", {
    connection_id: conn.id,
    workspace_id: h.wid,
    broker_id: brokerId,
    external_id: externalId,
    display_number: maskAccountNumber(externalId),
    label: "Fake account",
    type: environment === "paper" ? "paper" : "individual",
    included: o.included ?? true,
  });
  const ws = h.rows("workspaces").find((w) => w.id === h.wid);
  if (ws) {
    ws.owner_id = o.ownerId === undefined ? h.user : o.ownerId;
    ws.orders_enabled = o.ordersEnabled ?? true;
    ws.status = o.workspaceStatus ?? "active";
  }
  return { connectionId: String(conn.id), accountId: String(account.id), externalId };
}
