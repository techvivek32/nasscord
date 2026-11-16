import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { HttpError, ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp } from "../src/http.mjs";
import { createLogger } from "../src/log.mjs";
import { createBrokerService } from "../src/server.mjs";
import { createTradeStationClient, sinceDate, TRADESTATION_AUDIENCE } from "../src/tradestation/client.mjs";
import { createAdapter, TRADESTATION_DETAIL, TRADESTATION_MESSAGES } from "../src/tradestation/index.mjs";
import { call, listen, testConfig } from "./helpers/common.mjs";
import { startFakeTradeStation } from "./helpers/fake-tradestation.mjs";
import { createHarness, newBinding, runOAuthLogin } from "./helpers/harness.mjs";

/**
 * The TradeStation adapter end to end: the service (memory database, real registry, flows, OAuth
 * engine and scheduler) against a fake TradeStation (Auth0 sign-in, Live and SIM API hosts). Tests
 * run in order and share the connections and the clock.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CALLBACK = "http://localhost:3000/api/broker/callback/tradestation";

/** @type {Awaited<ReturnType<typeof startFakeTradeStation>>} */
let fake;
/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** Every reply body the tests received (none may hold a token, code or key secret). */
const replies = /** @type {string[]} */ ([]);
/** Every API key the tests created. */
const clientIds = /** @type {string[]} */ ([]);
/** @type {Array<{ close: () => Promise<void> }>} */
const extra = [];

/** The platform owner in the harness workspace. */
const OWNER = () => h.token({ role: "superadmin" });
/** A second workspace (the rotating key's tests), so its reads never touch the first one's connection. */
const wid2 = randomUUID();
const user2 = randomUUID();
const OWNER2 = () => h.token({ role: "superadmin", wid: wid2, sub: user2 });

/** @type {{ clientId: string, clientSecret: string }} */
let key1;
/** @type {{ clientId: string, clientSecret: string }} */
let key2;
let liveId = "";
let rotId = "";
/** The Paper connection made while SIM was on (the SIM tests). */
let simId = "";

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, token?: string }} [o]
 */
async function req(path, o) {
  const r = await h.req(path, o);
  replies.push(r.text);
  return r;
}

/** @param {string} id */
const row = (id) => h.rows("broker_connections").find((r) => r.id === id);
/** @param {string} id */
const secretOf = (id) => h.svc.oauth2.loadSecret(id, { fresh: true });
/** @param {any} json @param {string} id */
const errorOf = (json, id) => json.errors.find((/** @type {any} */ e) => e.connectionId === id);
/** @param {Parameters<typeof fake.addKey>[0]} [o] */
function addKey(o) {
  const k = fake.addKey(o);
  clientIds.push(k.clientId);
  return k;
}

/**
 * runOAuthLogin with the reply bodies collected.
 * @param {Parameters<typeof runOAuthLogin>[1]} o
 * @param {Awaited<ReturnType<typeof createHarness>>} [on]
 * @returns {Promise<any>}
 */
async function login(o, on = h) {
  const r = await runOAuthLogin(
    {
      ...on,
      req: async (/** @type {string} */ path, /** @type {any} */ x) => {
        const res = await on.req(path, x);
        replies.push(res.text);
        return res;
      },
    },
    { ...o, start: { brokerId: "tradestation", ...(o.start ?? {}) } },
  );
  return r;
}

/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** The owner's live TradeStation login: 12 open accounts and a closed one, positions, orders. @param {string} sub */
function seedLive(sub) {
  const t = h.now();
  const u = fake.user(sub).live;
  u.accounts = [];
  for (let i = 1; i <= 12; i++) u.accounts.push({ AccountID: `1000000${String(i).padStart(2, "0")}`, AccountType: i % 2 ? "Margin" : "Cash", Status: "Active", Currency: "USD" });
  u.accounts.push({ AccountID: "199999999", AccountType: "Cash", Status: "Closed" });
  u.balances = u.accounts.map((a, i) => ({
    AccountID: a.AccountID,
    Equity: String(10000 + i),
    CashBalance: "500.00",
    BuyingPower: "20000.00",
    ...(i === 1 ? {} : { TodaysProfitLoss: "12.50" }),
  }));
  u.bodBalances = [{ AccountID: "100000002", BalanceDetail: { Equity: "9990.00" } }];
  u.errors.set("100000012:balances", { Error: "Forbidden", Message: "Account 100000012 is restricted." });
  u.positions = [
    { AccountID: "100000001", PositionID: "p1", Symbol: "MSFT", AssetType: "STOCK", LongShort: "Long", Quantity: "10", AveragePrice: "400", Last: "410", MarketValue: "4100", UnrealizedProfitLoss: "100", TodaysProfitLoss: "5" },
    { AccountID: "100000003", PositionID: "p2", Symbol: "TSLA", AssetType: "STOCK", LongShort: "Short", Quantity: "40", AveragePrice: "250", Last: "245", MarketValue: "-9800", UnrealizedProfitLoss: "200" },
    { AccountID: "100000011", PositionID: "p3", Symbol: "SPY 261218C600", AssetType: "STOCKOPTION", LongShort: "Long", Quantity: "2", AveragePrice: "3.10", Last: "3.50", MarketValue: "700" },
  ];
  const filled = {
    AccountID: "100000001",
    OrderID: "5001",
    OrderType: "Limit",
    Status: "FLL",
    Duration: "DAY",
    LimitPrice: "101.00",
    FilledPrice: "100.95",
    CommissionFee: "1.00",
    OpenedDateTime: iso(t - 2 * 3_600_000),
    ClosedDateTime: iso(t - 2 * 3_600_000 + MIN),
    Legs: [{ Symbol: "AAPL", AssetType: "STOCK", BuyOrSell: "Buy", QuantityOrdered: "10", ExecQuantity: "10", ExecutionPrice: "100.95" }],
  };
  u.orders = [
    filled,
    { AccountID: "100000001", OrderID: "5002", OrderType: "Limit", Status: "ACK", Duration: "GTC", LimitPrice: "300", OpenedDateTime: iso(t - 40 * DAY), Legs: [{ Symbol: "MSFT", BuyOrSell: "Buy", QuantityOrdered: "5", ExecQuantity: "0" }] },
    { AccountID: "100000003", OrderID: "5003", OrderType: "Market", Status: "FPR", Duration: "DAY", OpenedDateTime: iso(t - 30 * MIN), Legs: [{ Symbol: "TSLA", AssetType: "STOCK", BuyOrSell: "SellShort", QuantityOrdered: "100", ExecQuantity: "40", ExecutionPrice: "250" }] },
  ];
  u.history = [
    { ...filled },
    { AccountID: "100000001", OrderID: "5004", OrderType: "Limit", Status: "CAN", Duration: "DAY", LimitPrice: "90", OpenedDateTime: iso(t - 3 * DAY), ClosedDateTime: iso(t - 3 * DAY + MIN), Legs: [{ Symbol: "AAPL", BuyOrSell: "Buy", QuantityOrdered: "10", ExecQuantity: "0" }] },
    {
      AccountID: "100000001",
      OrderID: "5005",
      OrderType: "Limit",
      Status: "FLL",
      Duration: "DAY",
      LimitPrice: "1.90",
      CommissionFee: "1.30",
      OpenedDateTime: iso(t - 5 * DAY),
      ClosedDateTime: iso(t - 5 * DAY + MIN),
      Legs: [
        { Symbol: "SPY 261218C600", AssetType: "STOCKOPTION", BuyOrSell: "BuyToOpen", QuantityOrdered: "1", ExecQuantity: "1", ExecutionPrice: "3.10" },
        { Symbol: "SPY 261218C610", AssetType: "STOCKOPTION", BuyOrSell: "SellToOpen", QuantityOrdered: "1", ExecQuantity: "1", ExecutionPrice: "1.20" },
      ],
    },
    ...[6, 7, 8, 9].map((n) => ({
      AccountID: "100000003",
      OrderID: `500${n}`,
      OrderType: "Market",
      Status: "FLL",
      Duration: "DAY",
      FilledPrice: "20",
      OpenedDateTime: iso(t - n * DAY),
      ClosedDateTime: iso(t - n * DAY + MIN),
      Legs: [{ Symbol: "F", AssetType: "STOCK", BuyOrSell: "Buy", QuantityOrdered: "1", ExecQuantity: "1" }],
    })),
  ];
}

/**
 * Another broker service over the same database (a restart, or one with other settings), logging
 * into the same lines.
 * @param {Record<string, string>} env
 */
async function serviceOver(env) {
  const svc = createBrokerService(
    testConfig({
      IBKR_GATEWAY_BUNDLE: "does-not-exist",
      LOG_LEVEL: "debug",
      BROKER_URL_OVERRIDES: JSON.stringify({ tradestation: fake.urls }),
      ...env,
    }),
    {
      db: h.db,
      now: h.now,
      log: createLogger({ level: "debug", write: (line) => h.logLines.push(line) }),
      packages: [],
      adapters: [["tradestation", createAdapter]],
    },
  );
  const api = await listen((rq, rs) => svc.api.handle(rq, rs));
  extra.push(api);
  return {
    ...h,
    svc,
    /** @param {string} path @param {{ method?: string, body?: unknown, token?: string }} [o] */
    req: async (path, o = {}) => {
      const r = await call(`${api.url}${path}`, { ...o, token: o.token ?? OWNER() });
      replies.push(r.text);
      return r;
    },
  };
}

before(async () => {
  fake = await startFakeTradeStation({ now: () => (h ? h.now() : Date.now()) });
  h = await createHarness({
    env: { BROKER_URL_OVERRIDES: JSON.stringify({ tradestation: fake.urls }) },
    adapters: [["tradestation", createAdapter]],
  });
  h.db.tables.get("members")?.push({ user_id: user2, email: "owner@example.com", role: "superadmin", workspace_id: wid2 });
  h.db.tables.get("workspaces")?.push({ id: wid2, name: "Owner desk" });
  seedLive("ts-user-1");
  key1 = addKey();
});

after(async () => {
  for (const s of extra) await s.close();
  await h?.close();
  await fake?.close();
});

test("who may connect: the user key is the owner's only, the platform key is not set up, no Paper without TRADESTATION_ALLOW_SIM", async () => {
  /** @param {any} json @param {"user" | "platform"} client */
  const pick = (json, client) => json.options.find((/** @type {any} */ o) => o.brokerId === "tradestation" && o.client === client);
  const trader = (await req("/v1/options")).json;
  assert.equal(pick(trader, "user").flow, "oauth2_user_app");
  assert.equal(pick(trader, "user").available, false);
  assert.equal(pick(trader, "user").reasonCode, "owner_only");
  assert.equal(pick(trader, "user").callbackUrl, CALLBACK);
  const owner = (await req("/v1/options", { token: OWNER() })).json;
  assert.equal(pick(owner, "user").available, true);
  assert.deepEqual(pick(owner, "user").environments, ["production"], "SIM stays off until TRADESTATION_ALLOW_SIM");
  assert.equal(pick(owner, "platform").available, false);
  assert.equal(pick(owner, "platform").reasonCode, "not_configured");
  assert.match(pick(owner, "platform").reason, /TRADESTATION_CLIENT_ID/);

  const b = newBinding();
  const refused = await req("/v1/oauth/start", {
    method: "POST",
    body: { brokerId: "tradestation", clientId: key1.clientId, clientSecret: key1.clientSecret, returnOrigin: "http://localhost:3000", bindingHash: b.hash },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, "owner_only");
  const paper = await req("/v1/oauth/start", {
    method: "POST",
    token: OWNER(),
    body: { brokerId: "tradestation", clientId: key1.clientId, clientSecret: key1.clientSecret, environment: "paper", returnOrigin: "http://localhost:3000", bindingHash: b.hash },
  });
  assert.equal(paper.status, 400);
  assert.equal(paper.json.code, "bad_environment");
});

test("without Nasscord's callback on the key, TradeStation shows its own error and nothing connects (no paste-code fallback)", async () => {
  const b = newBinding();
  const start = await req("/v1/oauth/start", {
    method: "POST",
    token: OWNER(),
    body: { brokerId: "tradestation", clientId: key1.clientId, clientSecret: key1.clientSecret, returnOrigin: "http://localhost:3000", bindingHash: b.hash },
  });
  assert.equal(start.status, 200, start.text);
  const id = start.json.connectionId;
  assert.equal((await secretOf(id)).redirectUri, CALLBACK, "the canonical callback, never a localhost one");
  const hop = await req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce } });
  assert.equal(hop.status, 200, hop.text);
  const u = new URL(hop.json.redirectUrl);
  assert.equal(`${u.origin}${u.pathname}`, `${fake.urls.signin}/authorize`);
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), key1.clientId);
  assert.equal(u.searchParams.get("audience"), TRADESTATION_AUDIENCE);
  assert.equal(u.searchParams.get("scope"), "openid offline_access ReadAccount");
  assert.equal(u.searchParams.get("redirect_uri"), CALLBACK);
  assert.ok(u.searchParams.get("state"));
  assert.equal(u.searchParams.get("code_challenge"), null);

  const page = await fetch(hop.json.redirectUrl, { redirect: "manual" });
  assert.equal(page.status, 400);
  assert.equal(page.headers.get("location"), null, "no code goes anywhere");
  assert.match(await page.text(), /Callback URL mismatch/);
  assert.equal(row(id)?.status, "pending");

  h.advance(11 * MIN);
  await h.svc.scheduler.tick();
  assert.equal(row(id), undefined, "the unfinished attempt is removed after its 10 minutes");
});

test("callback mode end to end: the owner's key, Live accounts (closed ones left out), external_ref from the id_token sub", async () => {
  fake.addCallback(key1.clientId, CALLBACK);
  const calls = fake.state.calls.length;
  const r = await login({ token: OWNER(), start: { clientId: key1.clientId, clientSecret: key1.clientSecret } });
  assert.equal(r.failedAt, undefined, JSON.stringify(r.res?.json));
  const c = /** @type {any} */ (r.connection);
  liveId = c.id;
  assert.equal(c.status, "active");
  assert.equal(c.environment, "production");
  assert.equal(c.method, "tradestation_oauth");
  assert.equal(c.accounts.length, 12);
  assert.equal(c.accounts.find((/** @type {any} */ a) => a.displayNumber === "100•••01")?.label, "TradeStation Margin");
  assert.equal(c.accounts.find((/** @type {any} */ a) => a.displayNumber === "100•••02")?.type, "individual");
  assert.equal(c.scope, "openid offline_access ReadAccount");
  assert.equal(c.sessionExpiresAt, null, "a key that does not rotate never ends on its own");
  assert.equal(row(liveId)?.external_ref, "sub:ts-user-1");
  const s = await secretOf(liveId);
  assert.equal(s.client, "user");
  assert.equal(s.clientId, key1.clientId);
  assert.equal(s.redirectUri, CALLBACK);
  assert.ok(s.refreshToken && s.accessToken);
  assert.deepEqual(
    fake.state.calls.slice(calls).map((x) => `${x.host} ${x.method} ${x.path}`),
    ["signin GET /authorize", "signin POST /oauth/token", "live GET /v3/brokerage/accounts"],
  );
});

test("reads: balances and positions ten accounts a call; a refused account is an error entry; day P&L from the day's start when missing", async () => {
  const r = await req("/v1/portfolio", { token: OWNER() });
  assert.equal(r.status, 200, r.text);
  assert.ok(fake.state.maxIdsSeen <= 10 && fake.state.maxIdsSeen > 1, `batched (${fake.state.maxIdsSeen})`);
  assert.equal(r.json.accounts.length, 11);
  const accts = h.rows("broker_accounts").filter((a) => a.connection_id === liveId);
  /** @param {string} ext */
  const idOf = (ext) => accts.find((a) => a.external_id === ext)?.id;
  const second = r.json.accounts.find((/** @type {any} */ a) => a.accountId === idOf("100000002"));
  assert.deepEqual(second, { accountId: idOf("100000002"), netLiq: 10001, buyingPower: 20000, cash: 500, dayPnl: 11, currency: "USD" });
  assert.equal(r.json.accounts.find((/** @type {any} */ a) => a.accountId === idOf("100000001")).dayPnl, 12.5);
  assert.deepEqual(r.json.errors, [{ connectionId: liveId, message: "TradeStation could not send the balances of account 100•••12 (Forbidden)." }]);
  const bod = fake.state.calls.filter((x) => x.path.endsWith("/bodbalances")).map((x) => x.path);
  assert.deepEqual(bod, ["/v3/brokerage/accounts/100000002/bodbalances"], "only the account without TodaysProfitLoss");
  const byS = Object.fromEntries(r.json.positions.map((/** @type {any} */ p) => [p.symbol, p]));
  assert.equal(byS.MSFT.qty, 10);
  assert.equal(byS.TSLA.qty, -40);
  assert.equal(byS.TSLA.accountId, idOf("100000003"));
  assert.equal(byS["SPY 261218C600"].secType, "OPT", "the second batch of accounts is read too");
});

test("a 403 on the optional day's-start balances leaves that day P&L out and keeps the balances and positions", async () => {
  h.svc.cache.invalidate(liveId);
  fake.state.forbidden.add("bodbalances");
  try {
    const r = await req("/v1/portfolio", { token: OWNER() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.accounts.length, 11);
    assert.equal(r.json.positions.length, 3);
    const accts = h.rows("broker_accounts").filter((a) => a.connection_id === liveId);
    const second = r.json.accounts.find((/** @type {any} */ a) => a.accountId === accts.find((x) => x.external_id === "100000002")?.id);
    assert.equal(second.netLiq, 10001);
    assert.equal(second.dayPnl, undefined, "no baseline, so no day P&L");
    assert.deepEqual(r.json.errors, [{ connectionId: liveId, message: "TradeStation could not send the balances of account 100•••12 (Forbidden)." }]);
    assert.equal(row(liveId)?.status, "active");
  } finally {
    fake.state.forbidden.delete("bodbalances");
    h.svc.cache.invalidate(liveId);
  }
});

test("orders: today's and closed orders merged once each, paged; executions come from the same fetch", async () => {
  fake.state.pageCap = 3;
  const since = sinceDate(h.now() - 89 * DAY);
  const o = await req("/v1/orders", { token: OWNER() });
  assert.equal(o.status, 200, o.text);
  assert.deepEqual(o.json.errors, []);
  const orders = o.json.orders;
  assert.equal(orders.length, 10);
  assert.equal(new Set(orders.map((/** @type {any} */ x) => x.id)).size, 10, "5001 is in both lists and shows once");
  const by = (/** @type {string} */ ref) => orders.filter((/** @type {any} */ x) => x.brokerRef === ref);
  assert.equal(by("5001")[0].status, "filled");
  assert.equal(by("5002")[0].status, "working");
  assert.equal(by("5002")[0].tif, "GTC");
  assert.equal(by("5004")[0].status, "cancelled");
  assert.equal(by("5005").length, 2, "one order per leg");
  assert.ok(fake.state.sinceSeen.length > 0 && fake.state.sinceSeen.every((x) => x === since), "89 days of closed orders");
  assert.ok(fake.state.calls.filter((x) => x.path.endsWith("/historicalorders")).length >= 3, "closed orders read page by page");

  const orderCalls = fake.state.calls.filter((x) => /\/(historical)?orders$/.test(x.path)).length;
  const e = await req("/v1/executions", { token: OWNER() });
  assert.equal(e.status, 200, e.text);
  assert.equal(fake.state.calls.filter((x) => /\/(historical)?orders$/.test(x.path)).length, orderCalls, "no second fetch within 30 s");
  const ex = e.json.executions;
  assert.equal(ex.length, 8);
  const aapl = ex.find((/** @type {any} */ x) => x.symbol === "AAPL");
  assert.deepEqual([aapl.side, aapl.qty, aapl.price, aapl.commission, aapl.net, aapl.provisional], ["BUY", 10, 100.95, 1, -1010.5, undefined]);
  const tsla = ex.find((/** @type {any} */ x) => x.symbol === "TSLA");
  assert.deepEqual([tsla.side, tsla.qty, tsla.net, tsla.provisional], ["SELL", 40, 10000, true], "a partial fill of a working order is provisional");
  const legs = ex.filter((/** @type {any} */ x) => x.symbol.startsWith("SPY"));
  assert.deepEqual(legs.map((/** @type {any} */ x) => x.net).sort(), [-310.65, 119.35].sort(), "options count premium times 100; the commission is split");
});

test("a busy login: 12 accounts and 3,601 closed orders answer well within the app's 8 s; closed orders stop at the page cap and are reused for 2 minutes", async () => {
  const u = fake.user("ts-user-1").live;
  const saved = { history: u.history, pageCap: fake.state.pageCap };
  const t = h.now();
  u.history = Array.from({ length: 3_601 }, (_, i) => ({
    AccountID: "100000001",
    OrderID: `9${String(i).padStart(5, "0")}`,
    OrderType: "Market",
    Status: "FLL",
    Duration: "DAY",
    OpenedDateTime: iso(t - DAY - i * MIN),
    ClosedDateTime: iso(t - DAY - i * MIN + 1_000),
    Legs: [{ Symbol: "F", AssetType: "STOCK", BuyOrSell: "Buy", QuantityOrdered: "1", ExecQuantity: "1", ExecutionPrice: "10" }],
  }));
  fake.state.pageCap = 600;
  const adapter = /** @type {any} */ (h.svc.registry.get("tradestation_oauth"));
  // Nothing cached from the tests before: every page is read again.
  adapter.forget(liveId);
  h.svc.cache.invalidate(liveId);
  const closedCalls = () => fake.state.calls.filter((x) => x.path.endsWith("/historicalorders")).length;
  const before = closedCalls();
  try {
    const started = Date.now();
    const o = await req("/v1/orders", { token: OWNER() });
    const took = Date.now() - started;
    assert.equal(o.status, 200, o.text);
    assert.ok(took < 5_000, `answered in ${took} ms (one call a second took over 7 s)`);
    assert.deepEqual(o.json.errors, []);
    assert.equal(closedCalls() - before, 6, "five pages for the busy batch of accounts, one for the other");
    const closed = o.json.orders.filter((/** @type {any} */ x) => x.brokerRef.startsWith("9"));
    assert.equal(closed.length, 3_000, "the newest 3,000 closed orders (5 pages of 600)");
    assert.ok(closed.some((/** @type {any} */ x) => x.brokerRef === "900000"), "newest first");

    // Within 2 minutes a new read asks for today's and open orders only.
    h.advance(MIN);
    const again = await req("/v1/orders", { token: OWNER() });
    assert.equal(again.status, 200);
    assert.equal(again.json.orders.filter((/** @type {any} */ x) => x.brokerRef.startsWith("9")).length, 3_000);
    assert.equal(closedCalls() - before, 6, "no closed-order call within 2 minutes");
  } finally {
    u.history = saved.history;
    fake.state.pageCap = saved.pageCap;
    adapter.forget(liveId);
    h.svc.cache.invalidate(liveId);
  }
});

test("read-only: only GET on the API hosts and only the token endpoint at sign-in; order entry is refused before the network", async () => {
  assert.ok(fake.apiCalls().length > 0);
  assert.ok(fake.apiCalls().every((x) => x.method === "GET" && x.path.startsWith("/v3/brokerage/")));
  assert.deepEqual([...new Set(fake.state.calls.filter((x) => x.host === "signin").map((x) => `${x.method} ${x.path}`))].sort(), ["GET /authorize", "POST /oauth/token"]);
  assert.equal(fake.state.tradeCalls, 0);
  assert.equal(fake.state.revokeCalls, 0);

  const before = fake.state.calls.length;
  const client = createTradeStationClient({ http: (o) => createBrokerHttp(o), base: fake.urls.live, token: "unused", bucketPrefix: "tradestation:test" });
  for (const [m, p] of [
    ["POST", "/v3/orderexecution/orders"],
    ["POST", "/v3/orderexecution/orderconfirm"],
    ["PUT", "/v3/orderexecution/orders/5002"],
    ["DELETE", "/v3/orderexecution/orders/5002"],
    ["GET", "/v3/orderexecution/routes"],
    ["POST", "/oauth/revoke"],
    ["POST", "/v3/brokerage/accounts/100000001/orders"],
  ]) {
    await assert.rejects(client.http.request(m, p, { json: {} }), ReadOnlyViolation, `${m} ${p}`);
  }
  assert.equal(fake.state.calls.length, before, "nothing reached TradeStation");
  assert.equal(fake.state.tradeCalls, 0);
});

test("a service restart: a new service on the same database reads with the stored tokens, without a token call", async () => {
  const tokenCalls = fake.state.tokenCalls;
  const svc = await serviceOver({});
  const r = await svc.req("/v1/portfolio");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.accounts.length, 11);
  assert.equal(fake.state.tokenCalls, tokenCalls);
});

test("a key that does not rotate: the sweep refreshes it once to find out, then leaves it alone; reads refresh lazily", async () => {
  h.advance(11 * MIN);
  await h.svc.scheduler.tick();
  assert.equal(fake.refreshesOf(key1.clientId), 1, "the first refresh tells whether the key rotates");
  const s = await secretOf(liveId);
  assert.equal(s.refreshExpiresAt ?? null, null);
  assert.equal(row(liveId)?.session_expires_at ?? null, null);
  h.advance(11 * MIN);
  await h.svc.scheduler.tick();
  assert.equal(fake.refreshesOf(key1.clientId), 1, "known not to rotate: the sweep leaves it alone");
  h.advance(10 * MIN);
  const r = await req("/v1/portfolio", { token: OWNER() });
  assert.equal(r.status, 200);
  assert.equal(r.json.accounts.length, 11);
  assert.equal(fake.refreshesOf(key1.clientId), 2, "the expired access token was refreshed by the read");
});

test("a key that rotates refresh tokens: one refresh for a read and the sweep together, saved before use, kept alive by the sweep, 24 h after the sign-in shown and enforced", async () => {
  key2 = addKey({ rotate: true, callbacks: [CALLBACK] });
  fake.state.loginAs = "ts-user-2";
  const u = fake.user("ts-user-2").live;
  u.accounts = [{ AccountID: "200000001", AccountType: "Margin", Status: "Active" }];
  u.balances = [{ AccountID: "200000001", Equity: "5000", TodaysProfitLoss: "1" }];
  const r = await login({ token: OWNER2(), start: { clientId: key2.clientId, clientSecret: key2.clientSecret } });
  fake.state.loginAs = "ts-user-1";
  assert.equal(r.failedAt, undefined, JSON.stringify(r.res?.json));
  rotId = /** @type {any} */ (r.connection).id;
  const t0 = h.now();
  const first = await secretOf(rotId);
  assert.equal(row(rotId)?.session_expires_at ?? null, null, "rotation is not known before the first refresh");

  // A read and the sweep both want a new access token: one refresh between them (the token lock).
  h.advance(19 * MIN);
  const [read] = await Promise.all([req("/v1/portfolio", { token: OWNER2() }), h.svc.scheduler.tick()]);
  assert.equal(read.status, 200);
  assert.equal(read.json.accounts.length, 1);
  assert.equal(fake.refreshesOf(key2.clientId), 1);
  const rotated = await secretOf(rotId);
  assert.notEqual(rotated.refreshToken, first.refreshToken, "the new refresh token is stored");
  assert.equal(fake.state.refresh.has(first.refreshToken), false, "TradeStation killed the old one");
  assert.equal(fake.state.refresh.has(rotated.refreshToken), true);
  const end = Date.parse(rotated.refreshExpiresAt);
  assert.ok(Math.abs(end - (t0 + DAY)) < 10_000, "the login ends 24 h after the sign-in");
  assert.equal(Date.parse(/** @type {string} */ (row(rotId)?.session_expires_at)), end, "the card shows Reconnect by");

  // Nobody reads: the sweep keeps the refresh token alive (TradeStation drops one unused for 30 minutes).
  h.advance(11 * MIN);
  await h.svc.scheduler.tick();
  assert.equal(fake.refreshesOf(key2.clientId), 2);
  h.advance(11 * MIN);
  await h.svc.scheduler.tick();
  assert.equal(fake.refreshesOf(key2.clientId), 3);
  assert.equal(row(rotId)?.status, "active");

  // The database write fails right after TradeStation rotated: the new pair is never used, and the
  // dead refresh token then ends the login. The 24 hours have not passed, so it is a plain new login.
  h.advance(19 * MIN);
  const saved = await secretOf(rotId);
  h.db.failNext.set("broker_secrets", new Error("database unavailable"));
  const crashed = await req("/v1/portfolio", { token: OWNER2() });
  assert.equal(crashed.status, 200);
  assert.match(errorOf(crashed.json, rotId).message, /Try again/);
  assert.equal((await secretOf(rotId)).refreshToken, saved.refreshToken, "nothing unsaved is used or cached");
  const after = await req("/v1/portfolio", { token: OWNER2() });
  assert.equal(errorOf(after.json, rotId).message, TRADESTATION_DETAIL.login, "not the 24 h sentence before the 24 hours");
  assert.equal(row(rotId)?.status_detail, TRADESTATION_DETAIL.login);
  assert.equal(row(rotId)?.status, "expired");
  const left = await secretOf(rotId);
  assert.equal(left.refreshToken, undefined);
  assert.equal(left.accessToken, undefined);
  assert.equal(left.clientId, key2.clientId, "the user's key stays for Reconnect");

  // Reconnect, then let the 24 hours run out: expired at the mark, without a token call.
  fake.state.loginAs = "ts-user-2";
  const again = await login({ token: OWNER2(), connectionId: rotId });
  fake.state.loginAs = "ts-user-1";
  assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
  const t1 = h.now();
  h.advance(11 * MIN);
  await h.svc.scheduler.tick();
  const end2 = Date.parse(/** @type {string} */ (row(rotId)?.session_expires_at));
  assert.ok(Math.abs(end2 - (t1 + DAY)) < 10_000, "the new login's own 24 h");
  const refreshes = fake.refreshesOf(key2.clientId);
  h.advance(DAY);
  await h.svc.scheduler.tick();
  assert.equal(row(rotId)?.status, "expired");
  assert.equal(row(rotId)?.status_detail, TRADESTATION_DETAIL.rotated);
  assert.equal(fake.refreshesOf(key2.clientId), refreshes, "no token call past the end");
});

test("a 401 on a read gets one new access token; refused again, the login is over", async () => {
  h.advance(MIN);
  // A fresh access token first (the last one ran out during the 24 hours above).
  assert.equal((await req("/v1/portfolio", { token: OWNER() })).json.accounts.length, 11);
  h.advance(MIN);
  const before = fake.refreshesOf(key1.clientId);
  fake.killAccess();
  const ok = await req("/v1/portfolio", { token: OWNER() });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.accounts.length, 11);
  assert.equal(fake.refreshesOf(key1.clientId), before + 1, "one refresh for both reads that got a 401");

  h.advance(MIN);
  fake.state.refuseApi = true;
  const refused = await req("/v1/portfolio", { token: OWNER() });
  fake.state.refuseApi = false;
  assert.equal(errorOf(refused.json, liveId).message, TRADESTATION_DETAIL.refused);
  assert.equal(row(liveId)?.status, "expired");
  assert.equal(row(liveId)?.status_detail, TRADESTATION_DETAIL.refused);
});

test("Reconnect logs in again on the same connection and keeps the Included switches; another TradeStation login is refused", async () => {
  const acct = h.rows("broker_accounts").find((a) => a.connection_id === liveId && a.external_id === "100000005");
  assert.ok(acct);
  acct.included = false;
  const r = await login({ token: OWNER(), connectionId: liveId });
  assert.equal(r.failedAt, undefined, JSON.stringify(r.res?.json));
  assert.equal(/** @type {any} */ (r.connection).id, liveId);
  assert.equal(row(liveId)?.status, "active");
  assert.equal(h.rows("broker_accounts").find((a) => a.id === acct.id)?.included, false);

  fake.state.loginAs = "ts-other";
  fake.user("ts-other").live.accounts = [{ AccountID: "300000001", AccountType: "Cash", Status: "Active" }];
  const other = await login({ token: OWNER(), connectionId: liveId });
  fake.state.loginAs = "ts-user-1";
  assert.equal(other.failedAt, "complete");
  assert.equal(other.res.status, 409);
  assert.equal(other.res.json.code, "other_account");
  assert.equal(row(liveId)?.status, "active", "the working login is kept");
  assert.equal(row(liveId)?.external_ref, "sub:ts-user-1");
});

test("a 429 on positions pauses only that category; orders still read", async () => {
  h.advance(MIN);
  fake.state.rateLimit.set("positions", 1);
  const r = await req("/v1/portfolio", { token: OWNER() });
  assert.match(errorOf(r.json, liveId).message, /limiting requests/);
  const o = await req("/v1/orders", { token: OWNER() });
  assert.equal(o.status, 200);
  assert.deepEqual(o.json.errors, []);
  assert.ok(o.json.orders.length > 0);
  h.advance(MIN);
  const again = await req("/v1/portfolio", { token: OWNER() });
  assert.deepEqual(again.json.errors.filter((/** @type {any} */ e) => /limiting/.test(e.message)), []);
});

test("invalid_grant on refresh (the user removed Nasscord at TradeStation) expires the connection with a Reconnect sentence", async () => {
  fake.revokeLogin("ts-user-1");
  h.advance(21 * MIN);
  const r = await req("/v1/portfolio", { token: OWNER() });
  assert.equal(errorOf(r.json, liveId).message, TRADESTATION_DETAIL.login);
  assert.equal(row(liveId)?.status, "expired");
  const renew = await req(`/v1/connections/${liveId}/renew`, { method: "POST", token: OWNER(), body: {} });
  assert.equal(renew.status, 400);
  assert.equal(renew.json.code, "needs_login", "Reconnect needs a new TradeStation login");
});

test("SIM: Paper only with TRADESTATION_ALLOW_SIM, read from the SIM host; a SIM connection left when the setting is off is not read", async () => {
  const sim = fake.user("ts-user-1").sim;
  sim.accounts = [{ AccountID: "SIM1234567M", AccountType: "Margin", Status: "Active" }];
  sim.balances = [{ AccountID: "SIM1234567M", Equity: "100000", CashBalance: "100000", BuyingPower: "400000", TodaysProfitLoss: "0" }];
  sim.positions = [{ AccountID: "SIM1234567M", PositionID: "s1", Symbol: "AAPL", AssetType: "STOCK", LongShort: "Long", Quantity: "1", AveragePrice: "200", Last: "201" }];

  const on = await serviceOver({ TRADESTATION_ALLOW_SIM: "true" });
  const opts = (await on.req("/v1/options")).json;
  assert.deepEqual(opts.options.find((/** @type {any} */ o) => o.brokerId === "tradestation" && o.client === "user").environments, ["production", "paper"]);
  const r = await login({ token: OWNER(), start: { clientId: key1.clientId, clientSecret: key1.clientSecret, environment: "paper" } }, on);
  assert.equal(r.failedAt, undefined, JSON.stringify(r.res?.json));
  const paper = /** @type {any} */ (r.connection);
  assert.equal(paper.environment, "paper");
  assert.deepEqual(
    paper.accounts.map((/** @type {any} */ a) => [a.label, a.type]),
    [["TradeStation Paper", "paper"]],
  );
  const simCalls = fake.state.calls.filter((x) => x.host === "sim").length;
  const read = await on.req("/v1/portfolio");
  assert.equal(read.json.accounts.length, 1);
  assert.equal(read.json.accounts[0].netLiq, 100000);
  assert.ok(fake.state.calls.filter((x) => x.host === "sim").length > simCalls, "read from the SIM host");

  // The main service has SIM off.
  h.advance(MIN);
  const off = await req("/v1/portfolio", { token: OWNER() });
  assert.equal(errorOf(off.json, paper.id).message, TRADESTATION_DETAIL.simOff);
  assert.equal(row(paper.id)?.status, "error");
  assert.equal(row(paper.id)?.status_detail, TRADESTATION_DETAIL.simOff);
  const quiet = await req("/v1/portfolio", { token: OWNER() });
  assert.equal(errorOf(quiet.json, paper.id), undefined, "an error connection is not read again");
  simId = paper.id;
});

test(
  "SIM off: Reconnect of a SIM connection is refused up front, and the connection keeps its sentence and its tokens",
  async () => {
    assert.ok(simId);
    const b = newBinding();
    const renew = await req(`/v1/connections/${simId}/renew`, { method: "POST", token: OWNER(), body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(renew.status, 409, renew.text);
    assert.equal(renew.json.code, "sim_off");
    assert.equal(renew.json.error, TRADESTATION_DETAIL.simOff);
    h.advance(11 * MIN);
    await h.svc.scheduler.tick();
    assert.equal(row(simId)?.status, "error");
    assert.equal(row(simId)?.status_detail, TRADESTATION_DETAIL.simOff);
    assert.ok((await secretOf(simId))?.refreshToken, "the tokens stay for when SIM is offered again");
  },
);

test("SIM off: whatever Reconnect answers, TradeStation's sign-in is never opened for a SIM connection (the hop refuses it)", async () => {
  assert.ok(simId);
  const authorizeCalls = fake.state.calls.filter((x) => x.host === "signin" && x.path === "/authorize").length;
  const b = newBinding();
  const renew = await req(`/v1/connections/${simId}/renew`, { method: "POST", token: OWNER(), body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  const hop = await req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: simId, binding: b.nonce } });
  assert.notEqual(hop.status, 200, hop.text);
  if (renew.status === 200) {
    // A Reconnect that handed out a login (flows.genericRenew refuses it up front now): the hop refuses it too.
    assert.equal(renew.json.next?.kind, "redirect");
    assert.equal(hop.status, 409);
    assert.equal(hop.json.code, "sim_off");
    assert.equal(hop.json.error, TRADESTATION_DETAIL.simOff);
  } else {
    assert.equal(renew.status, 409, renew.text);
    assert.equal(renew.json.code, "sim_off");
  }
  assert.equal(fake.state.calls.filter((x) => x.host === "signin" && x.path === "/authorize").length, authorizeCalls, "no TradeStation page was opened");
});

test("a login without ReadAccount, or without lasting access, is refused after the sign-in with what to ask TradeStation for", async () => {
  const noRead = addKey({ scopes: [], callbacks: [CALLBACK] });
  const a = await login({ token: OWNER(), start: { clientId: noRead.clientId, clientSecret: noRead.clientSecret } });
  assert.equal(a.failedAt, "complete");
  assert.equal(a.res.status, 400);
  assert.equal(a.res.json.error, TRADESTATION_MESSAGES.noReadScope);
  assert.equal(row(/** @type {string} */ (a.connectionId)), undefined, "the attempt is removed");

  const noOffline = addKey({ offline: false, callbacks: [CALLBACK] });
  const b = await login({ token: OWNER(), start: { clientId: noOffline.clientId, clientSecret: noOffline.clientSecret } });
  assert.equal(b.failedAt, "complete");
  assert.equal(b.res.json.error, TRADESTATION_MESSAGES.noRefresh);

  const wrong = addKey({ callbacks: [CALLBACK] });
  const c = await login({ token: OWNER(), start: { clientId: wrong.clientId, clientSecret: "not-the-secret" } });
  assert.equal(c.failedAt, "complete");
  assert.equal(c.res.status, 400);
  assert.equal(c.res.json.code, "oauth_client_rejected");
});

test("checkClient (the adapter's key check, for flows.startOAuth to call) refuses a legacy key with a sentence asking for a newer key", () => {
  const adapter = /** @type {any} */ (h.svc.registry.get("tradestation_oauth"));
  assert.equal(typeof adapter.checkClient, "function");
  assert.throws(
    () => adapter.checkClient({ clientId: "EAC7BF97-1A2B-4C3D-8E9F-0123456789AB", clientSecret: "x" }),
    (/** @type {unknown} */ e) => e instanceof HttpError && e.status === 400 && e.code === "tradestation_legacy_key" && e.message === TRADESTATION_MESSAGES.legacyKey,
  );
  assert.doesNotThrow(() => adapter.checkClient({ clientId: key1.clientId, clientSecret: key1.clientSecret }));
});

test(
  "a legacy key is refused when the login starts: 400 tradestation_legacy_key and no connection",
  async () => {
    const legacy = "EAC7BF97-1A2B-4C3D-8E9F-0123456789AB";
    const count = h.rows("broker_connections").length;
    const b = newBinding();
    const r = await req("/v1/oauth/start", {
      method: "POST",
      token: OWNER(),
      body: { brokerId: "tradestation", clientId: legacy, clientSecret: "legacy-secret-0001", returnOrigin: "http://localhost:3000", bindingHash: b.hash },
    });
    try {
      assert.equal(r.status, 400, r.text);
      assert.equal(r.json.code, "tradestation_legacy_key");
      assert.equal(r.json.error, TRADESTATION_MESSAGES.legacyKey);
      assert.equal(h.rows("broker_connections").length, count, "no connection row");
    } finally {
      // Should the check ever regress: remove the attempt so the tests after see no stray connection.
      if (r.status === 200 && r.json?.connectionId) await req(`/v1/connections/${r.json.connectionId}`, { method: "DELETE", token: OWNER() });
    }
  },
);

test("disconnect deletes the key and tokens and never calls /oauth/revoke", async () => {
  const r = await req(`/v1/connections/${liveId}`, { method: "DELETE", token: OWNER() });
  assert.equal(r.status, 200, r.text);
  assert.equal(row(liveId)?.status, "disconnected");
  assert.equal(h.rows("broker_secrets").some((s) => s.connection_id === liveId), false);
  assert.equal(fake.state.revokeCalls, 0);
  assert.equal(fake.state.tradeCalls, 0);
});

test("no secret leaks: no token, code, key or secret in a log line, a reply, or a database table in the clear", () => {
  const secrets = fake.state.issued;
  assert.ok(secrets.length > 20);
  const logs = h.logLines.join("\n");
  const said = replies.join("\n");
  const tables = JSON.stringify([...h.db.tables.entries()]);
  for (const s of secrets) {
    assert.equal(logs.includes(s), false, "a log line holds a secret");
    assert.equal(said.includes(s), false, "a reply holds a secret");
    assert.equal(tables.includes(s), false, "a table holds a secret in the clear");
  }
  // An API key id is not a secret (it is in the authorize URL the browser opens), but it is never logged or stored in the clear.
  for (const id of clientIds) {
    assert.equal(logs.includes(id), false, "a log line holds an API key id");
    assert.equal(tables.includes(id), false, "a table holds an API key id in the clear");
  }
  assert.equal(logs.includes("code="), false);
  assert.equal(logs.includes("state="), false);
});
