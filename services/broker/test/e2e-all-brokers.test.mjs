import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CALLBACK_BASE, startFakeBrokers } from "../scripts/fake-brokers.mjs";
import { BROKER_PACKAGES } from "../src/adapters.mjs";
import { ALPACA_READ_ALLOW } from "../src/alpaca/client.mjs";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { isAllowed } from "../src/http.mjs";
import { createLogger } from "../src/log.mjs";
import { SCHWAB_OAUTH_PATHS, SCHWAB_READ_ALLOW } from "../src/schwab/client.mjs";
import { createBrokerService } from "../src/server.mjs";
import { SNAPTRADE_ALLOW } from "../src/snaptrade/client.mjs";
import { TASTYTRADE_READ_ALLOW, TASTYTRADE_TOKEN_ALLOW } from "../src/tastytrade/client.mjs";
import { TRADESTATION_OAUTH_PATHS, TRADESTATION_READ_ALLOW } from "../src/tradestation/client.mjs";
import { TRADIER_READ_ALLOW, TRADIER_TOKEN_ALLOW } from "../src/tradier/client.mjs";
import { WEBULL_OAUTH_PATHS, WEBULL_READ_ALLOW } from "../src/webull/client.mjs";
import { call, listen, sleep, testConfig } from "./helpers/common.mjs";
import { createHarness, newBinding, runOAuthLogin } from "./helpers/harness.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/**
 * Every broker package at once, end to end (WP11): one broker service with the real registry, flows,
 * OAuth engine and all seven adapter packages next to IBKR and E*TRADE, a memory database, and the
 * local fake brokers of scripts/fake-brokers.mjs. Everything goes through the service's HTTP API
 * with a service JWT, as the app calls it:
 *
 * - api_key: Alpaca Live and Paper keys, the owner's Tradier personal token, a replaced Alpaca key.
 * - OAuth: start (user's host) -> hop (canonical host) -> the broker's approval -> complete
 *   (canonical callback: only an opaque one-time ticket comes back) -> claim (user's host), for the
 *   Schwab and TradeStation user apps and the Tradier, tastytrade and Webull platform clients.
 * - aggregator: SnapTrade's portal for Fidelity (success) and Robinhood (abandoned).
 * - reads of every connection, the read-only allowlists, the BROKER_AUDIENCE gate per method,
 *   Reconnect, Disconnect, and the production refusals of sample data.
 *
 * Tests run in order and share the workspace.
 */

const MIN = 60_000;

/** @type {Awaited<ReturnType<typeof startFakeBrokers>>} */
let brokers;
/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** Every reply body the tests received (none may hold a token, code or secret). */
const replies = /** @type {string[]} */ ([]);
/** Keys and secrets made during the tests (a regenerated Alpaca pair). */
const extraSecrets = /** @type {string[]} */ ([]);
/** @type {Array<{ close: () => Promise<void> }>} */
const extra = [];

/** connection ids by name */
const ids = /** @type {Record<string, string>} */ ({});

const OWNER = () => h.token({ role: "superadmin" });
const TRADER = () => h.token();

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, token?: string }} [o]
 */
async function req(path, o) {
  const r = await h.req(path, o);
  replies.push(r.text);
  return r;
}

/** The harness with every reply collected (for runOAuthLogin). */
const collecting = () => ({ ...h, req });

/** @param {unknown} id */
const row = (id) => h.rows("broker_connections").find((r) => r.id === id);
/** @param {unknown} id */
const accountsOf = (id) => h.rows("broker_accounts").filter((a) => a.connection_id === id);
/** broker_accounts.id -> the connection's broker */
const brokerOfAccount = () => new Map(h.rows("broker_accounts").map((a) => [a.id, String(row(a.connection_id)?.broker_id)]));
/** Calls every fake received so far, by fake. */
const callCounts = () => Object.fromEntries(Object.entries(brokers.fakes).map(([k, f]) => [k, f.state.calls.length]));

/**
 * An OAuth connect through the canonical callback, checked for the ticket hand-off on the way.
 * @param {string} brokerId
 * @param {string} token
 * @param {{ start?: Record<string, unknown>, connectionId?: string }} [o]
 */
async function oauthLogin(brokerId, token, o = {}) {
  const run = /** @type {any} */ (await runOAuthLogin(collecting(), { token, start: { brokerId, ...(o.start ?? {}) }, ...(o.connectionId ? { connectionId: o.connectionId } : {}) }));
  assert.equal(run.failedAt, undefined, `${brokerId} stopped at ${run.failedAt}: ${run.res?.text}`);
  // The broker sent the browser to the one canonical callback of this broker.
  assert.equal(run.approval.callbackUrl, `${CALLBACK_BASE}/api/broker/callback/${brokerId}`);
  // The canonical callback answers only an opaque one-time ticket for the user's own host.
  assert.deepEqual(Object.keys(run.complete.json).sort(), ["connectionId", "returnOrigin", "ticket"]);
  assert.equal(run.complete.json.returnOrigin, "http://localhost:3000");
  assert.notEqual(run.complete.json.ticket, run.approval.code, "the ticket is not the broker's code");
  assert.match(run.complete.json.ticket, /^[A-Za-z0-9_-]{32,128}$/);
  // A ticket works once (404 when the login was merged into an existing connection and its row went).
  const again = await req("/v1/connect/claim", { method: "POST", token, body: { connectionId: run.connectionId, ticket: run.complete.json.ticket, binding: run.binding.nonce } });
  assert.ok(again.status === 410 || again.status === 404, again.text);
  return run;
}

/**
 * The SnapTrade portal: start (or Reconnect), hop, the portal at the fake, the canonical callback,
 * then the claim.
 * @param {string} brokerId
 * @param {string} token
 * @param {{ connectionId?: string }} [o]
 */
async function portalLogin(brokerId, token, o = {}) {
  const b = newBinding();
  let id = o.connectionId ?? "";
  if (!id) {
    const start = await req("/v1/aggregator/start", { method: "POST", token, body: { brokerId, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(start.status, 200, start.text);
    id = start.json.connectionId;
  } else {
    const renew = await req(`/v1/connections/${id}/renew`, { method: "POST", token, body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(renew.status, 200, renew.text);
    assert.equal(renew.json.next?.kind, "redirect");
  }
  const hop = await req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce } });
  assert.equal(hop.status, 200, hop.text);
  const back = await brokers.fakes.snaptrade.follow(hop.json.redirectUrl);
  assert.equal(back.status, 302);
  const u = new URL(back.location);
  assert.equal(`${u.origin}${u.pathname}`, `${CALLBACK_BASE}/api/broker/callback/snaptrade`, "SnapTrade returns to the canonical callback only");
  assert.equal(u.searchParams.get("cid"), id);
  const done = await req("/v1/aggregator/complete", {
    method: "POST",
    token: h.flowToken(),
    body: { connectionId: id, status: u.searchParams.get("status"), authorizationId: u.searchParams.get("connection_id") ?? undefined, binding: b.nonce },
  });
  if (done.status !== 200) return { id, hop, done, claim: null };
  assert.deepEqual(Object.keys(done.json).sort(), ["connectionId", "returnOrigin", "ticket"]);
  const claim = await req("/v1/connect/claim", { method: "POST", token, body: { connectionId: id, ticket: done.json.ticket, binding: b.nonce } });
  return { id, hop, done, claim };
}

before(async () => {
  /** @type {() => number} */
  let clock = Date.now;
  brokers = await startFakeBrokers({ now: () => clock() });
  h = await createHarness({
    env: { ...brokers.env, BROKER_CONNECT_PER_USER: "500", BROKER_CONNECT_GLOBAL_PER_MIN: "500" },
    adapters: [...BROKER_PACKAGES],
  });
  clock = h.now;
});

after(async () => {
  for (const s of extra) await s.close();
  await h?.close();
  await brokers?.close();
});

test("every broker package registers next to IBKR and E*TRADE in one service", async () => {
  const r = await req("/v1/health", { token: OWNER() });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    [...r.json.adapters].sort(),
    ["alpaca_key", "etrade_oauth1", "ibkr_gateway", "schwab_oauth", "snaptrade", "tastytrade_oauth", "tradestation_oauth", "tradier_oauth", "tradier_token", "webull_oauth"],
  );
  for (const b of ["ibkr", "etrade", "alpaca", "tradier", "schwab", "tastytrade", "tradestation", "webull", "fidelity", "robinhood", "public", "moomoo"]) {
    assert.ok(b in r.json.connections, `health counts ${b}`);
  }
});

test("options: the audience gate is per method, platform clients wait for their credentials, no sandbox for users", async () => {
  /** @param {any} json @param {string} broker @param {string} method @param {string | null} [client] @returns {any} */
  const pick = (json, broker, method, client) =>
    json.options.find((/** @type {any} */ o) => o.brokerId === broker && o.method === method && (client === undefined || o.client === client));
  const trader = (await req("/v1/options", { token: TRADER() })).json;
  const owner = (await req("/v1/options", { token: OWNER() })).json;
  assert.equal(trader.callbackBase, CALLBACK_BASE);

  // Open to everyone: IBKR (no gateway bundle on this test server), E*TRADE, Alpaca keys, the
  // SnapTrade brokers (their keys are set).
  assert.equal(pick(trader, "ibkr", "ibkr_gateway").audience, "all");
  assert.equal(pick(trader, "ibkr", "ibkr_gateway").reasonCode, "not_configured", "IBKR_GATEWAY_BUNDLE points nowhere here");
  for (const [b, m] of [
    ["etrade", "etrade_oauth1"],
    ["alpaca", "alpaca_key"],
    ["fidelity", "snaptrade"],
    ["robinhood", "snaptrade"],
    ["public", "snaptrade"],
    ["moomoo", "snaptrade"],
    ["webull", "snaptrade"],
  ]) {
    const o = pick(trader, b, m);
    assert.equal(o.audience, "all", `${b} ${m}`);
    assert.equal(o.available, true, `${b} ${m}: ${o.reason}`);
  }
  // The owner's own testing until each broker approves Nasscord (critique B1 to B3).
  for (const [b, m, c] of /** @type {Array<[string, string, string | null]>} */ ([
    ["schwab", "schwab_oauth", "user"],
    ["tradestation", "tradestation_oauth", "user"],
    ["tradier", "tradier_token", null],
    ["tradier", "tradier_oauth", "platform"],
    ["tastytrade", "tastytrade_oauth", "platform"],
    ["webull", "webull_oauth", "platform"],
  ])) {
    assert.equal(pick(trader, b, m, c).reasonCode, "owner_only", `${b} ${m} ${c} is the owner's only`);
    assert.equal(pick(owner, b, m, c).available, true, `${b} ${m} ${c} for the owner: ${pick(owner, b, m, c).reason}`);
  }
  // Platform clients without their env credentials, and methods not built yet.
  assert.equal(pick(owner, "schwab", "schwab_oauth", "platform").reasonCode, "not_configured");
  assert.equal(pick(owner, "tradestation", "tradestation_oauth", "platform").reasonCode, "not_configured");
  assert.equal(pick(owner, "alpaca", "alpaca_oauth", "platform").reasonCode, "not_built");
  // Schwab and tastytrade through SnapTrade wait for SnapTrade's own approvals (SNAPTRADE_BROKERS).
  assert.equal(pick(owner, "schwab", "snaptrade").reasonCode, "not_configured");
  assert.equal(pick(owner, "tastytrade", "snaptrade").reasonCode, "not_configured");

  // One canonical callback per broker; sample data only for the E*TRADE developer sandbox (not production).
  for (const o of owner.options) {
    if (o.flow === "oauth2_user_app" || o.flow === "oauth2_platform") assert.equal(o.callbackUrl, `${CALLBACK_BASE}/api/broker/callback/${o.brokerId}`);
    if (o.flow === "aggregator_portal") assert.equal(o.callbackUrl, `${CALLBACK_BASE}/api/broker/callback/snaptrade`);
    if (o.method !== "etrade_oauth1") assert.ok(!o.environments.includes("sandbox"), `${o.brokerId} ${o.method} offers no sandbox here`);
  }
  assert.deepEqual(pick(owner, "alpaca", "alpaca_key").environments, ["production", "paper"], "Alpaca: Live and the user's own Paper");
});

test("the gate refuses a trader before anything reaches a broker", async () => {
  const before = callCounts();
  const b = newBinding();
  const start = (/** @type {Record<string, unknown>} */ body) => req("/v1/oauth/start", { method: "POST", token: TRADER(), body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash, ...body } });
  const refusals = [
    await start({ brokerId: "schwab", clientId: brokers.credentials.schwab.appKey, clientSecret: brokers.credentials.schwab.appSecret }),
    await start({ brokerId: "tradestation", clientId: brokers.credentials.tradestation.clientId, clientSecret: brokers.credentials.tradestation.clientSecret }),
    await start({ brokerId: "tradier" }),
    await start({ brokerId: "tastytrade" }),
    await start({ brokerId: "webull" }),
    await req("/v1/keys/connect", { method: "POST", token: TRADER(), body: { brokerId: "tradier", secret: brokers.credentials.tradier.token } }),
  ];
  for (const r of refusals) {
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, "owner_only");
    assert.match(r.json.error, /^Not available yet: Nasscord is waiting for .+'s approval/);
  }
  assert.deepEqual(callCounts(), before, "no broker was called");
  assert.equal(h.rows("broker_connections").length, 0, "no connection row");
});

test("Alpaca keys (api_key): a Live and a Paper connection, each labelled from the account the key belongs to", async () => {
  const { live, paper } = brokers.credentials.alpaca;
  const l = await req("/v1/keys/connect", { method: "POST", token: TRADER(), body: { brokerId: "alpaca", keyId: live.keyId, secret: live.secret } });
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.connection.method, "alpaca_key");
  assert.equal(l.json.connection.environment, "production");
  assert.equal(l.json.connection.status, "active");
  assert.deepEqual(
    l.json.connection.accounts.map((/** @type {any} */ a) => [a.type, a.included]),
    [["margin", true]],
  );
  ids.alpacaLive = l.json.connection.id;
  const p = await req("/v1/keys/connect", { method: "POST", token: TRADER(), body: { brokerId: "alpaca", keyId: paper.keyId, secret: paper.secret } });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.connection.environment, "paper", "the user's own Paper account is allowed, labelled Paper");
  assert.deepEqual(
    p.json.connection.accounts.map((/** @type {any} */ a) => [a.label, a.type]),
    [["Alpaca Paper", "paper"]],
  );
  ids.alpacaPaper = p.json.connection.id;
});

test("Tradier personal token (api_key): the owner's own Live account", async () => {
  const r = await req("/v1/keys/connect", { method: "POST", token: OWNER(), body: { brokerId: "tradier", secret: brokers.credentials.tradier.token } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.connection.method, "tradier_token");
  assert.equal(r.json.connection.environment, "production");
  assert.ok(r.json.connection.accounts.length > 0);
  ids.tradier = r.json.connection.id;
});

test("Schwab with the owner's own app (oauth2_user_app): the code is exchanged at the canonical callback", async () => {
  const { appKey, appSecret } = brokers.credentials.schwab;
  const run = await oauthLogin("schwab", OWNER(), { start: { clientId: appKey, clientSecret: appSecret } });
  const c = run.connection;
  assert.equal(c.method, "schwab_oauth");
  assert.equal(c.status, "active");
  assert.ok(c.sessionExpiresAt, "Schwab's 7-day login end is shown");
  assert.ok(c.accounts.length >= 2);
  ids.schwab = c.id;
});

test("TradeStation with the owner's own key (oauth2_user_app); a legacy key is refused before any row", async () => {
  const legacy = await req("/v1/oauth/start", {
    method: "POST",
    token: OWNER(),
    body: { brokerId: "tradestation", clientId: "EAC7BF97-1A2B-4C3D-8E9F-0123456789AB", clientSecret: "legacy-secret-0001", returnOrigin: "http://localhost:3000", bindingHash: newBinding().hash },
  });
  assert.equal(legacy.status, 400, legacy.text);
  assert.equal(legacy.json.code, "tradestation_legacy_key");
  assert.equal(h.rows("broker_connections").filter((r) => r.broker_id === "tradestation").length, 0);

  const { clientId, clientSecret } = brokers.credentials.tradestation;
  const run = await oauthLogin("tradestation", OWNER(), { start: { clientId, clientSecret } });
  assert.equal(run.connection.method, "tradestation_oauth");
  assert.equal(run.connection.environment, "production");
  assert.deepEqual(
    run.connection.accounts.map((/** @type {any} */ a) => a.type),
    ["margin"],
  );
  ids.tradestation = run.connection.id;
});

test("Tradier partner OAuth (oauth2_platform) on the login the token connected: one connection, moved to OAuth", async () => {
  const run = await oauthLogin("tradier", OWNER());
  assert.equal(run.connection.id, ids.tradier, "the duplicate merge keeps the connection and its Included switches");
  assert.equal(run.connection.method, "tradier_oauth");
  assert.equal(row(ids.tradier)?.method, "tradier_oauth");
  assert.equal(h.rows("broker_connections").filter((r) => r.broker_id === "tradier" && r.status !== "disconnected").length, 1);
  assert.equal(row(String(run.connectionId)), undefined, "the new attempt's row is gone");
});

test("tastytrade and Webull platform OAuth (oauth2_platform)", async () => {
  const tt = await oauthLogin("tastytrade", OWNER());
  assert.equal(tt.connection.method, "tastytrade_oauth");
  assert.equal(tt.connection.environment, "production");
  assert.ok(tt.connection.accounts.length > 0);
  ids.tastytrade = tt.connection.id;

  const wb = await oauthLogin("webull", OWNER());
  assert.equal(wb.connection.method, "webull_oauth");
  assert.equal(wb.connection.environment, "production");
  assert.ok(wb.connection.accounts.length > 0);
  ids.webull = wb.connection.id;
});

test("SnapTrade portal (aggregator_portal): Fidelity connects; an abandoned Robinhood login leaves nothing", async () => {
  const f = await portalLogin("fidelity", TRADER());
  assert.equal(f.claim?.status, 200, f.claim?.text ?? f.done.text);
  const c = f.claim?.json.connection;
  assert.equal(c.brokerId, "fidelity");
  assert.equal(c.method, "snaptrade");
  assert.equal(c.environment, "production");
  assert.equal(c.scope, "read");
  assert.ok(c.dataAsOf, "the card says when SnapTrade last synced");
  assert.equal(c.accounts.length, 1);
  assert.equal(brokers.fakes.snaptrade.state.logins.at(-1).broker, "FIDELITY", "the portal opens at the chosen broker only");
  assert.equal(brokers.fakes.snaptrade.state.logins.at(-1).connectionType, "read");
  ids.fidelity = c.id;

  brokers.fakes.snaptrade.state.portal.outcome = "ABANDONED";
  try {
    const r = await portalLogin("robinhood", TRADER());
    assert.equal(r.done.status, 400, r.done.text);
    assert.equal(r.done.json.code, "aggregator_not_finished");
    assert.equal(row(r.id), undefined, "the attempt is removed");
  } finally {
    brokers.fakes.snaptrade.state.portal.outcome = "SUCCESS";
  }
});

test("reads: every connection answers balances and positions; orders and executions come back from every broker that has them", async () => {
  const expected = ["alpaca", "tradier", "schwab", "tradestation", "tastytrade", "webull", "fidelity"];
  const active = h.rows("broker_connections").filter((r) => r.status === "active");
  assert.deepEqual([...new Set(active.map((r) => r.broker_id))].sort(), [...expected].sort());

  const portfolio = await req("/v1/portfolio", { token: TRADER() });
  assert.equal(portfolio.status, 200, portfolio.text);
  assert.deepEqual(portfolio.json.errors, []);
  const brokerOf = brokerOfAccount();
  const known = new Set(h.rows("broker_accounts").map((a) => a.id));
  for (const a of portfolio.json.accounts) assert.ok(known.has(a.accountId), "accountId is broker_accounts.id, never the broker's number");
  for (const p of portfolio.json.positions) assert.ok(known.has(p.accountId));
  /** @param {any[]} list */
  const brokersIn = (list) => [...new Set(list.map((x) => brokerOf.get(x.accountId)))].sort();
  assert.deepEqual(brokersIn(portfolio.json.accounts), [...expected].sort(), "a balance from every broker");
  assert.deepEqual(brokersIn(portfolio.json.positions), [...expected].sort(), "positions from every broker");
  for (const p of portfolio.json.positions) {
    assert.equal(typeof p.symbol, "string");
    assert.ok(Number.isFinite(p.qty));
  }
  // Each Alpaca connection reads its own host: Live and Paper both answer.
  assert.equal(portfolio.json.accounts.filter((/** @type {any} */ a) => brokerOf.get(a.accountId) === "alpaca").length, 2);

  const orders = await req("/v1/orders", { token: TRADER() });
  assert.equal(orders.status, 200, orders.text);
  assert.deepEqual(orders.json.errors, []);
  for (const b of ["alpaca", "schwab", "tradestation", "tastytrade", "webull", "fidelity"]) {
    assert.ok(brokersIn(orders.json.orders).includes(b), `orders from ${b}`);
  }
  const placed = orders.json.orders.map((/** @type {any} */ o) => o.placedAt);
  assert.deepEqual(placed, [...placed].sort().reverse(), "newest first across brokers");

  const executions = await req("/v1/executions", { token: TRADER() });
  assert.equal(executions.status, 200, executions.text);
  assert.deepEqual(executions.json.errors, []);
  for (const b of ["alpaca", "schwab", "tradestation", "fidelity"]) {
    assert.ok(brokersIn(executions.json.executions).includes(b), `executions from ${b}`);
  }
  for (const e of executions.json.executions) assert.ok(e.side === "BUY" || e.side === "SELL");
});

test("read only: every call each adapter made is a read on its allowlist or a token call; no order, no revoke", () => {
  const f = brokers.fakes;
  assert.equal(f.alpaca.state.nonGet, 0);
  assert.deepEqual(
    f.alpaca.state.calls.filter((c) => !isAllowed([...ALPACA_READ_ALLOW], c.method, c.path)),
    [],
  );
  assert.deepEqual(
    f.schwab.serviceCalls().filter((c) => !(c.method === "POST" && c.path === SCHWAB_OAUTH_PATHS.token) && !isAllowed([...SCHWAB_READ_ALLOW], c.method, c.path)),
    [],
  );
  assert.deepEqual(
    f.tradestation.state.calls.filter((c) =>
      c.host === "signin"
        ? !((c.method === "POST" && c.path === TRADESTATION_OAUTH_PATHS.token) || (c.method === "GET" && c.path === TRADESTATION_OAUTH_PATHS.authorize))
        : !isAllowed([...TRADESTATION_READ_ALLOW], c.method, c.path),
    ),
    [],
  );
  assert.equal(f.tradestation.state.tradeCalls, 0);
  assert.equal(f.tradestation.state.revokeCalls, 0);
  assert.deepEqual(
    f.tradier.serviceCalls().filter((c) => !isAllowed([...TRADIER_TOKEN_ALLOW], c.method, c.path) && !isAllowed([...TRADIER_READ_ALLOW], c.method, c.path)),
    [],
  );
  assert.deepEqual(
    f.tastytrade.serviceCalls().filter((c) => !isAllowed([...TASTYTRADE_TOKEN_ALLOW], c.method, c.path) && !isAllowed([...TASTYTRADE_READ_ALLOW], c.method, c.path)),
    [],
  );
  assert.deepEqual(
    f.webull.serviceCalls().filter((c) => !(c.method === "POST" && c.path === WEBULL_OAUTH_PATHS.token) && !isAllowed([...WEBULL_READ_ALLOW], c.method, c.path)),
    [],
  );
  assert.deepEqual(
    f.snaptrade.state.calls.filter((c) => c.path !== "/portal" && !isAllowed([...SNAPTRADE_ALLOW], c.method, c.path)),
    [],
  );
});

test("Reconnect: a working Alpaca key needs nothing; a regenerated one asks for the new key, which keeps the connection", async () => {
  const ok = await req(`/v1/connections/${ids.alpacaLive}/renew`, { method: "POST", token: TRADER(), body: {} });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.next, undefined);
  assert.equal(ok.json.connection.status, "active");

  const pair = brokers.fakes.alpaca.regenerate(brokers.accounts.alpacaLive);
  extraSecrets.push(pair.keyId, pair.secret);
  const ask = await req(`/v1/connections/${ids.alpacaLive}/renew`, { method: "POST", token: TRADER(), body: {} });
  assert.equal(ask.status, 200, ask.text);
  assert.deepEqual(ask.json.next, { kind: "api_key" });
  const rekey = await req("/v1/keys/connect", { method: "POST", token: TRADER(), body: { brokerId: "alpaca", keyId: pair.keyId, secret: pair.secret, connectionId: ids.alpacaLive } });
  assert.equal(rekey.status, 200, rekey.text);
  assert.equal(rekey.json.connection.id, ids.alpacaLive);
  assert.equal(rekey.json.connection.status, "active");
  // The other account's key cannot replace this one.
  const other = await req("/v1/keys/connect", {
    method: "POST",
    token: TRADER(),
    body: { brokerId: "alpaca", keyId: brokers.credentials.alpaca.paper.keyId, secret: brokers.credentials.alpaca.paper.secret, connectionId: ids.alpacaLive },
  });
  assert.equal(other.status, 409, other.text);
});

test("Reconnect: Schwab logs in again through the canonical callback and keeps its connection; a SnapTrade authorization the broker disabled reopens in the portal", async () => {
  const before = row(ids.schwab)?.session_expires_at;
  h.advance(2 * MIN);
  const run = await oauthLogin("schwab", OWNER(), { connectionId: ids.schwab });
  assert.equal(run.connection.id, ids.schwab);
  assert.equal(run.connection.status, "active");
  assert.ok(Date.parse(String(row(ids.schwab)?.session_expires_at)) > Date.parse(String(before)), "a new login moves the 7-day end");

  // SnapTrade: an enabled authorization needs no login; one Fidelity disabled reopens in the portal.
  const ref = String(row(ids.fidelity)?.external_ref);
  const quiet = await req(`/v1/connections/${ids.fidelity}/renew`, { method: "POST", token: TRADER(), body: { returnOrigin: "http://localhost:3000", bindingHash: newBinding().hash } });
  assert.equal(quiet.status, 200, quiet.text);
  assert.equal(quiet.json.next, undefined);
  brokers.fakes.snaptrade.disable(ref);
  const again = await portalLogin("fidelity", TRADER(), { connectionId: ids.fidelity });
  assert.equal(again.claim?.status, 200, again.claim?.text ?? again.done.text);
  assert.equal(again.claim?.json.connection.id, ids.fidelity);
  assert.equal(row(ids.fidelity)?.external_ref, ref, "the same SnapTrade authorization");
  assert.equal(brokers.fakes.snaptrade.state.logins.at(-1).reconnect, ref, "the portal reconnects that authorization");
  assert.equal(brokers.fakes.snaptrade.state.authorizations.get(ref)?.disabled, false);

  // A redirect connection without a login binding cannot start a new login.
  for (const id of [ids.tastytrade, ids.webull, ids.tradier, ids.tradestation]) {
    const r = await req(`/v1/connections/${id}/renew`, { method: "POST", token: OWNER(), body: {} });
    assert.equal(r.status, 200, `${row(id)?.broker_id}: ${r.text}`);
    assert.equal(r.json.next, undefined, "a working session is refreshed, nothing else");
  }
});

test("BROKER_AUDIENCE per method: a method switched off cannot be connected; one limited to the owner admits only the owner", async () => {
  const svc = createBrokerService(testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist", ...brokers.env, BROKER_AUDIENCE: "alpaca_key=off,snaptrade=superadmin,tastytrade_oauth=all" }), {
    db: h.db,
    now: h.now,
    log: createLogger({ level: "debug", write: (line) => h.logLines.push(line) }),
    packages: [],
    adapters: [...BROKER_PACKAGES],
  });
  const api = await listen((rq, rs) => svc.api.handle(rq, rs));
  extra.push(api);
  /** @param {string} path @param {{ method?: string, body?: unknown, token?: string }} [o] */
  const other = async (path, o = {}) => {
    const r = await call(`${api.url}${path}`, { ...o, token: o.token ?? TRADER() });
    replies.push(r.text);
    return r;
  };
  const before = callCounts();
  const { live } = brokers.credentials.alpaca;
  const off = await other("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: live.keyId, secret: live.secret } });
  assert.equal(off.status, 403, off.text);
  assert.equal(off.json.code, "off");
  const b = newBinding();
  const agg = await other("/v1/aggregator/start", { method: "POST", body: { brokerId: "public", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(agg.status, 403, agg.text);
  assert.equal(agg.json.code, "owner_only");
  assert.deepEqual(callCounts(), before, "nothing reached a broker");
  // The owner may; a trader may use tastytrade once it is opened to everyone.
  const opts = (await other("/v1/options")).json;
  assert.equal(opts.options.find((/** @type {any} */ o) => o.method === "tastytrade_oauth").available, true);
  assert.equal(opts.options.find((/** @type {any} */ o) => o.method === "alpaca_key").reasonCode, "off");
  const ownerAgg = await other("/v1/aggregator/start", { method: "POST", token: OWNER(), body: { brokerId: "public", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(ownerAgg.status, 200, ownerAgg.text);
  const gone = await other(`/v1/connections/${ownerAgg.json.connectionId}`, { method: "DELETE", token: OWNER() });
  assert.equal(gone.status, 200, gone.text);
});

test("Disconnect: every connection, its secret and its accounts go; SnapTrade's authorization and user go with the last one; TradeStation is never revoked", async () => {
  const live = h.rows("broker_connections").filter((r) => r.status === "active");
  assert.equal(live.length, 8);
  const snap = brokers.fakes.snaptrade;
  const auth = String(row(ids.fidelity)?.external_ref);
  for (const c of live) {
    const r = await req(`/v1/connections/${c.id}`, { method: "DELETE", token: TRADER() });
    assert.equal(r.status, 200, `${c.broker_id}: ${r.text}`);
    assert.equal(row(c.id)?.status, "disconnected");
    assert.equal(accountsOf(c.id).length, 0);
    assert.equal(
      h.rows("broker_secrets").some((s) => s.connection_id === c.id),
      false,
    );
  }
  assert.equal(snap.state.authorizations.has(auth), false, "the SnapTrade authorization is deleted");
  assert.equal(snap.state.users.has(h.wid), false, "the workspace's SnapTrade user is deleted (per-user billing stops)");
  assert.equal(h.rows("broker_aggregator_users").length, 0);
  assert.equal(brokers.fakes.tradestation.state.revokeCalls, 0);

  const after = await req("/v1/portfolio", { token: TRADER() });
  assert.deepEqual(after.json, { accounts: [], positions: [], errors: [] });
  await sleep(10);
  assert.ok(h.rows("audit_events").filter((a) => a.action === "broker.connection.disconnect" && a.result === "ok").length >= 8);
});

test("production: sample-data settings are refused at boot, and the service neither connects nor serves sandbox data", async () => {
  const prodEnv = {
    NODE_ENV: "production",
    PUBLIC_LOGIN_URL: "https://ibkr-login.nasscord.com",
    OAUTH_CALLBACK_BASE: "https://nasscord.com",
    IBKR_GATEWAY_BUNDLE: "does-not-exist",
  };
  /** @param {Record<string, string>} env @param {RegExp} why */
  const refused = (env, why) =>
    assert.throws(
      () => testConfig({ ...prodEnv, ...env }),
      (/** @type {unknown} */ e) => e instanceof ConfigError && e.problems.some((p) => why.test(p)),
    );
  refused({ BROKER_URL_OVERRIDES: brokers.env.BROKER_URL_OVERRIDES }, /BROKER_URL_OVERRIDES is for local fake brokers and is refused in production/);
  refused({ TASTYTRADE_ENV: "cert" }, /TASTYTRADE_ENV=cert is sample data/);
  refused({ WEBULL_ENV: "sandbox" }, /WEBULL_ENV=sandbox is sample data/);
  refused({ OAUTH_CALLBACK_BASE: "http://nasscord.com" }, /OAUTH_CALLBACK_BASE must use https in production/);
  const etrade = testConfig({ ...prodEnv, ETRADE_ALLOW_SANDBOX: "true" });
  assert.equal(etrade.etrade.allowSandbox, false);
  assert.ok(etrade.warnings.some((w) => /ETRADE_ALLOW_SANDBOX is ignored in production/.test(w)));
  assert.equal(loadConfig({ ...prodEnv, SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", BROKER_SERVICE_SECRET: "s".repeat(32), BROKER_TOKEN_KEY: etrade.tokenKey.toString("base64") }).production, true);

  // A production service with every credential set and every gate open: nothing may leave it.
  /** @type {string[]} */
  const outbound = [];
  const db = createMemoryDb({ now: h.now });
  const wid = randomUUID();
  const user = randomUUID();
  db.tables.set("members", [{ user_id: user, email: "owner@example.com", role: "superadmin", workspace_id: wid }]);
  db.tables.set("workspaces", [{ id: wid, name: "Production desk" }]);
  const { BROKER_URL_OVERRIDES: _unused, OAUTH_CALLBACK_BASE: _local, ...creds } = brokers.env;
  const svc = createBrokerService(testConfig({ ...prodEnv, ...creds, BROKER_AUDIENCE: "all=all" }), {
    db,
    now: h.now,
    log: createLogger({ level: "debug", write: (line) => h.logLines.push(line) }),
    packages: [],
    adapters: [...BROKER_PACKAGES],
    fetch: /** @type {typeof fetch} */ (
      async (/** @type {any} */ url) => {
        outbound.push(String(url));
        throw new Error("no network in this test");
      }
    ),
  });
  const api = await listen((rq, rs) => svc.api.handle(rq, rs));
  extra.push(api);
  const token = () => h.token({ role: "superadmin", wid, sub: user });
  /** @param {string} path @param {{ method?: string, body?: unknown }} [o] */
  const prod = async (path, o = {}) => {
    const r = await call(`${api.url}${path}`, { ...o, token: token() });
    replies.push(r.text);
    return r;
  };

  const opts = (await prod("/v1/options")).json;
  assert.equal(opts.callbackBase, "https://nasscord.com");
  for (const o of opts.options) assert.ok(!o.environments.includes("sandbox"), `${o.brokerId} ${o.method} offers no sandbox in production`);

  const b = newBinding();
  const where = { returnOrigin: "https://nasscord.com", bindingHash: b.hash };
  const attempts = [
    await prod("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", environment: "sandbox", keyId: "PKSANDBOX0001", secret: "sandbox-secret-0001" } }),
    await prod("/v1/oauth/start", { method: "POST", body: { brokerId: "tastytrade", environment: "sandbox", ...where } }),
    await prod("/v1/oauth/start", { method: "POST", body: { brokerId: "webull", environment: "sandbox", ...where } }),
    await prod("/v1/aggregator/start", { method: "POST", body: { brokerId: "fidelity", environment: "sandbox", ...where } }),
  ];
  for (const r of attempts) {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, "sandbox_refused");
    assert.match(r.json.error, /sample data/);
  }
  const et = await prod("/v1/etrade/start", { method: "POST", body: { environment: "sandbox", consumerKey: "sandbox-consumer-key-01", consumerSecret: "sandbox-consumer-secret-01" } });
  assert.ok(et.status >= 400 && et.status < 500, et.text);
  assert.equal(db.tables.get("broker_connections")?.length ?? 0, 0, "no connection row");

  // Sandbox rows left from before (E*TRADE, tastytrade cert, Webull sandbox) are never read or renewed.
  for (const [broker, method] of [
    ["etrade", "etrade_oauth1"],
    ["tastytrade", "tastytrade_oauth"],
    ["webull", "webull_oauth"],
  ]) {
    const id = randomUUID();
    await svc.store.insertConnection({ id, workspace_id: wid, user_id: user, broker_id: /** @type {any} */ (broker), method: /** @type {any} */ (method), environment: "sandbox", status: "active", external_ref: `sandbox-${broker}` });
    await svc.store.upsertAccounts([{ connection_id: id, workspace_id: wid, broker_id: /** @type {any} */ (broker), external_id: `SB-${broker}`, display_number: "SB•••01", label: "Sandbox", type: "individual" }]);
    const renew = await prod(`/v1/connections/${id}/renew`, { method: "POST", body: { ...where } });
    assert.equal(renew.status, 400, renew.text);
    assert.equal(renew.json.code, "sandbox_refused");
  }
  for (const path of ["/v1/portfolio", "/v1/orders", "/v1/executions"]) {
    const r = await prod(path);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.errors.length, 3, path);
    for (const e of r.json.errors) assert.match(e.message, /sandbox connection with sample data, which this server does not serve/);
  }
  const p = (await prod("/v1/portfolio")).json;
  assert.deepEqual([p.accounts, p.positions], [[], []]);
  assert.deepEqual(outbound, [], "no call left the production service");
});

test("no secret leaks: no token, code, key or secret in a log line, a reply, or a table in the clear", () => {
  const f = brokers.fakes;
  const { credentials: cr, env } = brokers;
  const secrets = [
    ...f.schwab.state.issued,
    ...f.tradestation.state.issued,
    ...f.tradier.state.issued,
    ...f.tastytrade.state.issued,
    ...f.webull.state.issued,
    ...[...f.snaptrade.state.users.values()].map((u) => u.userSecret),
    cr.alpaca.live.keyId,
    cr.alpaca.live.secret,
    cr.alpaca.paper.keyId,
    cr.alpaca.paper.secret,
    cr.schwab.appSecret,
    cr.tradestation.clientSecret,
    cr.tradier.token,
    env.TRADIER_CLIENT_SECRET,
    env.TASTYTRADE_CLIENT_SECRET,
    env.WEBULL_CLIENT_SECRET,
    env.WEBULL_APP_SECRET,
    env.SNAPTRADE_CONSUMER_KEY,
    ...extraSecrets,
  ].filter((s) => typeof s === "string" && s.length >= 8);
  assert.ok(secrets.length > 25, `${secrets.length} secrets checked`);
  const logs = h.logLines.join("\n");
  const said = replies.join("\n");
  const tables = JSON.stringify([...h.db.tables.entries()]);
  for (const s of secrets) {
    assert.equal(logs.includes(s), false, "a log line holds a secret");
    assert.equal(said.includes(s), false, "a reply holds a secret");
    assert.equal(tables.includes(s), false, "a table holds a secret in the clear");
  }
  assert.equal(/[?&](code|state)=/.test(logs), false, "no query string in the logs");
});
