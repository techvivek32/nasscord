import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ALPACA_DATA_ALLOW, ALPACA_READ_ALLOW, ALPACA_SEND_ALLOW, ALPACA_TRADE_ALLOW, alpacaDataHost, createAlpacaClient, createAlpacaTradeClient } from "../src/alpaca/client.mjs";
import { createAdapter } from "../src/alpaca/index.mjs";
import { alpacaOrderBody, alpacaSentence } from "../src/alpaca/orders.mjs";
import { rateLimited, ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed } from "../src/http.mjs";
import { sleep } from "./helpers/common.mjs";
import { fakeAsset, startFakeAlpaca } from "./helpers/fake-alpaca.mjs";
import { createHarness } from "./helpers/harness.mjs";

/**
 * Alpaca order entry end to end: the order core and the real Alpaca adapter (src/alpaca/orders.mjs)
 * through the service's HTTP API, against the fake Alpaca on 127.0.0.1 (live, paper and data hosts).
 * Tests run in order and share the connections. No test reaches Alpaca.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @type {Awaited<ReturnType<typeof startFakeAlpaca>>} */
let fake;
/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {ReturnType<Awaited<ReturnType<typeof startFakeAlpaca>>["addAccount"]>} */
let live;
/** @type {typeof live} */
let paper;
let liveConn = "";
let paperConn = "";
let liveAcct = "";
let paperAcct = "";
/** When on, the limiter refuses the token orders.mjs takes before the POST (reads are not affected). */
const refuse = { on: false };
/** Every reply body the tests received. */
const replies = /** @type {string[]} */ ([]);

const ASSETS = {
  AAPL: "b0b6dd9d-8b9b-48a9-ba46-b9d54906e415",
  TSLA: "8ccae427-5dd0-45b3-b5fe-7ba5e422c766",
  SPY: "b28f4066-5c6d-479b-a2af-85dc1a8f16fb",
  MSFT: "b6d1aa75-5c9c-4353-a305-9e2caa1925ab",
};

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, token?: string }} [o]
 */
async function req(path, o) {
  const r = await h.req(path, o);
  replies.push(r.text);
  return r;
}

/** @param {string} accountId @param {Record<string, unknown>} [over] */
const ticket = (accountId, over = {}) => ({ accountId, symbol: "AAPL", side: "BUY", quantity: 10, type: "LMT", limitPrice: 185.5, tif: "DAY", ...over });
/** @param {Record<string, unknown>} body */
const preview = (body) => req("/v1/orders/preview", { method: "POST", body });
/** @param {string} requestId @param {string[]} [acknowledged] */
const place = (requestId, acknowledged = []) => req("/v1/orders/place", { method: "POST", body: { requestId, acknowledged } });

/** Previews a ticket and answers the request view (asserting 200). @param {Record<string, unknown>} body */
async function previewOk(body) {
  const r = await preview(body);
  assert.equal(r.status, 200, r.text);
  return r.json.request;
}

/** Previews, then places, and answers the place's view. @param {Record<string, unknown>} body */
async function previewAndPlace(body) {
  const v = await previewOk(body);
  const p = await place(v.id, (v.preview?.notices ?? []).map((/** @type {any} */ n) => n.key));
  assert.equal(p.status, 200, p.text);
  return p.json.request;
}

/** Past the per-minute order limits and every read cache. */
const fresh = () => h.advance(61_000);
/** @param {string} id */
const connRow = (id) => h.rows("broker_connections").find((r) => r.id === id);
/** @param {string} id */
const requestRow = (id) => /** @type {Record<string, any>} */ (h.rows("order_requests").find((r) => r.id === id));
/** @param {string} action */
const audits = (action) => /** @type {Array<Record<string, any>>} */ (h.rows("audit_events").filter((r) => r.action === action));
/** Fake calls since `from`, as "host METHOD path". @param {number} from */
const callsSince = (from) => fake.state.calls.slice(from).map((c) => `${c.host} ${c.method} ${c.path}`);

before(async () => {
  fake = await startFakeAlpaca();
  live = fake.addAccount({
    host: "live",
    multiplier: "2",
    cash: "50000.00",
    equity: "120000.00",
    lastEquity: "119000.00",
    buyingPower: "100000.00",
    positions: [
      { asset_id: ASSETS.AAPL, symbol: "AAPL", asset_class: "us_equity", qty: "100", side: "long", avg_entry_price: "150", current_price: "190", market_value: "19000" },
      { asset_id: ASSETS.TSLA, symbol: "TSLA", asset_class: "us_equity", qty: "-100", side: "short", avg_entry_price: "250", current_price: "240", market_value: "-24000" },
      { asset_id: ASSETS.SPY, symbol: "SPY", asset_class: "us_equity", qty: "50", side: "long", avg_entry_price: "500", current_price: "590", market_value: "29500" },
    ],
    assets: [
      fakeAsset("AAPL", { id: ASSETS.AAPL, name: "Apple Inc. Common Stock" }),
      fakeAsset("TSLA", { id: ASSETS.TSLA, name: "Tesla, Inc. Common Stock" }),
      fakeAsset("SPY", { id: ASSETS.SPY, exchange: "ARCA", name: "SPDR S&P 500 ETF Trust" }),
      fakeAsset("MSFT", { id: ASSETS.MSFT, name: "Microsoft Corporation Common Stock" }),
      fakeAsset("OTCX", { exchange: "OTC" }),
      fakeAsset("NOTR", { tradable: false }),
      fakeAsset("IPOX", { attributes: ["ipo"] }),
    ],
  });
  paper = fake.addAccount({ host: "paper", accountNumber: "PA3XYZ12QW", buyingPower: "200000.00", assets: [fakeAsset("AAPL", { id: ASSETS.AAPL })] });
  fake.state.quotes = { AAPL: { bp: 189.98, ap: 190.02 }, TSLA: { bp: 239.9, ap: 240.1 }, SPY: { bp: 589.9, ap: 590.1 }, MSFT: { bp: 409.9, ap: 410.1 }, IPOX: { bp: 19.9, ap: 20.1 } };
  /** @type {import("../src/adapter-types.mjs").AdapterFactory} */
  const factory = (deps) =>
    createAdapter({
      ...deps,
      limiter: {
        ...deps.limiter,
        take: (key, rate, name) => (refuse.on ? Promise.reject(rateLimited(`${name} is limiting requests right now. Try again in a few seconds.`)) : deps.limiter.take(key, rate, name)),
      },
    });
  h = await createHarness({
    env: { BROKER_URL_OVERRIDES: JSON.stringify({ alpaca: fake.urls }), BROKER_CONNECT_PER_USER: "500", BROKER_CONNECT_GLOBAL_PER_MIN: "500" },
    adapters: [["alpaca", factory]],
  });
  fake.state.now = h.now;
});

after(async () => {
  await h?.close();
  await fake?.close();
});

test("allowlists: the trading client cannot close, cancel all or replace; the send client only posts an order; reads stay read-only", async () => {
  const id = "61e69015-8549-4bfd-b9c3-01e75843f47d";
  for (const [method, path] of [
    ["POST", "/v2/orders"],
    ["DELETE", "/v2/orders"],
    ["DELETE", "/v2/positions"],
    ["DELETE", `/v2/positions/${id}`],
    ["DELETE", "/v2/positions/AAPL"],
    ["PATCH", `/v2/orders/${id}`],
    ["PATCH", "/v2/account/configurations"],
    ["GET", "/v2/account/configurations"],
    ["GET", "/v2/positions"],
    ["GET", "/v2/positions/AAPL"],
    ["GET", "/v2/orders/ord-0001"],
    ["DELETE", "/v2/orders/ord-0001"],
    ["GET", `/v2/orders/${id.toUpperCase()}`],
    ["GET", "/v2/assets/aapl"],
    ["GET", "/v2/assets/../account"],
    ["POST", "/v2/watchlists"],
  ]) {
    assert.equal(isAllowed([...ALPACA_TRADE_ALLOW], method, path), false, `trade ${method} ${path}`);
  }
  for (const [method, path] of [
    ["GET", "/v2/account"],
    ["GET", "/v2/clock"],
    ["GET", "/v2/assets/BRK.B"],
    ["GET", `/v2/positions/${id}`],
    ["GET", "/v2/orders"],
    ["GET", `/v2/orders/${id}`],
    ["GET", "/v2/orders:by_client_order_id"],
    ["DELETE", `/v2/orders/${id}`],
  ]) {
    assert.equal(isAllowed([...ALPACA_TRADE_ALLOW], method, path), true, `trade ${method} ${path}`);
  }
  for (const [method, path] of [
    ["GET", "/v2/orders"],
    ["POST", "/v2/orders/x"],
    ["POST", "/v2/positions"],
    ["DELETE", "/v2/orders"],
    ["PATCH", "/v2/orders"],
    ["POST", "/v2/account"],
  ]) {
    assert.equal(isAllowed([...ALPACA_SEND_ALLOW], method, path), false, `send ${method} ${path}`);
  }
  assert.equal(isAllowed([...ALPACA_SEND_ALLOW], "POST", "/v2/orders"), true);
  assert.equal(isAllowed([...ALPACA_DATA_ALLOW], "GET", "/v2/stocks/AAPL/quotes/latest"), true);
  assert.equal(isAllowed([...ALPACA_DATA_ALLOW], "GET", "/v2/stocks/AAPL/trades/latest"), false);
  assert.equal(isAllowed([...ALPACA_DATA_ALLOW], "POST", "/v2/stocks/AAPL/quotes/latest"), false);
  assert.equal(isAllowed([...ALPACA_READ_ALLOW], "POST", "/v2/orders"), false, "the read client still refuses an order");
  assert.equal(isAllowed([...ALPACA_READ_ALLOW], "DELETE", `/v2/orders/${id}`), false);

  // The clients refuse before the network.
  const http = (/** @type {any} */ o) => createBrokerHttp({ ...o });
  const tc = createAlpacaTradeClient({ http, base: fake.urls.live, dataBase: fake.urls.data, keyId: live.keyId, secretKey: live.secret, bucketKey: "alpaca:test" });
  const read = createAlpacaClient({ http, base: fake.urls.live, keyId: live.keyId, secretKey: live.secret, bucketKey: "alpaca:test" });
  const calls = fake.state.calls.length;
  await assert.rejects(tc.trade.request("POST", "/v2/orders", { json: {} }), ReadOnlyViolation);
  await assert.rejects(tc.trade.request("DELETE", "/v2/orders"), ReadOnlyViolation);
  await assert.rejects(tc.trade.request("DELETE", `/v2/positions/${id}`), ReadOnlyViolation);
  await assert.rejects(tc.send.request("DELETE", `/v2/orders/${id}`), ReadOnlyViolation);
  await assert.rejects(tc.send.request("GET", "/v2/account"), ReadOnlyViolation);
  await assert.rejects(tc.data.request("GET", "/v2/account"), ReadOnlyViolation);
  await assert.rejects(read.http.request("POST", "/v2/orders", { json: {} }), ReadOnlyViolation);
  assert.equal(fake.state.calls.length, calls, "nothing reached Alpaca");
  assert.equal(alpacaDataHost({ data: "http://127.0.0.1:9" }, true), "https://data.alpaca.markets", "production calls Alpaca's own data host");
  assert.equal(alpacaDataHost({ data: "http://127.0.0.1:9" }, false), "http://127.0.0.1:9");
});

test("connect a Live and a Paper key; capabilities name both with Alpaca's types and notes", async () => {
  const l = await req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: live.keyId, secret: live.secret } });
  assert.equal(l.status, 200, l.text);
  liveConn = l.json.connection.id;
  liveAcct = l.json.connection.accounts[0].id;
  const p = await req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: paper.keyId, secret: paper.secret } });
  assert.equal(p.status, 200, p.text);
  paperConn = p.json.connection.id;
  paperAcct = p.json.connection.accounts[0].id;
  const ws = /** @type {Record<string, any>} */ (h.rows("workspaces").find((w) => w.id === h.wid));
  Object.assign(ws, { orders_enabled: true, owner_id: h.user, status: "active" });

  const caps = await req("/v1/orders/capabilities");
  assert.equal(caps.status, 200, caps.text);
  assert.equal(caps.json.enabled, true);
  for (const id of [liveConn, paperConn]) {
    assert.deepEqual(caps.json.connections[id], {
      types: ["MKT", "LMT", "STP", "STP_LMT"],
      tif: ["DAY", "GTC"],
      marketGtc: true,
      bracket: { entryTypes: ["MKT", "LMT"], stopTypes: ["STP", "STP_LMT"] },
      notes: ["Alpaca checks prices against the whole market; the quote Nasscord shows is IEX, one exchange.", "Cancelling any order of an Alpaca bracket cancels the whole bracket."],
    });
  }
  assert.deepEqual(caps.json.blocked, {});
});

test("preview: Alpaca's account, asset, position, quote and clock, and nothing sent", async () => {
  fresh();
  const calls = fake.state.calls.length;
  const nonGet = fake.state.nonGet;
  const v = await previewOk(ticket(liveAcct));
  assert.equal(v.status, "preview");
  assert.equal(v.environment, "production");
  assert.match(v.clientOrderId, /^nc[0-9a-f]{18}$/);
  assert.deepEqual(v.preview.quote, { bid: 189.98, ask: 190.02, at: v.preview.quote.at, source: "IEX bid and ask (one exchange, not the whole market)" });
  assert.equal(v.preview.referencePrice, 190, "the IEX midpoint");
  assert.deepEqual(v.preview.instrument, { name: "Apple Inc. Common Stock", exchange: "NASDAQ" });
  assert.deepEqual(v.preview.estimate, { notional: 1855, source: "Nasscord, from your limit price" });
  assert.equal(v.preview.buyingPower, 100000);
  assert.equal(v.preview.marketOpen, true, "Alpaca's clock");
  assert.deepEqual(v.preview.position, { before: 100, after: 110 });
  assert.deepEqual(v.preview.notices, []);
  assert.equal(JSON.stringify(v).includes("assetId"), false, "broker_state is never sent");
  assert.equal(requestRow(v.id).broker_state.assetId, ASSETS.AAPL);
  assert.equal(fake.state.nonGet, nonGet, "a preview sends nothing");
  const seen = callsSince(calls);
  for (const c of ["live GET /v2/account", "live GET /v2/assets/AAPL", `live GET /v2/positions/${ASSETS.AAPL}`, "data GET /v2/stocks/AAPL/quotes/latest", "live GET /v2/clock"]) {
    assert.ok(seen.includes(c), c);
  }
  const quoteCall = fake.state.calls.slice(calls).find((c) => c.host === "data");
  assert.equal(quoteCall?.query.feed, "iex", "the free IEX feed only");

  // A market order uses the quote for the estimate; a closed clock is the core's warning.
  fake.state.clock.is_open = false;
  try {
    const m = await previewOk(ticket(liveAcct, { type: "MKT", limitPrice: undefined, quantity: 2 }));
    assert.deepEqual(m.preview.estimate, { notional: 380, source: "Nasscord, from the IEX quote" });
    assert.equal(m.preview.marketOpen, false);
    assert.ok(m.preview.warnings.some((/** @type {any} */ w) => w.code === "market_closed_market"));
  } finally {
    fake.state.clock.is_open = true;
  }

  // GTC: Alpaca's 90-day expiry. A paper account previews on the paper host.
  const g = await previewOk(ticket(paperAcct, { tif: "GTC" }));
  assert.equal(g.environment, "paper");
  assert.ok(g.preview.warnings.some((/** @type {any} */ w) => w.code === "gtc_expiry" && w.text === "Alpaca cancels GTC orders 90 days after they are placed."));
});

test("preview refusals: blocked or inactive account, another account, a paper number on Live, assets Alpaca does not trade", async () => {
  fresh();
  /** @param {Record<string, unknown>} body @param {number} status @param {string} code @param {string} [error] */
  const refused = async (body, status, code, error) => {
    const r = await preview(body);
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.code, code, r.text);
    if (error) assert.equal(r.json.error, error);
  };
  const nonGet = fake.state.nonGet;

  live.flags.trading_blocked = true;
  await refused(ticket(liveAcct), 409, "not_tradable", "Alpaca blocks trading on this account right now.");
  live.flags = { trade_suspended_by_user: true };
  await refused(ticket(liveAcct), 409, "not_tradable", "Trading is switched off in your Alpaca account settings.");
  live.flags = { status: "ACCOUNT_CLOSED" };
  await refused(ticket(liveAcct), 409, "not_tradable", "Alpaca says this account cannot trade right now (ACCOUNT_CLOSED).");
  live.flags = {};

  const realId = live.id;
  live.id = randomUUID();
  await refused(ticket(liveAcct), 409, "account_mismatch", "Alpaca answered for another account than this connection. Nothing was sent. Reconnect Alpaca.");
  live.id = realId;

  const realNumber = live.accountNumber;
  live.accountNumber = "PA9LIVE000";
  await refused(ticket(liveAcct), 409, "environment_mismatch", "This Alpaca key belongs to a paper account, but the connection is saved as Live. Nothing was sent. Reconnect Alpaca.");
  live.accountNumber = realNumber;

  await refused(ticket(liveAcct, { symbol: "ZZZZ" }), 400, "not_tradable", "Alpaca does not list ZZZZ.");
  await refused(ticket(liveAcct, { symbol: "OTCX" }), 400, "not_tradable", "Alpaca does not trade OTCX as a US stock or ETF.");
  await refused(ticket(liveAcct, { symbol: "NOTR" }), 400, "not_tradable", "Alpaca does not trade NOTR as a US stock or ETF.");
  await refused(ticket(liveAcct, { symbol: "IPOX", type: "MKT", limitPrice: undefined }), 400, "not_tradable", "IPOX has not started trading yet. Alpaca takes only Limit orders for it.");
  await previewOk(ticket(liveAcct, { symbol: "IPOX", limitPrice: 20 }));

  // A key Alpaca refuses: the order path never expires the connection (the read path does).
  const realSecret = live.secret;
  live.secret = "refused-secret-0000000000";
  await refused(ticket(liveAcct), 409, "connection_not_live", "Alpaca did not accept the key of this connection. Reconnect Alpaca.");
  live.secret = realSecret;
  assert.equal(connRow(liveConn)?.status, "active");
  assert.equal(fake.state.nonGet, nonGet, "no refusal sent anything");
});

test("a SIP 403 or no answer from the data host: no quote, a warning, and the connection stays active", async () => {
  fresh();
  fake.state.failNext.push({ host: "data", path: "/v2/stocks/AAPL/quotes/latest", status: 403, body: { code: 42210000, message: "subscription does not permit querying recent SIP data" } });
  const v = await previewOk(ticket(liveAcct));
  assert.equal(v.preview.quote, undefined);
  assert.equal(v.preview.referencePrice, undefined);
  assert.ok(v.preview.warnings.some((/** @type {any} */ w) => w.code === "no_quote" && w.text === "Alpaca's free IEX quote for AAPL is not available right now."));
  assert.equal(connRow(liveConn)?.status, "active");

  fake.state.failNext.push({ host: "data", path: "/v2/stocks/AAPL/quotes/latest", status: 503 });
  const m = await preview(ticket(liveAcct, { type: "MKT", limitPrice: undefined }));
  assert.equal(m.status, 409, m.text);
  assert.equal(m.json.code, "no_reference_price", "a Market order without a reference is refused by the core");
  assert.equal(connRow(liveConn)?.status, "active");
});

test("place: the exact POST body, the order id, and one send", async () => {
  fresh();
  const posts = fake.state.posts.length;
  const v = await previewAndPlace(ticket(liveAcct));
  assert.equal(v.status, "placed", JSON.stringify(v));
  assert.equal(fake.state.posts.length, posts + 1);
  const sent = fake.state.posts[posts];
  assert.equal(sent.host, "live");
  assert.deepEqual(sent.body, {
    symbol: "AAPL",
    qty: "10",
    side: "buy",
    type: "limit",
    time_in_force: "day",
    client_order_id: v.clientOrderId,
    extended_hours: false,
    limit_price: "185.50",
  });
  const order = fake.orders(live).find((o) => o.client_order_id === v.clientOrderId);
  assert.ok(order);
  assert.equal(v.brokerOrderId, order.id);
  assert.match(v.brokerOrderId, UUID);
  assert.deepEqual(v.brokerOrderIds, [{ id: order.id, role: "entry" }]);
  assert.equal(requestRow(v.id).status, "placed");
  await sleep(20);
  const audit = audits("broker.order.place").find((a) => a.meta?.requestId === v.id);
  assert.equal(audit?.result, "ok");
  assert.equal(audit?.meta.outcome, "placed");

  // A replay answers the stored row and sends nothing.
  const again = await place(v.id);
  assert.equal(again.json.request.status, "placed");
  assert.equal(fake.state.posts.length, posts + 1);

  // A stop limit sell of part of the holding.
  const s = await previewAndPlace(ticket(liveAcct, { side: "SELL", type: "STP_LMT", stopPrice: 185, limitPrice: 184.5, quantity: 10 }));
  assert.equal(s.status, "placed", JSON.stringify(s));
  assert.deepEqual(fake.state.posts.at(-1)?.body, {
    symbol: "AAPL",
    qty: "10",
    side: "sell",
    type: "stop_limit",
    time_in_force: "day",
    client_order_id: s.clientOrderId,
    extended_hours: false,
    limit_price: "184.50",
    stop_price: "185.00",
  });
});

test("a bracket: gtc, both exits in the body, three ids with their roles", async () => {
  fresh();
  const v = await previewAndPlace(
    ticket(liveAcct, { type: "MKT", limitPrice: undefined, quantity: 5, tif: "GTC", bracket: { takeProfit: { limitPrice: 200 }, stopLoss: { stopPrice: 180, limitPrice: 179.5 } } }),
  );
  assert.equal(v.status, "placed", JSON.stringify(v));
  assert.deepEqual(fake.state.posts.at(-1)?.body, {
    symbol: "AAPL",
    qty: "5",
    side: "buy",
    type: "market",
    time_in_force: "gtc",
    client_order_id: v.clientOrderId,
    extended_hours: false,
    order_class: "bracket",
    take_profit: { limit_price: "200.00" },
    stop_loss: { stop_price: "180.00", limit_price: "179.50" },
  });
  const order = fake.orders(live).find((o) => o.client_order_id === v.clientOrderId);
  const legs = order.legs;
  assert.deepEqual(
    v.brokerOrderIds,
    [
      { id: order.id, role: "entry" },
      { id: legs[0].id, role: "take_profit" },
      { id: legs[1].id, role: "stop_loss" },
    ],
  );
  assert.equal(v.preview.warnings.some((/** @type {any} */ w) => w.code === "alpaca_echo_mismatch"), false);

  // Legs without group_role get their roles from their types; an exit near the quote warns.
  const near = await previewOk(ticket(liveAcct, { quantity: 1, limitPrice: 189, tif: "GTC", bracket: { takeProfit: { limitPrice: 190.5 }, stopLoss: { stopPrice: 180, limitPrice: null } } }));
  assert.ok(near.preview.warnings.some((/** @type {any} */ w) => w.code === "exit_near_price"));
});

test("an answer that differs from the order sent is placed with a warning", async () => {
  fresh();
  fake.state.echo = { qty: "11" };
  const v = await previewAndPlace(ticket(liveAcct, { quantity: 1, limitPrice: 180 }));
  assert.equal(v.status, "placed");
  assert.ok(v.preview.warnings.some((/** @type {any} */ w) => w.code === "alpaca_echo_mismatch" && w.text === "Alpaca's confirmation shows different details than you entered. Check it in Orders now."));
});

test("Alpaca's 403 for buying power is a rejection with Alpaca's reason; the connection stays active", async () => {
  fresh();
  const posts = fake.state.posts.length;
  const v = await previewAndPlace(ticket(liveAcct, { symbol: "MSFT", quantity: 300, limitPrice: 410 }));
  assert.equal(v.status, "rejected", JSON.stringify(v));
  assert.equal(v.error, "Alpaca: not enough buying power for this order ($100,000.00 available).");
  assert.equal(fake.state.posts.length, posts + 1);
  assert.equal(connRow(liveConn)?.status, "active");
  await sleep(20);
  const audit = audits("broker.order.place").find((a) => a.meta?.requestId === v.id);
  assert.equal(audit?.result, "denied");
  assert.equal(audit?.meta.code, "alpaca_refused");
});

test("a 422 for a used client order id is unknown, never success, and the lookup by client id then finds it", async () => {
  fresh();
  const v = await previewOk(ticket(liveAcct, { quantity: 1, limitPrice: 181 }));
  // An earlier attempt reached Alpaca with this id; the lookup right after fails once.
  const earlier = randomUUID();
  live.orders.push({ id: earlier, client_order_id: v.clientOrderId, symbol: "AAPL", asset_class: "us_equity", type: "limit", order_type: "limit", side: "buy", qty: "1", filled_qty: "0", limit_price: "181", time_in_force: "day", status: "new", submitted_at: new Date(h.now()).toISOString(), legs: null });
  fake.state.clientIds.add(v.clientOrderId);
  fake.state.failNext.push({ host: "live", path: "/v2/orders:by_client_order_id", status: 503 });
  const posts = fake.state.posts.length;
  const p = await place(v.id);
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.request.status, "unknown");
  assert.match(p.json.request.error, /could not confirm whether Alpaca received this order/);
  assert.equal(fake.state.posts.length, posts + 1, "sent once");
  await sleep(20);
  assert.equal(audits("broker.order.place").find((a) => a.meta?.requestId === v.id)?.meta.outcome, "unknown");

  h.advance(6_000);
  const s = await req(`/v1/orders/requests/${v.id}`);
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.request.status, "placed");
  assert.equal(s.json.request.brokerOrderId, earlier);
  assert.equal(fake.state.posts.length, posts + 1, "never sent again");
});

test("a POST whose answer is lost is unknown with one POST recorded, and the lookup finds the order", async () => {
  fresh();
  const posts = fake.state.posts.length;
  fake.state.failNext.push({ host: "live", method: "POST", path: "/v2/orders", drop: true });
  const v = await previewAndPlace(ticket(liveAcct, { quantity: 2, limitPrice: 182 }));
  assert.equal(fake.state.posts.length, posts + 1, "one POST, never repeated");
  assert.equal(fake.orders(live).filter((o) => o.client_order_id === v.clientOrderId).length, 1);
  await sleep(20);
  assert.equal(audits("broker.order.place").find((a) => a.meta?.requestId === v.id)?.meta.outcome, "unknown");
  // The reconcile inside the place found it by its client order id.
  assert.equal(v.status, "placed", JSON.stringify(v));
  assert.equal(v.brokerOrderId, fake.orders(live).find((o) => o.client_order_id === v.clientOrderId)?.id);
  assert.ok(audits("broker.order.reconcile").some((a) => a.meta?.requestId === v.id));
});

test("Alpaca's own 429 on the POST is unknown, and a lookup that finds nothing never says it was not placed", async () => {
  fresh();
  const posts = fake.state.posts.length;
  fake.state.failNext.push({ host: "live", method: "POST", path: "/v2/orders", status: 429, resetInSec: 1 });
  const v = await previewAndPlace(ticket(liveAcct, { quantity: 3, limitPrice: 183 }));
  assert.equal(v.status, "unknown", JSON.stringify(v));
  assert.equal(fake.state.posts.length, posts + 1);
  assert.match(v.error, /does not list this order yet/);
  assert.match(v.error, /That does not mean it was not placed/);
  assert.doesNotMatch(v.error, /Nothing was placed/);
  assert.equal(connRow(liveConn)?.status, "active");
});

test("a limiter refusal before the POST is a rejection, and no POST goes out", async () => {
  fresh();
  const posts = fake.state.posts.length;
  const v = await previewOk(ticket(liveAcct, { quantity: 1, limitPrice: 184 }));
  refuse.on = true;
  try {
    const p = await place(v.id);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.request.status, "rejected");
    assert.equal(p.json.request.error, "Alpaca is limiting requests right now. Nothing was placed. Try again in a few seconds.");
  } finally {
    refuse.on = false;
  }
  assert.equal(fake.state.posts.length, posts, "nothing was posted");
  assert.equal(requestRow(v.id).status, "rejected");
});

test("positions: a short with raw qty -100 reads as -100 and a Sell is refused; a long reads as +100; a Close of the short buys 100", async () => {
  fresh();
  const short = await preview(ticket(liveAcct, { symbol: "TSLA", side: "SELL", quantity: 1, limitPrice: 240 }));
  assert.equal(short.status, 400, short.text);
  assert.equal(short.json.code, "no_short");
  assert.equal(short.json.error, "You hold no TSLA in this account. Nasscord does not sell short.");

  const calls = fake.state.calls.length;
  const cover = await previewOk(ticket(liveAcct, { symbol: "TSLA", side: "BUY", quantity: 10, limitPrice: 240 }));
  assert.deepEqual(cover.preview.position, { before: -100, after: -90 });
  const listed = fake.state.calls.slice(calls).find((c) => c.path === "/v2/orders");
  assert.deepEqual(listed?.query, { status: "open", symbols: "TSLA", limit: "500", nested: "false" }, "a short reads its working orders");

  const close = await previewAndPlace(ticket(liveAcct, { symbol: "TSLA", side: "BUY", quantity: 100, limitPrice: 245, intent: "close", expectedPositionQty: -100, positionId: `alpaca:${liveAcct}:${ASSETS.TSLA}` }));
  assert.equal(close.status, "placed", JSON.stringify(close));
  assert.deepEqual(
    [fake.state.posts.at(-1)?.body.side, fake.state.posts.at(-1)?.body.qty, fake.state.posts.at(-1)?.body.symbol],
    ["buy", "100", "TSLA"],
  );

  const long = await previewOk(ticket(liveAcct, { symbol: "SPY", quantity: 1, limitPrice: 590 }));
  assert.deepEqual(long.preview.position, { before: 50, after: 51 });
});

test("working sell orders count against a Sell", async () => {
  fresh();
  const at = new Date(h.now()).toISOString();
  live.orders.push({ id: randomUUID(), client_order_id: "other-tool-1", symbol: "SPY", asset_class: "us_equity", type: "limit", order_type: "limit", side: "sell", qty: "40", filled_qty: "10", limit_price: "600", time_in_force: "gtc", status: "partially_filled", submitted_at: at, legs: null });
  const over = await preview(ticket(liveAcct, { symbol: "SPY", side: "SELL", quantity: 21, limitPrice: 595 }));
  assert.equal(over.status, 400, over.text);
  assert.equal(over.json.code, "no_short");
  assert.equal(over.json.error, "You hold 50 SPY in this account and working sell orders already cover 30. Nasscord sells at most the 20 shares they do not cover, and does not sell short.");
  await previewOk(ticket(liveAcct, { symbol: "SPY", side: "SELL", quantity: 20, limitPrice: 595 }));

  // A Close needs no working order on its side.
  const close = await preview(ticket(liveAcct, { symbol: "SPY", side: "SELL", quantity: 50, limitPrice: 595, intent: "close", expectedPositionQty: 50, positionId: `alpaca:${liveAcct}:${ASSETS.SPY}` }));
  assert.equal(close.status, 409, close.text);
  assert.equal(close.json.code, "working_sells");

  // A working list Alpaca does not answer refuses the Sell and sends nothing.
  fake.state.failNext.push({ host: "live", path: "/v2/orders", status: 500 });
  const unreadable = await preview(ticket(liveAcct, { symbol: "SPY", side: "SELL", quantity: 1, limitPrice: 595 }));
  assert.equal(unreadable.status, 409, unreadable.text);
  assert.equal(unreadable.json.code, "working_orders_unreadable");
  assert.doesNotMatch(unreadable.json.error, /Nothing was placed/);
});

test("no short at place time: a sell that fills while the open orders are read is caught by a second position read", async () => {
  fresh();
  // SPY: 50 held, an outside working sell covers 30 (the test above), so 20 are free to sell.
  const v = await previewOk(ticket(liveAcct, { symbol: "SPY", side: "SELL", quantity: 15, limitPrice: 595 }));
  const spy = /** @type {any} */ (live.positions.find((p) => p.symbol === "SPY"));
  const before = { qty: spy.qty, market_value: spy.market_value };
  // Another outside sell of 15 fills while Nasscord reads the open orders: it has left the open list
  // and the position drops to 35, so 15 more would leave 30 working sells against 20 shares.
  fake.state.onRequest = (c) => {
    if (c.method === "GET" && c.path === "/v2/orders" && c.query.status === "open") {
      spy.qty = "35";
      spy.market_value = "20650";
    }
  };
  const from = fake.state.calls.length;
  const posts = fake.state.posts.length;
  try {
    const p = await place(v.id);
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.request.status, "rejected", p.text);
    assert.match(p.json.request.error, /^You hold 35 SPY in this account and working sell orders already cover 30\. Nasscord sells at most the 5 shares/);
    assert.equal(fake.state.posts.length, posts, "nothing was posted");
    const reads = callsSince(from).filter((c) => c === `live GET /v2/positions/${ASSETS.SPY}`);
    assert.equal(reads.length, 2, "the position is read before and after the open orders");
  } finally {
    fake.state.onRequest = null;
    Object.assign(spy, before);
  }
});

test("cancel: the order is read, then one DELETE; a final order and Alpaca's 422 are refused", async () => {
  fresh();
  const v = await previewAndPlace(ticket(liveAcct, { quantity: 1, limitPrice: 170 }));
  assert.equal(v.status, "placed");
  const orderId = `alpaca:${liveAcct}:${v.brokerOrderId}`;
  const calls = fake.state.calls.length;
  const c = await req("/v1/orders/cancel", { method: "POST", body: { accountId: liveAcct, orderId } });
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.json, { status: "cancel_requested", message: "Alpaca received the cancel. The order shows as cancelled once Alpaca confirms it, and it can still fill until then." });
  assert.deepEqual(
    callsSince(calls).filter((x) => x.includes(v.brokerOrderId)),
    [`live GET /v2/orders/${v.brokerOrderId}`, `live DELETE /v2/orders/${v.brokerOrderId}`],
  );
  assert.equal(requestRow(v.id).status, "cancel_requested");

  const again = await req("/v1/orders/cancel", { method: "POST", body: { accountId: liveAcct, orderId } });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, "not_cancellable");
  assert.equal(again.json.error, "This order is already cancelled at Alpaca.");

  fresh();
  const w = await previewAndPlace(ticket(liveAcct, { quantity: 1, limitPrice: 171 }));
  fake.state.failNext.push({ host: "live", method: "DELETE", path: `/v2/orders/${w.brokerOrderId}`, status: 422, body: { code: 42210000, message: "order is not cancelable" } });
  const refused = await req("/v1/orders/cancel", { method: "POST", body: { accountId: liveAcct, orderId: `alpaca:${liveAcct}:${w.brokerOrderId}` } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.code, "not_cancellable");
  assert.equal(refused.json.error, "Alpaca says this order can no longer be cancelled.");

  const missing = await req("/v1/orders/cancel", { method: "POST", body: { accountId: liveAcct, orderId: `alpaca:${liveAcct}:${randomUUID()}` } });
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.json.code, "order_not_open");
  const bad = await req("/v1/orders/cancel", { method: "POST", body: { accountId: liveAcct, orderId: `alpaca:${liveAcct}:ord-0001` } });
  assert.equal(bad.status, 404, bad.text);
  assert.equal(bad.json.code, "order_not_open");

  fake.state.failNext.push({ host: "live", method: "DELETE", path: `/v2/orders/${w.brokerOrderId}`, status: 503 });
  const unknown = await req("/v1/orders/cancel", { method: "POST", body: { accountId: liveAcct, orderId: `alpaca:${liveAcct}:${w.brokerOrderId}` } });
  assert.equal(unknown.status, 502, unknown.text);
  assert.equal(unknown.json.code, "cancel_unknown");
});

test("a paper key on a Live connection is refused before the network", async () => {
  fresh();
  await h.svc.oauth2.saveSecret(liveConn, { keyId: paper.keyId, secretKey: paper.secret, host: "paper" });
  try {
    const calls = fake.state.calls.length;
    const r = await preview(ticket(liveAcct));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, "environment_mismatch");
    assert.equal(fake.state.calls.length, calls, "nothing reached Alpaca");
  } finally {
    await h.svc.oauth2.saveSecret(liveConn, { keyId: live.keyId, secretKey: live.secret, host: "live" });
  }
  await previewOk(ticket(liveAcct));
});

test("a paper account number without PA is logged once per connection", async () => {
  fresh();
  paper.accountNumber = "123456789";
  try {
    await previewOk(ticket(paperAcct, { quantity: 1 }));
    await previewOk(ticket(paperAcct, { quantity: 2 }));
  } finally {
    paper.accountNumber = "PA3XYZ12QW";
  }
  assert.equal(h.logLines.filter((l) => l.includes("alpaca paper account number without PA")).length, 1);
  assert.ok(!h.logLines.some((l) => l.includes("123456789")), "never the number itself");
});

test("pure parts: the order body and Alpaca's refusal sentences", () => {
  /** @type {import("../src/order-contract.mjs").Ticket} */
  const t = { symbol: "BRK.B", side: "SELL", quantity: 3, type: "STP", limitPrice: null, stopPrice: 0.5, tif: "DAY", bracket: null, intent: "trade", positionId: null, expectedPositionQty: null };
  assert.deepEqual(alpacaOrderBody(t, "nc0123456789abcdef01"), {
    symbol: "BRK.B",
    qty: "3",
    side: "sell",
    type: "stop",
    time_in_force: "day",
    client_order_id: "nc0123456789abcdef01",
    extended_hours: false,
    stop_price: "0.5000",
  });
  assert.equal(alpacaSentence("insufficient qty available for order (requested: 10, available: 4)", { available: "4" }), "Alpaca: only 4 shares are free to sell; working orders reserve the rest.");
  assert.equal(alpacaSentence("insufficient qty available for order (requested: 10, available: 2)", {}), "Alpaca: only 2 shares are free to sell; working orders reserve the rest.");
  assert.equal(alpacaSentence("potential wash trade detected. use complex orders", {}), "Alpaca blocks this order because it could trade against your own working order. Cancel that order, or use a bracket.");
  assert.equal(alpacaSentence("account is not allowed to short", {}), "This Alpaca account cannot sell short.");
  assert.equal(alpacaSentence("account is not authorized to trade", {}), "Alpaca says this account cannot trade right now. Check the account in Alpaca.");
  assert.equal(alpacaSentence("account is restricted to liquidation only", {}), "Alpaca allows only closing trades on this account right now.");
  assert.equal(alpacaSentence("trade denied due to pattern day trading protection", {}), "Alpaca refused the order under its day-trading protection.");
  assert.equal(alpacaSentence("invalid limit_price 1.234. sub-penny increment does not fulfill minimum pricing criteria", {}), "Alpaca: the price has too many decimals.");
  assert.equal(alpacaSentence("take_profit.limit_price must be >= base_price + 0.01", {}), "Alpaca: the stop-loss or take-profit is too close to the current price.");
  assert.equal(alpacaSentence("insufficient buying power", {}), "Alpaca: not enough buying power for this order.");
  assert.equal(alpacaSentence(`something new\n${"x".repeat(300)}`, {}).length, "Alpaca: ".length + 200);
  assert.equal(alpacaSentence("", {}, 403), "Alpaca refused the order (403).");
});

test("no key or secret in any table, log line or reply; Alpaca got only the orders and cancels the tests sent", () => {
  const tables = JSON.stringify([...h.db.tables.entries()]);
  const logs = h.logLines.join("\n");
  for (const s of [live.keyId, live.secret, paper.keyId, paper.secret]) {
    assert.ok(!tables.includes(s), "a key or secret is stored in plain text");
    assert.ok(!logs.includes(s), "a key or secret reached the log");
    assert.ok(!replies.some((r) => r.includes(s)), "a key or secret was sent back");
  }
  assert.ok(!logs.includes(live.accountNumber), "no full account number in the log");
  const writes = fake.state.calls.filter((c) => c.method !== "GET");
  assert.ok(writes.every((c) => (c.method === "POST" && c.path === "/v2/orders") || (c.method === "DELETE" && /^\/v2\/orders\/[0-9a-f-]{36}$/.test(c.path))));
  assert.equal(writes.length, fake.state.nonGet);
});
