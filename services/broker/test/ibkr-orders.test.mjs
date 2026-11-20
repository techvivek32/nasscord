import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { GatewayHttpError, IBKR_READ_ALLOW, IBKR_TRADE_ALLOW, isGatewayAllowed } from "../src/ibkr/gateway-http.mjs";
import { createBrokerService } from "../src/server.mjs";
import { call, jwtFor, listen, sleep, testConfig } from "./helpers/common.mjs";
import { createGatewayState, fakeBundle, fakeGatewaySpawner, freePorts, IBKR_MESSAGE_TEXT } from "./helpers/fake-gateway.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/**
 * IBKR order entry end to end: the real IBKR adapter, gateway manager, keepalive and order core,
 * through the HTTP API, against the fake gateway on 127.0.0.1 (never IBKR). The fake enforces
 * IBKR's pacing of the orders and trades lists, and answers IBKR's empty pre-flight first.
 *
 * One clock for the service, the gateway client and the fake: Date.now runs with an offset that
 * the tests move forward (advance) between steps, or run fast (pumped) while a step waits for the
 * next paced slot, so the 5 s pacing does not make the suite slow.
 */

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
/** @param {number} ms */
const advance = (ms) => {
  offset += ms;
};
/**
 * Runs the clock five times faster while `p` is pending.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<T>}
 */
async function pumped(p) {
  const timer = setInterval(() => {
    offset += 125;
  }, 25);
  try {
    return await p;
  } finally {
    clearInterval(timer);
  }
}

const user = randomUUID();
const wid = randomUUID();
const token = () => jwtFor({ sub: user, wid });
const state = createGatewayState();
state.accounts = ["U1234567"];
state.preflight = true;
state.enforcePacing = true;
const runtime = mkdtempSync(path.join(os.tmpdir(), "nasscord-rt-"));
const bundle = fakeBundle();

/** @type {ReturnType<typeof createMemoryDb>} */
let db;
/** @type {ReturnType<typeof createBrokerService>} */
let svc;
/** @type {Awaited<ReturnType<typeof listen>>} */
let apiServer;
let connectionId = "";
let accountId = "";
let port = 0;
/** @type {any} the gateway client, called directly by the allowlist test */
let gw;

before(async () => {
  const ports = await freePorts(2);
  db = createMemoryDb();
  db.tables.set("workspaces", [{ id: wid, name: "Swing Desk", status: "active", orders_enabled: true, owner_id: user }]);
  db.tables.set("members", [{ user_id: user, email: "trader.one@example.com", role: "trader", workspace_id: wid }]);
  svc = createBrokerService(
    testConfig({
      IBKR_GATEWAY_BUNDLE: bundle,
      IBKR_GATEWAY_RUNTIME: runtime,
      IBKR_GATEWAY_PORTS: `${ports[0]}-${ports[1]}`,
      PUBLIC_LOGIN_URL: "http://localhost:8711",
      IBKR_STOP_ORDERS: "on",
      IBKR_BRACKETS: "on",
    }),
    { db, spawn: fakeGatewaySpawner(state) },
  );
  gw = svc.gw;
  apiServer = await listen((req, res) => svc.api.handle(req, res));
});

after(async () => {
  svc.sessions.stopAll();
  await svc.manager.stopAll();
  await apiServer?.close();
  rmSync(runtime, { recursive: true, force: true });
  rmSync(bundle, { recursive: true, force: true });
  Date.now = realNow;
});

// Every test starts with fresh rate windows and open pacing slots, and never breaks IBKR's pacing.
let violationsBefore = 0;
beforeEach(() => {
  advance(61_000);
  violationsBefore = state.pacingViolations;
});
afterEach(() => assert.equal(state.pacingViolations, violationsBefore, "Nasscord never broke IBKR's pacing"));

/**
 * @param {string} p
 * @param {{ method?: string, body?: unknown, token?: string }} [o]
 */
const api = (p, o = {}) => call(`${apiServer.url}${p}`, { ...o, token: o.token ?? token() });
/** @param {Record<string, unknown>} t */
const preview = (t) => api("/v1/orders/preview", { method: "POST", body: { accountId, ...t } });
/** @param {string} requestId @param {Record<string, unknown>} [o] */
const place = (requestId, o = {}) => api("/v1/orders/place", { method: "POST", body: { requestId, acknowledged: [], ...o } });
/** @param {string} orderId */
const cancel = (orderId) => api("/v1/orders/cancel", { method: "POST", body: { accountId, orderId } });
/** @param {string} t */
const rows = (t) => db.tables.get(t) ?? [];
const mark = () => state.requests.length;
/** @param {number} n */
const since = (n) => state.requests.slice(n);
/** @param {typeof state.requests} list */
const orderPosts = (list) => list.filter((q) => q.method === "POST" && /^\/v1\/api\/iserver\/account\/[A-Z0-9]+\/orders$/.test(q.path));
/** @param {typeof state.requests} list */
const replyPosts = (list) => list.filter((q) => q.method === "POST" && q.path.startsWith("/v1/api/iserver/reply/"));
/** @param {typeof state.requests} list */
const deletes = (list) => list.filter((q) => q.method === "DELETE");
/** @param {typeof state.requests} list */
const ordersReads = (list) => list.filter((q) => q.path === "/v1/api/iserver/account/orders");
/** @param {any} view @param {string} code */
const hasWarning = (view, code) => (view?.preview?.warnings ?? []).some((/** @type {any} */ w) => w.code === code);
/** @param {any} view */
const ibkrWarnings = (view) => (view?.preview?.warnings ?? []).map((/** @type {any} */ w) => w.code).filter((/** @type {string} */ c) => c.startsWith("ibkr_"));
const conn = () => rows("broker_connections").find((c) => c.id === connectionId);

const AAPL = 265598;
const LMT_BUY = Object.freeze({ symbol: "AAPL", side: "BUY", quantity: 10, type: "LMT", limitPrice: 185.5, tif: "DAY" });
const BASE = Object.freeze({ acctId: "U1234567", conid: AAPL, outsideRTH: false });

/**
 * A preview that must succeed.
 * @param {Record<string, unknown>} t
 */
async function previewOk(t) {
  const r = await pumped(preview(t));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.request.status, "preview");
  return r.json.request;
}

/** The fake's live order of a client order id. @param {string} coid */
const liveOf = (coid) => state.liveOrders.find((o) => o.order_ref === coid);

test("connect: a live IBKR login with one account; capabilities with stops and brackets switched on", async () => {
  const r = await api("/v1/ibkr/start", { method: "POST", body: { environment: "production" } });
  assert.equal(r.status, 200, r.text);
  connectionId = r.json.connectionId;
  assert.equal(await svc.manager.whenReady(connectionId), true);
  state.loggedIn = true;
  await svc.sessions.tick(connectionId);
  assert.equal(conn()?.status, "active");
  const account = rows("broker_accounts").find((a) => a.connection_id === connectionId);
  accountId = String(account?.id);
  port = /** @type {number} */ (svc.manager.portFor(connectionId));

  const caps = await api("/v1/orders/capabilities");
  assert.equal(caps.status, 200, caps.text);
  assert.equal(caps.json.enabled, true);
  const c = caps.json.connections[connectionId];
  assert.deepEqual(c.types, ["MKT", "LMT", "STP", "STP_LMT"]);
  assert.deepEqual(c.tif, ["DAY", "GTC"]);
  assert.equal(c.marketGtc, true);
  assert.deepEqual(c.bracket, { entryTypes: ["MKT", "LMT"], stopTypes: ["STP"] });
  assert.deepEqual(c.notes, [
    "IBKR may ask you to confirm an order, for example one without market data. Nasscord shows IBKR's words and sends nothing until you confirm.",
    "Trade class shares such as BRK B from their row in Positions; Nasscord cannot look them up by symbol at IBKR yet.",
  ]);
});

test("allowlists: order calls only through the order door, and never suppress, notification, switch, modify or cancel-all", async () => {
  const before = mark();
  assert.equal(isGatewayAllowed(IBKR_READ_ALLOW, "GET", "/iserver/account/orders"), true);
  assert.equal(isGatewayAllowed(IBKR_READ_ALLOW, "GET", "/iserver/account/trades?days=7"), true);
  for (const p of [
    "/iserver/account/orders?force=true",
    "/iserver/account/orders?filters=Submitted",
    "/iserver/account/trades?days=8",
    "/iserver/account/trades?days=1&x=1",
    "/iserver/account/../orders",
    "/iserver//accounts",
    "/iserver/%2e%2e/accounts",
    "/iserver/accounts#x",
    "/portfolio/U1/summary/../../iserver/accounts",
  ]) {
    assert.equal(isGatewayAllowed(IBKR_READ_ALLOW, "GET", p), false, p);
  }
  assert.equal(isGatewayAllowed(IBKR_TRADE_ALLOW, "DELETE", "/iserver/account/U1234567/order/123"), true);
  assert.equal(isGatewayAllowed(IBKR_TRADE_ALLOW, "POST", "/iserver/reply/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"), true);
  /** @type {Array<[string, string, unknown]>} */
  const forbidden = [
    ["POST", "/iserver/questions/suppress", { messageIds: ["o354"] }],
    ["POST", "/iserver/questions/suppress/reset", {}],
    ["POST", "/iserver/notification", { orderId: 1, reqId: "1", text: "Always use" }],
    ["POST", "/iserver/account", { acctId: "U1234567" }],
    ["POST", "/iserver/account/U1234567/order/123", { price: 1 }],
    ["DELETE", "/iserver/account/U1234567/order/-1", undefined],
    ["GET", "/iserver/account/orders?force=true", undefined],
    ["GET", "/iserver/account/orders?filters=Submitted", undefined],
    ["POST", "/iserver/account/U1234567/orders?x=1", { orders: [] }],
    ["GET", "/iserver/marketdata/snapshot?conids=265598&fields=31,84,86,7295", undefined],
    ["DELETE", "/iserver/account/u1234567/order/5", undefined],
    ["POST", "/iserver/account/DU1/orders/../orders", { orders: [] }],
  ];
  for (const [m, p] of forbidden) assert.equal(isGatewayAllowed(IBKR_TRADE_ALLOW, m, p), false, `${m} ${p}`);

  // request(): the read door refuses every order call and everything above
  /** @type {Array<[string, string, unknown]>} */
  const orderCalls = [
    ["POST", "/iserver/account/U1234567/orders", { orders: [] }],
    ["POST", "/iserver/account/U1234567/orders/whatif", { orders: [] }],
    ["POST", "/iserver/reply/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", { confirmed: true }],
    ["DELETE", "/iserver/account/U1234567/order/123", undefined],
    ["POST", "/iserver/auth/ssodh/init", { publish: true, compete: true }],
  ];
  for (const [m, p, b] of [...forbidden, ...orderCalls]) {
    await assert.rejects(gw.request(connectionId, port, m, p, b), ReadOnlyViolation, `request ${m} ${p}`);
  }
  // trade(): the order door refuses the forbidden list, and paced reads must use pacedGet
  for (const [m, p, b] of forbidden) await assert.rejects(gw.trade(connectionId, port, m, p, b), ReadOnlyViolation, `trade ${m} ${p}`);
  await assert.rejects(gw.trade(connectionId, port, "GET", "/iserver/account/orders"), (e) => e instanceof GatewayHttpError && e.code === "bad_path");
  await assert.rejects(gw.trade(connectionId, port, "GET", "/portfolio/accounts"), ReadOnlyViolation);
  await assert.rejects(gw.trade(connectionId, 1, "GET", "/iserver/accounts"), (e) => e instanceof GatewayHttpError && e.code === "bad_port");
  // pacedGet(): only the two paced paths, without a query on the orders list
  await assert.rejects(gw.pacedGet(connectionId, port, "/iserver/account/orders?force=true"), ReadOnlyViolation);
  await assert.rejects(gw.pacedGet(connectionId, port, "/iserver/questions/suppress"), ReadOnlyViolation);
  await assert.rejects(gw.pacedGet(connectionId, port, "/iserver/account/trades?days=9"), ReadOnlyViolation);
  await assert.rejects(gw.pacedGet(connectionId, port, "/iserver/accounts"), (e) => e instanceof GatewayHttpError && e.code === "bad_path");
  assert.equal(mark(), before, "nothing reached the gateway");

  // the read path and the keepalive still go through
  const status = await gw.get(connectionId, port, "/iserver/auth/status");
  assert.equal(status.status, 200);
});

test("preview then place a Limit buy: snapshot before what-if, no cOID in the what-if, the exact order body, one send", async () => {
  const n = mark();
  const v = await previewOk(LMT_BUY);
  assert.match(v.clientOrderId, /^nc[0-9a-f]{18}$/);
  assert.deepEqual(v.preview.instrument, { name: "APPLE INC", exchange: "NASDAQ" });
  assert.equal(v.preview.referencePrice, 185.12, "the midpoint of IBKR's bid and ask");
  assert.deepEqual(v.preview.quote, { source: "IBKR snapshot", bid: 185.1, ask: 185.14, last: 185.2 });
  assert.equal(v.preview.estimate.source, "IBKR");
  assert.equal(v.preview.estimate.notional, 1855);
  assert.equal(v.preview.estimate.commission, 1);
  assert.equal(v.preview.estimate.total, 1856);
  assert.deepEqual(v.preview.estimate.brokerText, { amount: "1,855.00 USD (10 Shares)", commission: "1 USD", total: "1,856.00 USD" });
  assert.deepEqual(v.preview.notices, []);
  assert.deepEqual(v.preview.position, { before: 0, after: 10 });

  const s = since(n);
  const paths = s.map((q) => `${q.method} ${q.path}`);
  assert.ok(paths.includes("GET /v1/api/trsrv/stocks?symbols=AAPL"));
  const snaps = paths.filter((p) => p.startsWith("GET /v1/api/iserver/marketdata/snapshot?conids=265598&fields=31,84,86"));
  assert.equal(snaps.length, 2, "the first snapshot is IBKR's pre-flight, so it is asked again");
  const iSnap = paths.findIndex((p) => p.includes("/marketdata/snapshot"));
  const iWhat = paths.findIndex((p) => p.endsWith("/orders/whatif"));
  assert.ok(iSnap >= 0 && iWhat > iSnap, "the snapshot precedes the what-if");
  assert.equal(paths[iWhat], "POST /v1/api/iserver/account/U1234567/orders/whatif");
  assert.deepEqual(JSON.parse(s[iWhat].body), { orders: [{ ...BASE, side: "BUY", quantity: 10, tif: "DAY", orderType: "LMT", price: 185.5 }] });
  const rules = s.find((q) => q.path === "/v1/api/iserver/contract/rules");
  assert.deepEqual(JSON.parse(String(rules?.body)), { conid: AAPL, isBuy: true });
  assert.equal(orderPosts(s).length, 0, "a preview sends no order");
  assert.equal(ordersReads(s).length, 0, "a buy without a short reads no orders list");

  const n2 = mark();
  const p = await place(v.id);
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.request.status, "placed", p.text);
  const posts = orderPosts(since(n2));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/v1/api/iserver/account/U1234567/orders");
  assert.deepEqual(JSON.parse(posts[0].body), {
    orders: [{ ...BASE, side: "BUY", quantity: 10, tif: "DAY", orderType: "LMT", price: 185.5, cOID: v.clientOrderId }],
  });
  const live = liveOf(v.clientOrderId);
  assert.equal(p.json.request.brokerOrderId, String(live.orderId));
  assert.ok(since(n2).some((q) => q.path === `/v1/api/iserver/account/order/status/${live.orderId}`), "the order is read back");
  assert.deepEqual(ibkrWarnings(p.json.request), []);

  const again = await place(v.id);
  assert.equal(again.json.request.status, "placed");
  assert.equal(orderPosts(since(n2)).length, 1, "a replay sends nothing");
});

test("contract lookup: one US contract only, class shares from their Positions row, never [0]", async () => {
  state.contracts.TWO = [{ name: "TWO INC", assetClass: "STK", contracts: [{ conid: 11, exchange: "NYSE", isUS: true }, { conid: 12, exchange: "ARCA", isUS: true }] }];
  try {
    const two = await preview({ ...LMT_BUY, symbol: "TWO", limitPrice: 10 });
    assert.equal(two.status, 400, two.text);
    assert.equal(two.json.code, "not_tradable");
    assert.equal(two.json.error, "IBKR does not list a single US stock or ETF for TWO.");
  } finally {
    delete state.contracts.TWO;
  }

  let n = mark();
  const typed = await preview({ ...LMT_BUY, symbol: "BRK.B", limitPrice: 480 });
  assert.equal(typed.status, 400, typed.text);
  assert.equal(typed.json.code, "not_tradable");
  assert.equal(
    typed.json.error,
    "IBKR orders for BRK.B are not available by symbol in Nasscord yet. Trade class shares such as BRK.B from their row in Positions, or in IBKR.",
  );
  assert.ok(!since(n).some((q) => q.path.startsWith("/v1/api/trsrv/stocks")));

  n = mark();
  const row = await previewOk({ ...LMT_BUY, symbol: "BRK B", quantity: 1, limitPrice: 480, positionId: `ibkr:${accountId}:72063691` });
  assert.equal(row.ticket.symbol, "BRK.B");
  assert.equal(row.preview.instrument.name, "BERKSHIRE HATHAWAY INC-CL B");
  assert.equal(row.preview.referencePrice, 480);
  assert.equal(row.preview.quote.last, 480, "the C prefix (close) is dropped");
  assert.ok(!since(n).some((q) => q.path.startsWith("/v1/api/trsrv/stocks")), "the position's conid, no symbol lookup");
  const whatif = since(n).find((q) => q.path.endsWith("/orders/whatif"));
  assert.equal(JSON.parse(String(whatif?.body)).orders[0].conid, 72063691);

  // IBKR prices in steps: 185.5 sits on a 0.01 step (no floating point remainder), 185.555 is refused by the ticket rules
  state.rulesPatch = { incrementRules: [{ lowerEdge: 0, increment: 0.05 }] };
  try {
    const off = await preview({ ...LMT_BUY, limitPrice: 185.52 });
    assert.equal(off.status, 400, off.text);
    assert.equal(off.json.error, "IBKR takes prices for AAPL in steps of $0.0500.");
    await previewOk({ ...LMT_BUY, limitPrice: 185.55 });
  } finally {
    state.rulesPatch = {};
  }
});

test("ready: paper and live mismatch, manual order time, a competing session and a second account are refused with no order sent", async () => {
  const c = /** @type {any} */ (conn());
  c.environment = "paper";
  try {
    const r = await preview(LMT_BUY);
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, "environment_mismatch");
    assert.equal(r.json.error, "This is a live IBKR login, but the connection is saved as Paper. Nothing was sent. Reconnect IBKR with the right username.");
  } finally {
    c.environment = "production";
  }

  state.isPaper = true;
  try {
    const r = await preview(LMT_BUY);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "This is a paper IBKR login, but the connection is saved as Live. Nothing was sent. Reconnect IBKR with the right username.");
  } finally {
    state.isPaper = false;
  }

  // at place time the same check refuses before the order POST
  const v = await previewOk({ ...LMT_BUY, quantity: 2 });
  state.isPaper = true;
  const n = mark();
  try {
    const p = await place(v.id);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.request.status, "rejected");
    assert.match(p.json.request.error, /This is a paper IBKR login/);
    assert.equal(orderPosts(since(n)).length, 0);
  } finally {
    state.isPaper = false;
  }

  state.acctProps.U1234567 = { allowCustomerTime: true };
  try {
    const r = await preview(LMT_BUY);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "not_tradable");
    assert.equal(r.json.error, "This IBKR account needs a manual order time, which Nasscord does not send. Place orders for it in IBKR.");
  } finally {
    state.acctProps = {};
  }

  state.competing = true;
  try {
    const r = await preview(LMT_BUY);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "connection_not_live");
    assert.match(r.json.error, /^Another session \(TWS or the IBKR mobile app\) is using this IBKR username/);
  } finally {
    state.competing = false;
    await svc.sessions.tick(connectionId);
  }

  // IBKR lists two accounts for the login: refused at the gateway (D19)
  state.accounts = ["U1234567", "U7654321"];
  try {
    const r = await preview(LMT_BUY);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "multi_account_login");
    assert.equal(r.json.error, "Nasscord places IBKR orders only for logins with one account for now. This login has 2 accounts: place their orders in IBKR.");
  } finally {
    state.accounts = ["U1234567"];
  }

  // the connection holds two accounts: blocked in capabilities and refused at preview
  const extra = { id: randomUUID(), connection_id: connectionId, workspace_id: wid, broker_id: "ibkr", external_id: "U7654321", display_number: "U76•••21", label: "Swing", type: "individual", included: true };
  rows("broker_accounts").push(extra);
  try {
    const caps = await api("/v1/orders/capabilities");
    assert.equal(caps.json.connections[connectionId], undefined);
    assert.equal(
      caps.json.blocked[connectionId],
      "Nasscord places IBKR orders only for logins with one account for now. This login has 2 accounts: place their orders in IBKR.",
    );
    const r = await preview(LMT_BUY);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "broker_read_only");
  } finally {
    db.tables.set("broker_accounts", rows("broker_accounts").filter((a) => a.id !== extra.id));
  }
  assert.equal(orderPosts(since(n)).length, 0);
});

test("no short: working sells count against a Sell and block a Close; an incomplete orders list sends nothing", async () => {
  state.positions2.U1234567 = [{ acctId: "U1234567", conid: AAPL, contractDesc: "AAPL", position: 100 }];
  const stop = {
    acct: "U1234567",
    orderId: 990001,
    conid: AAPL,
    ticker: "AAPL",
    side: "SELL",
    totalSize: 100,
    filledQuantity: 0,
    remainingQuantity: 100,
    orderType: "Stop",
    price: 170,
    timeInForce: "GTC",
    status: "PreSubmitted",
    ticket: { orderType: "STP", price: 170, tif: "GTC" },
  };
  state.liveOrders.push(stop);

  // the first orders list of the session is IBKR's empty pre-flight: read again 5 s later
  let n = mark();
  const sell = await pumped(preview({ symbol: "AAPL", side: "SELL", quantity: 100, type: "LMT", limitPrice: 186, tif: "DAY" }));
  assert.equal(sell.status, 400, sell.text);
  assert.equal(sell.json.code, "no_short");
  assert.equal(
    sell.json.error,
    "You hold 100 AAPL in this account and working sell orders already cover 100. Nasscord sells at most the 0 shares they do not cover, and does not sell short.",
  );
  const reads = ordersReads(since(n));
  assert.equal(reads.length, 2);
  assert.ok(reads[1].at - reads[0].at >= 5_000, "the second list came at least 5 s after the pre-flight");

  n = mark();
  const close = await pumped(
    preview({ symbol: "AAPL", side: "SELL", quantity: 100, type: "LMT", limitPrice: 186, tif: "DAY", intent: "close", positionId: `ibkr:${accountId}:${AAPL}`, expectedPositionQty: 100 }),
  );
  assert.equal(close.status, 409, close.text);
  assert.equal(close.json.code, "working_sells");
  assert.ok(!since(n).some((q) => q.path.startsWith("/v1/api/trsrv/stocks")), "a Close uses the position's conid");

  stop.status = "Cancelled";
  advance(6_000);
  state.ordersQueue.push({ body: { orders: [], snapshot: false } }, { body: { orders: [], snapshot: false } });
  const unread = await pumped(preview({ symbol: "AAPL", side: "SELL", quantity: 10, type: "LMT", limitPrice: 186, tif: "DAY" }));
  assert.equal(unread.status, 409, unread.text);
  assert.equal(unread.json.code, "working_orders_unreadable");
  assert.equal(state.ordersQueue.length, 0);

  // a Sell previewed with a complete list, then the list cannot be read at place time: nothing is sent
  advance(6_000);
  const v = await previewOk({ symbol: "AAPL", side: "SELL", quantity: 10, type: "LMT", limitPrice: 186, tif: "DAY" });
  advance(6_000);
  state.ordersQueue.push({ body: { orders: [], snapshot: false } }, { body: { orders: [], snapshot: false } });
  n = mark();
  const p = await pumped(place(v.id));
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.request.status, "rejected");
  assert.equal(
    p.json.request.error,
    "IBKR did not list your working orders, so Nasscord cannot check them against this order. Nothing was placed. Try again in a few seconds.",
  );
  assert.equal(orderPosts(since(n)).length, 0);
  state.ordersQueue = [];
  state.positions2 = {};
});

test("IBKR questions: o10151 confirmed with its notice; o354 asks the user, then a new attempt with a new cOID", async () => {
  // Market order: the market notice was shown and acknowledged, so o10151 is confirmed automatically
  const m = await previewOk({ symbol: "AAPL", side: "BUY", quantity: 1, type: "MKT", tif: "DAY" });
  assert.deepEqual(m.preview.notices.map((/** @type {any} */ x) => x.key), ["ibkr.market_order"]);
  state.placeQueue.push({ reply: ["o10151"] }, "ok");
  let n = mark();
  const pm = await place(m.id, { acknowledged: ["ibkr.market_order"] });
  assert.equal(pm.json.request.status, "placed", pm.text);
  const replies = replyPosts(since(n));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].path, `/v1/api/iserver/reply/${state.questions.at(-1)?.id}`);
  assert.deepEqual(JSON.parse(replies[0].body), { confirmed: true });

  // o354 (no market data): never confirmed by Nasscord on its own
  const v = await previewOk({ ...LMT_BUY, quantity: 2 });
  state.placeQueue.push({ reply: ["o354"] });
  n = mark();
  const p1 = await place(v.id);
  assert.equal(p1.json.request.status, "needs_confirmation", p1.text);
  assert.deepEqual(p1.json.request.brokerMessages, [{ id: "o354", text: IBKR_MESSAGE_TEXT.o354 }]);
  assert.equal(replyPosts(since(n)).length, 0, "no reply call");
  const first = orderPosts(since(n));
  assert.equal(first.length, 1);
  const firstCoid = JSON.parse(first[0].body).orders[0].cOID;
  assert.equal(firstCoid, v.clientOrderId);
  assert.notEqual(p1.json.request.clientOrderId, firstCoid, "the next attempt has its own client order id");

  advance(6_000);
  state.placeQueue.push({ reply: ["o354"] }, "ok");
  n = mark();
  const p2 = await pumped(place(v.id, { confirmBrokerMessages: ["o354"] }));
  assert.equal(p2.json.request.status, "placed", p2.text);
  const s = since(n);
  const iPost = s.findIndex((q) => q.method === "POST" && /\/orders$/.test(q.path));
  const iList = s.findIndex((q) => q.path === "/v1/api/iserver/account/orders");
  const iTrades = s.findIndex((q) => q.path === "/v1/api/iserver/account/trades?days=1");
  assert.ok(iList >= 0 && iTrades > iList && iPost > iTrades, "the earlier attempt is looked for in complete lists before a new send");
  const second = JSON.parse(s[iPost].body).orders[0].cOID;
  assert.notEqual(second, firstCoid);
  assert.equal(second, p2.json.request.clientOrderId);
  assert.equal(replyPosts(s).length, 1, "the approved message is confirmed in the new attempt");
  assert.equal(p2.json.request.brokerOrderId, String(liveOf(second).orderId));
});

test("IBKR questions: an approved message whose text changed asks again; a refused id is never answered", async () => {
  const v = await previewOk({ ...LMT_BUY, quantity: 3 });
  state.placeQueue.push({ reply: ["o354"] });
  const p1 = await place(v.id);
  assert.equal(p1.json.request.status, "needs_confirmation");
  state.messageText.o354 = "You are submitting an order without market data. This text is new.";
  try {
    advance(6_000);
    state.placeQueue.push({ reply: ["o354"] });
    const n = mark();
    const p2 = await place(v.id, { confirmBrokerMessages: ["o354"] });
    assert.equal(p2.json.request.status, "needs_confirmation", p2.text);
    assert.deepEqual(p2.json.request.brokerMessages, [{ id: "o354", text: state.messageText.o354 }]);
    assert.equal(replyPosts(since(n)).length, 0);
  } finally {
    delete state.messageText.o354;
  }

  const w = await previewOk({ ...LMT_BUY, quantity: 4 });
  state.placeQueue.push({ reply: ["o10334"] });
  const n = mark();
  const p = await place(w.id);
  assert.equal(p.json.request.status, "rejected", p.text);
  assert.equal(
    p.json.request.error,
    `IBKR asked to confirm something Nasscord does not send (${IBKR_MESSAGE_TEXT.o10334}). Nothing was placed. Place this order in IBKR instead.`,
  );
  assert.equal(replyPosts(since(n)).length, 0);
});

test("brackets: the exact body, a throwaway what-if id, roles from order status reads with the answers shuffled", async () => {
  const BR = { symbol: "AAPL", side: "BUY", quantity: 10, type: "LMT", limitPrice: 185, tif: "GTC", bracket: { takeProfit: { limitPrice: 190 }, stopLoss: { stopPrice: 180 } } };
  let n = mark();
  const v = await previewOk(BR);
  assert.deepEqual(v.preview.notices.map((/** @type {any} */ x) => x.key), ["ibkr.stop_order"]);
  const whatif = JSON.parse(String(since(n).find((q) => q.path.endsWith("/orders/whatif"))?.body));
  assert.equal(whatif.orders.length, 3);
  assert.match(whatif.orders[0].cOID, /^nw[0-9a-f]{18}$/);
  assert.notEqual(whatif.orders[0].cOID, v.clientOrderId);
  assert.equal(whatif.orders[1].parentId, whatif.orders[0].cOID);
  assert.equal(whatif.orders[2].parentId, whatif.orders[0].cOID);
  assert.ok(!("cOID" in whatif.orders[1]) && !("cOID" in whatif.orders[2]));

  n = mark();
  const p = await place(v.id, { acknowledged: ["ibkr.stop_order"] });
  assert.equal(p.json.request.status, "placed", p.text);
  const body = JSON.parse(orderPosts(since(n))[0].body);
  const c = v.clientOrderId;
  assert.deepEqual(body, {
    orders: [
      { ...BASE, side: "BUY", quantity: 10, tif: "GTC", orderType: "LMT", price: 185, cOID: c },
      { ...BASE, side: "SELL", quantity: 10, tif: "GTC", parentId: c, orderType: "STP", price: 180 },
      { ...BASE, side: "SELL", quantity: 10, tif: "GTC", parentId: c, orderType: "LMT", price: 190 },
    ],
  });
  const parent = liveOf(c);
  const kids = state.liveOrders.filter((o) => o.parentId === parent.orderId);
  const sl = kids.find((o) => o.orderType === "Stop");
  const tp = kids.find((o) => o.orderType === "Limit");
  assert.equal(p.json.request.brokerOrderId, String(parent.orderId));
  const byRole = Object.fromEntries(p.json.request.brokerOrderIds.map((/** @type {any} */ r) => [r.role, r.id]));
  assert.deepEqual(byRole, { entry: String(parent.orderId), stop_loss: String(sl.orderId), take_profit: String(tp.orderId) });
  assert.deepEqual(ibkrWarnings(p.json.request), []);
});

test("brackets: one question object per ticket is answered in order; a live part never becomes a question or a refusal", async () => {
  const MBR = { symbol: "AAPL", side: "BUY", quantity: 10, type: "MKT", tif: "GTC", bracket: { takeProfit: { limitPrice: 190 }, stopLoss: { stopPrice: 180 } } };
  const v = await previewOk(MBR);
  assert.deepEqual(v.preview.notices.map((/** @type {any} */ x) => x.key).sort(), ["ibkr.market_order", "ibkr.stop_order"]);
  state.placeQueue.push({ replies: [["o10151"], ["o10331"]] }, "ok", "ok");
  const asked = state.questions.length;
  let n = mark();
  const p = await place(v.id, { acknowledged: ["ibkr.market_order", "ibkr.stop_order"] });
  assert.equal(p.json.request.status, "placed", p.text);
  const ids = state.questions.slice(asked).map((q) => q.id);
  assert.deepEqual(replyPosts(since(n)).map((q) => q.path), ids.map((id) => `/v1/api/iserver/reply/${id}`));
  assert.equal(p.json.request.brokerOrderIds.length, 3);
  assert.deepEqual(p.json.request.brokerOrderIds.map((/** @type {any} */ r) => r.role).sort(), ["entry", "stop_loss", "take_profit"]);
  assert.deepEqual(ibkrWarnings(p.json.request), []);

  // the parent is live, a child asks o354: placed with the red warning, nothing more sent
  const w = await previewOk({ ...MBR, type: "LMT", limitPrice: 185, quantity: 5 });
  state.placeQueue.push({ partial: { ok: 1, reply: ["o354"] } });
  n = mark();
  const pp = await place(w.id, { acknowledged: ["ibkr.stop_order"] });
  assert.equal(pp.json.request.status, "placed", pp.text);
  assert.ok(hasWarning(pp.json.request, "ibkr_bracket_incomplete"));
  assert.equal(orderPosts(since(n)).length, 1);
  assert.equal(replyPosts(since(n)).length, 0);
  assert.equal(pp.json.request.brokerOrderId, String(liveOf(w.clientOrderId).orderId));
});

test("server prompts end placed with the waiting warning; Pending submit warns; an echo of another stop price warns", async () => {
  for (const entry of [{ promptObject: true }, { prompt: true }]) {
    const v = await previewOk({ ...LMT_BUY, quantity: 5 });
    state.placeQueue.push(entry);
    const n = mark();
    const p = await place(v.id);
    assert.equal(p.json.request.status, "placed", p.text);
    const w = p.json.request.preview.warnings.find((/** @type {any} */ x) => x.code === "ibkr_waiting_decision");
    assert.equal(w?.text, "IBKR is waiting for a decision on this order: Your order is subject to the price management algo. Finish it in IBKR, or cancel it here.");
    assert.equal(p.json.request.brokerOrderId, String(liveOf(v.clientOrderId).orderId));
    assert.equal(orderPosts(since(n)).length, 1);
    assert.equal(state.requests.filter((q) => q.path.includes("/iserver/notification")).length, 0);
  }

  const pend = await previewOk({ ...LMT_BUY, quantity: 6 });
  state.placeQueue.push("pending");
  const pp = await place(pend.id);
  assert.equal(pp.json.request.status, "placed");
  assert.ok(hasWarning(pp.json.request, "ibkr_pending_submit"));

  // a Stop: its stop goes in "price"; IBKR's order status shows another stop price
  const n = mark();
  const stp = await previewOk({ symbol: "AAPL", side: "BUY", quantity: 1, type: "STP", stopPrice: 190, tif: "DAY" });
  assert.deepEqual(JSON.parse(String(since(n).find((q) => q.path.endsWith("/orders/whatif"))?.body)).orders[0], {
    ...BASE,
    side: "BUY",
    quantity: 1,
    tif: "DAY",
    orderType: "STP",
    price: 190,
  });
  state.statusOverride[String(state.nextOrderId + 1)] = { stop_price: "191.00" };
  const ps = await place(stp.id, { acknowledged: ["ibkr.stop_order"] });
  assert.equal(ps.json.request.status, "placed", ps.text);
  assert.ok(hasWarning(ps.json.request, "ibkr_echo_mismatch"));

  // a Stop limit: the limit in "price", the stop in "auxPrice", IBKR's STOP_LIMIT
  const n2 = mark();
  await previewOk({ symbol: "AAPL", side: "BUY", quantity: 1, type: "STP_LMT", stopPrice: 190, limitPrice: 191, tif: "DAY" });
  assert.deepEqual(JSON.parse(String(since(n2).find((q) => q.path.endsWith("/orders/whatif"))?.body)).orders[0], {
    ...BASE,
    side: "BUY",
    quantity: 1,
    tif: "DAY",
    orderType: "STOP_LIMIT",
    price: 191,
    auxPrice: 190,
  });
});

test("a dropped answer is unknown and the reconcile finds the order by order_ref; a limiter refusal before the POST is rejected", async () => {
  const v = await previewOk({ ...LMT_BUY, quantity: 7 });
  state.placeQueue.push("drop");
  let n = mark();
  const p = await pumped(place(v.id));
  assert.equal(p.status, 200, p.text);
  assert.equal(orderPosts(since(n)).length, 1);
  let view = p.json.request;
  if (view.status !== "placed") {
    advance(6_000);
    view = (await pumped(api(`/v1/orders/requests/${v.id}`))).json.request;
  }
  assert.equal(view.status, "placed");
  assert.equal(view.brokerOrderId, String(liveOf(v.clientOrderId).orderId));
  await sleep(20);
  const audits = rows("audit_events").filter((a) => /** @type {any} */ (a.meta)?.requestId === v.id);
  assert.ok(audits.some((a) => a.action === "broker.order.place" && /** @type {any} */ (a.meta).outcome === "unknown"));
  assert.ok(audits.some((a) => a.action === "broker.order.reconcile" && /** @type {any} */ (a.meta).outcome === "placed"));
  assert.equal(orderPosts(since(n)).length, 1, "never a second order POST");

  // the IBKR limiter refuses the order POST itself: nothing left, so rejected (not unknown)
  const w = await previewOk({ ...LMT_BUY, quantity: 8 });
  let armed = true;
  state.onRequest = (q) => {
    if (armed && q.path === "/v1/api/iserver/accounts") {
      armed = false;
      svc.limiter.backoff(`ibkr:${connectionId}`, 8, 60_000);
    }
  };
  n = mark();
  try {
    const r = await place(w.id);
    assert.equal(r.json.request.status, "rejected", r.text);
    assert.equal(r.json.request.error, "IBKR is limiting requests right now. Nothing was placed. Try again in a few seconds.");
    assert.equal(orderPosts(since(n)).length, 0);
  } finally {
    state.onRequest = null;
    advance(61_000);
  }
});

test("after a new session: a 503 is unknown, the lists are read twice 5 s apart before found: false, and a paced read is found: null", async () => {
  // a new brokerage session: IBKR's first orders list is a pre-flight again
  await gw.post(connectionId, port, "/iserver/auth/ssodh/init", { publish: true, compete: false });
  const v = await previewOk({ ...LMT_BUY, quantity: 9 });
  state.placeQueue.push({ status: 503 });
  let n = mark();
  const p = await pumped(place(v.id));
  assert.equal(p.status, 200, p.text);
  assert.equal(orderPosts(since(n)).length, 1, "never a second order POST");
  assert.equal(p.json.request.status, "unknown");
  assert.equal(p.json.request.error, "IBKR does not list this order yet. That does not mean it was not placed. Check IBKR before you place it again.");
  const lists = ordersReads(since(n));
  assert.equal(lists.length, 2);
  assert.ok(lists[1].at - lists[0].at >= 5_000);
  const trades = since(n).filter((q) => q.path.startsWith("/v1/api/iserver/account/trades"));
  assert.deepEqual(trades.map((q) => q.path), ["/v1/api/iserver/account/trades?days=1", "/v1/api/iserver/account/trades?days=1"]);
  assert.ok(trades[1].at - trades[0].at >= 5_000);

  // IBKR answers 429 on the orders list: never retried, and the check says it could not look yet
  advance(16_000);
  state.ordersQueue.push({ status: 429, body: { error: "Too Many Requests" } });
  n = mark();
  const c = await pumped(api(`/v1/orders/requests/${v.id}/check`, { method: "POST" }));
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.request.status, "unknown");
  assert.match(c.json.request.error, /IBKR has not listed its orders yet\. Nasscord checks again in a few seconds\.$/);
  assert.equal(ordersReads(since(n)).length, 1);
  svc.cache.invalidate(connectionId);
  const read = await api("/v1/orders");
  assert.equal(ordersReads(since(n)).length, 1, "the read path does not retry a 429 either");
  assert.ok(read.status === 429 || (read.status === 200 && read.json.errors?.length), read.text);
  advance(16_000);
});

test("a portfolio read issued between the order POST and its reply waits until the reply is answered", async () => {
  const v = await previewOk({ symbol: "AAPL", side: "BUY", quantity: 1, type: "MKT", tif: "DAY" });
  state.placeQueue.push({ reply: ["o10151"] }, "ok");
  /** @type {Promise<any> | null} */
  let read = null;
  state.delayNextOrderMs = 300;
  state.onRequest = (q) => {
    if (!read && q.method === "POST" && /\/iserver\/account\/[A-Z0-9]+\/orders$/.test(q.path)) {
      svc.cache.invalidate(connectionId);
      read = api("/v1/portfolio");
    }
  };
  const n = mark();
  try {
    const p = await place(v.id, { acknowledged: ["ibkr.market_order"] });
    assert.equal(p.json.request.status, "placed", p.text);
  } finally {
    state.onRequest = null;
  }
  assert.ok(read);
  const r = await /** @type {Promise<any>} */ (read);
  assert.equal(r.status, 200, r.text);
  const s = since(n);
  const iReply = s.findIndex((q) => q.path.startsWith("/v1/api/iserver/reply/"));
  const iRead = s.findIndex((q) => q.path === "/v1/api/iserver/account/pnl/partitioned");
  assert.ok(iReply >= 0 && iRead > iReply, "the read reached the gateway only after the reply");
});

test("cancel: the exact DELETE without a body, never -1, IBKR's immediate cancel, and an incomplete list is busy", async () => {
  const v = await previewOk({ ...LMT_BUY, quantity: 11 });
  const placed = await place(v.id);
  const id = placed.json.request.brokerOrderId;
  assert.ok(id);

  advance(6_000);
  let n = mark();
  const c = await pumped(cancel(`ibkr:${accountId}:${id}`));
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json, {
    status: "cancel_requested",
    message: "IBKR received the cancel. The order shows as cancelled once IBKR confirms it, and it can still fill until then.",
  });
  const del = deletes(since(n));
  assert.equal(del.length, 1);
  assert.equal(del[0].path, `/v1/api/iserver/account/U1234567/order/${id}`);
  assert.equal(del[0].bodyLength, 0);
  assert.equal(del[0].headers["content-length"], "0");

  advance(6_000);
  n = mark();
  const again = await pumped(cancel(`ibkr:${accountId}:${id}`));
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.json, { status: "cancel_requested", message: "IBKR is already cancelling this order." });
  assert.equal(deletes(since(n)).length, 0);

  n = mark();
  const all = await cancel(`ibkr:${accountId}:-1`);
  assert.equal(all.status, 404, all.text);
  assert.equal(deletes(since(n)).length, 0, "-1 (every open order) is never sent");

  const w = await previewOk({ ...LMT_BUY, quantity: 12 });
  const p2 = await place(w.id);
  const id2 = p2.json.request.brokerOrderId;
  advance(6_000);
  state.cancelAnswer = { body: { msg: "Request was submitted", order_id: Number(id2), conid: "-1", account: null } };
  const now = await pumped(cancel(`ibkr:${accountId}:${id2}`));
  assert.equal(now.status, 200, now.text);
  assert.deepEqual(now.json, { status: "cancelled", message: "IBKR cancelled the order." });

  advance(6_000);
  state.ordersQueue.push({ body: { orders: [], snapshot: false } }, { body: { orders: [], snapshot: false } });
  n = mark();
  const busy = await pumped(cancel(`ibkr:${accountId}:${id2}`));
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.json.code, "busy");
  assert.equal(busy.json.error, "IBKR did not list its orders yet. Try the cancel again in a few seconds.");
  assert.equal(deletes(since(n)).length, 0);
  state.ordersQueue = [];
});

test("a reply acknowledgement sent as one bare object is placed, not unknown", async () => {
  // straight from the order POST
  const v = await previewOk({ ...LMT_BUY, quantity: 13 });
  state.placeQueue.push("okObject");
  let n = mark();
  const p = await place(v.id);
  assert.equal(p.json.request.status, "placed", p.text);
  assert.equal(p.json.request.brokerOrderId, String(liveOf(v.clientOrderId).orderId));
  assert.equal(orderPosts(since(n)).length, 1);

  // after a confirmed question: the reply answers a bare object
  const w = await previewOk({ symbol: "AAPL", side: "BUY", quantity: 14, type: "MKT", tif: "DAY" });
  state.placeQueue.push({ reply: ["o10151"] }, "okObject");
  n = mark();
  const q = await place(w.id, { acknowledged: ["ibkr.market_order"] });
  assert.equal(q.json.request.status, "placed", q.text);
  assert.equal(q.json.request.brokerOrderId, String(liveOf(w.clientOrderId).orderId));
  assert.equal(orderPosts(since(n)).length, 1);
  assert.equal(replyPosts(since(n)).length, 1);
});

test("no short at place time: a sell that fills while the working orders are read is caught by a second position read", async () => {
  state.positions2.U1234567 = [{ acctId: "U1234567", conid: AAPL, contractDesc: "AAPL", position: 100 }];
  const v = await previewOk({ symbol: "AAPL", side: "SELL", quantity: 50, type: "LMT", limitPrice: 186, tif: "DAY" });
  advance(6_000);
  // An outside sell of 70 fills while Nasscord waits for the live orders list: the list shows it
  // filled (so it is not working) and the position drops to 30.
  state.onRequest = (q) => {
    if (q.path !== "/v1/api/iserver/account/orders") return;
    state.positions2.U1234567 = [{ acctId: "U1234567", conid: AAPL, contractDesc: "AAPL", position: 30 }];
    if (!state.liveOrders.some((o) => o.orderId === 990077)) {
      state.liveOrders.push({
        acct: "U1234567",
        orderId: 990077,
        conid: AAPL,
        ticker: "AAPL",
        side: "SELL",
        totalSize: 70,
        filledQuantity: 70,
        remainingQuantity: 0,
        orderType: "Limit",
        price: 186,
        timeInForce: "DAY",
        status: "Filled",
        ticket: { orderType: "LMT", price: 186, tif: "DAY" },
      });
    }
  };
  const n = mark();
  try {
    const p = await pumped(place(v.id));
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.request.status, "rejected", p.text);
    assert.match(p.json.request.error, /^You hold 30 AAPL in this account .*does not sell short\. Nothing was placed\.$/);
    assert.equal(orderPosts(since(n)).length, 0, "nothing was sent");
    const reads = since(n).filter((q) => q.path === "/v1/api/portfolio2/U1234567/positions");
    assert.equal(reads.length, 2, "the position is read before and after the working orders");
  } finally {
    state.onRequest = null;
    state.liveOrders = state.liveOrders.filter((o) => o.orderId !== 990077);
    state.positions2 = {};
  }
});

test("a live orders list at IBKR's 1,000-order cap is not complete: a Sell is not checked against it", async () => {
  state.positions2.U1234567 = [{ acctId: "U1234567", conid: AAPL, contractDesc: "AAPL", position: 100 }];
  advance(6_000);
  const full = Array.from({ length: 1_000 }, (_, i) => ({
    acct: "U1234567",
    orderId: 880000 + i,
    conid: 999,
    ticker: "ZZZ",
    side: "BUY",
    totalSize: 1,
    filledQuantity: 1,
    remainingQuantity: 0,
    status: "Filled",
  }));
  state.ordersQueue.push({ body: { orders: full, snapshot: true } }, { body: { orders: full, snapshot: true } });
  try {
    const r = await pumped(preview({ symbol: "AAPL", side: "SELL", quantity: 10, type: "LMT", limitPrice: 186, tif: "DAY" }));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, "working_orders_unreadable");
    assert.equal(state.ordersQueue.length, 0);
  } finally {
    state.ordersQueue = [];
    state.positions2 = {};
  }
});

test("pacing: previews, a place, a reconcile, a cancel and the read path together never break it", async () => {
  state.positions2.U1234567 = [{ acctId: "U1234567", conid: AAPL, contractDesc: "AAPL", position: 100 }];
  const a = await previewOk({ ...LMT_BUY, quantity: 13 });
  const placedA = await place(a.id);
  const b = await previewOk({ ...LMT_BUY, quantity: 14 });
  state.placeQueue.push({ status: 503 });
  const unknownB = await pumped(place(b.id));
  assert.equal(unknownB.json.request.status, "unknown");
  const c = await previewOk({ ...LMT_BUY, quantity: 15 });
  advance(6_000);
  const before = state.pacingViolations;
  const out = await pumped(
    Promise.all([
      preview({ symbol: "AAPL", side: "SELL", quantity: 1, type: "LMT", limitPrice: 186, tif: "DAY" }),
      api("/v1/orders"),
      api("/v1/executions"),
      place(c.id),
      api(`/v1/orders/requests/${b.id}/check`, { method: "POST" }),
      cancel(`ibkr:${accountId}:${placedA.json.request.brokerOrderId}`),
      api("/v1/portfolio"),
      api("/v1/orders"),
    ]),
  );
  for (const r of out) assert.ok(r.status === 200, `${r.status} ${r.text}`);
  assert.equal(out[3].json.request.status, "placed");
  assert.equal(state.pacingViolations, before);
  state.positions2 = {};
});

test("capabilities with the default switches: a paper login gets stops and brackets, a live one neither; IBKR_STOP_ORDERS=on alone gives live stops", async () => {
  /** @param {Record<string, string>} env */
  async function capsWith(env) {
    const d = createMemoryDb();
    const w2 = randomUUID();
    const u2 = randomUUID();
    d.tables.set("workspaces", [{ id: w2, name: "Desk", status: "active", orders_enabled: true, owner_id: u2 }]);
    d.tables.set("members", [{ user_id: u2, email: "x@example.com", role: "trader", workspace_id: w2 }]);
    const live = randomUUID();
    const paper = randomUUID();
    d.tables.set("broker_connections", [
      { id: live, workspace_id: w2, user_id: u2, broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "active" },
      { id: paper, workspace_id: w2, user_id: u2, broker_id: "ibkr", method: "ibkr_gateway", environment: "paper", status: "active" },
    ]);
    d.tables.set("broker_accounts", [
      { id: randomUUID(), connection_id: live, workspace_id: w2, broker_id: "ibkr", external_id: "U1111111", display_number: "U11•••11", label: "x", type: "individual", included: true },
      { id: randomUUID(), connection_id: paper, workspace_id: w2, broker_id: "ibkr", external_id: "DU2222222", display_number: "DU2•••22", label: "x", type: "paper", included: true },
    ]);
    const s = createBrokerService(testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist", ...env }), { db: d });
    const l = await listen((req, res) => s.api.handle(req, res));
    try {
      const r = await call(`${l.url}/v1/orders/capabilities`, { token: jwtFor({ sub: u2, wid: w2 }) });
      assert.equal(r.status, 200, r.text);
      return { live: r.json.connections[live], paper: r.json.connections[paper] };
    } finally {
      await l.close();
    }
  }

  const defaults = await capsWith({});
  assert.deepEqual(defaults.live.types, ["MKT", "LMT"]);
  assert.equal(defaults.live.bracket, null);
  assert.equal(defaults.live.notes[0], "IBKR stop, stop limit and bracket orders are switched off for live accounts until Nasscord has checked them on a paper account.");
  assert.deepEqual(defaults.paper.types, ["MKT", "LMT", "STP", "STP_LMT"]);
  assert.deepEqual(defaults.paper.bracket, { entryTypes: ["MKT", "LMT"], stopTypes: ["STP"] });
  assert.equal(defaults.paper.notes.length, 2);

  const stopsOnly = await capsWith({ IBKR_STOP_ORDERS: "on" });
  assert.deepEqual(stopsOnly.live.types, ["MKT", "LMT", "STP", "STP_LMT"]);
  assert.equal(stopsOnly.live.bracket, null);
  assert.equal(stopsOnly.live.notes[0], "IBKR bracket orders are switched off for live accounts until Nasscord has checked them on a paper account.");

  const off = await capsWith({ IBKR_STOP_ORDERS: "off", IBKR_BRACKETS: "off" });
  assert.deepEqual(off.paper.types, ["MKT", "LMT"]);
  assert.equal(off.paper.notes[0], "IBKR stop, stop limit and bracket orders are switched off on this server.");
});
