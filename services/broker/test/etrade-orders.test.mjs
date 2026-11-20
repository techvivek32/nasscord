import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { createEtradeClient, encodeOrderBody, ETRADE_WRITE_ALLOW, parseEtradeError } from "../src/etrade/client.mjs";
import { buildOrder, etradeSentence, orderAction } from "../src/etrade/orders.mjs";
import { isAllowed } from "../src/http.mjs";
import { createLogger } from "../src/log.mjs";
import { OrderNotSentError } from "../src/order-contract.mjs";
import { createBrokerService } from "../src/server.mjs";
import { call, jwtFor, listen, sleep, testConfig } from "./helpers/common.mjs";
import { canon, etradePositionRow, parseOrderXml, startFakeEtrade } from "./helpers/fake-etrade.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/**
 * E*TRADE order entry end to end: the real E*TRADE adapter, its write transport and the order core,
 * through the HTTP API, against the fake E*TRADE on 127.0.0.1 (never E*TRADE). The fake checks the
 * OAuth signature of every call, reads XML and JSON bodies, and keeps an order book per account.
 *
 * The clock runs with an offset that each test moves a minute forward, so the per-minute order limits
 * and E*TRADE's 2 calls per second start fresh.
 */

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

const CONSUMER_KEY = "282683cc9e4b8fc81dea6bc687d46758";
const CONSUMER_SECRET = "7d30246211192cda43ede3abd9b393b9";
const user = randomUUID();
const wid = randomUUID();
const token = () => jwtFor({ sub: user, wid });

/** @type {string[]} every log line of the service */
const logLines = [];
const log = createLogger({ level: "debug", write: (line) => logLines.push(line) });

/** @type {Awaited<ReturnType<typeof startFakeEtrade>>} */
let fake;
/** @type {ReturnType<typeof createMemoryDb>} */
let db;
/** @type {ReturnType<typeof createBrokerService>} */
let svc;
/** @type {Awaited<ReturnType<typeof listen>>} */
let apiServer;
let connectionId = "";
let accountId = "";
let rothId = "";

before(async () => {
  fake = await startFakeEtrade({ consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });
  db = createMemoryDb();
  db.tables.set("workspaces", [{ id: wid, name: "Swing Desk", status: "active", orders_enabled: true, owner_id: user }]);
  db.tables.set("members", [{ user_id: user, email: "trader@example.com", role: "trader", workspace_id: wid }]);
  svc = createBrokerService(testConfig(), { db, etradeUrls: fake.urls, log });
  apiServer = await listen((req, res) => svc.api.handle(req, res));

  const start = await call(`${apiServer.url}/v1/etrade/start`, {
    method: "POST",
    token: token(),
    body: { environment: "production", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET },
  });
  assert.equal(start.status, 200, start.text);
  connectionId = start.json.connectionId;
  const verify = await call(`${apiServer.url}/v1/etrade/verify`, { method: "POST", token: token(), body: { connectionId, verifier: fake.verifier } });
  assert.equal(verify.status, 200, verify.text);
  assert.equal(verify.json.connection.environment, "production");
  accountId = String(rows("broker_accounts").find((a) => a.external_id === "keyAlpha")?.id);
  rothId = String(rows("broker_accounts").find((a) => a.external_id === "keyRoth")?.id);
});

after(async () => {
  await apiServer?.close();
  await fake?.close();
  Date.now = realNow;
});

// Fresh per-minute windows and broker buckets for every test.
beforeEach(() => {
  offset += 61_000;
  fake.state.failNext = null;
  fake.state.previewEcho = null;
  fake.state.placeEcho = null;
  fake.state.previewMessages = [];
});

/** @param {string} t */
const rows = (t) => /** @type {any[]} */ (db.tables.get(t) ?? []);
/**
 * @param {string} p
 * @param {{ method?: string, body?: unknown, base?: string }} [o]
 */
const api = (p, o = {}) => call(`${o.base ?? apiServer.url}${p}`, { method: o.method, body: o.body, token: token() });
/** @param {Record<string, unknown>} t @param {string} [base] */
const preview = (t, base) => api("/v1/orders/preview", { method: "POST", body: { accountId, tif: "DAY", ...t }, base });
/** @param {string} requestId */
const place = (requestId) => api("/v1/orders/place", { method: "POST", body: { requestId, acknowledged: [] } });
/** @param {string} orderId */
const cancel = (orderId) => api("/v1/orders/cancel", { method: "POST", body: { accountId, orderId } });
/** @param {string} id */
const rowOf = (id) => rows("order_requests").find((r) => r.id === id);
const lastWrite = () => /** @type {(typeof fake.state.writes)[number]} */ (fake.state.writes.at(-1));
/** @param {string} action @param {(r: any) => boolean} [pred] */
async function auditRow(action, pred = () => true) {
  for (let i = 0; i < 40; i++) {
    const r = rows("audit_events").find((a) => a.action === action && pred(a));
    if (r) return r;
    await sleep(25);
  }
  return undefined;
}

test("capabilities: an E*TRADE production connection takes four types, Market as Day only, no brackets", async () => {
  const r = await api("/v1/orders/capabilities");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.enabled, true);
  const caps = r.json.connections[connectionId];
  assert.deepEqual(caps.types, ["MKT", "LMT", "STP", "STP_LMT"]);
  assert.deepEqual(caps.tif, ["DAY", "GTC"]);
  assert.equal(caps.marketGtc, false);
  assert.equal(caps.bracket, null);
  assert.equal(caps.notes.length, 3);
  assert.deepEqual(r.json.blocked, {});
});

test("preview: an XML body by default, signed, to the .json path, with quote, estimate and position", async () => {
  const before = fake.state.writes.length;
  const r = await preview({ symbol: "aapl", side: "BUY", quantity: 2, type: "LMT", limitPrice: 99.5 });
  assert.equal(r.status, 200, r.text);
  const v = r.json.request;
  assert.equal(v.status, "preview");
  assert.match(v.clientOrderId, /^nc[0-9a-f]{18}$/);
  const writes = fake.state.writes.slice(before);
  assert.equal(writes.length, 1, "one preview call");
  const w = writes[0];
  assert.equal(w.method, "POST");
  assert.equal(w.path, "/v1/accounts/keyAlpha/orders/preview.json");
  assert.equal(w.contentType, "application/xml");
  assert.equal(w.accept, "application/json");
  assert.equal(fake.state.bodyTypes.at(-1), "xml");
  assert.equal(
    w.body,
    `<PreviewOrderRequest><orderType>EQ</orderType><clientOrderId>${v.clientOrderId}</clientOrderId><Order><allOrNone>false</allOrNone>` +
      "<priceType>LIMIT</priceType><orderTerm>GOOD_FOR_DAY</orderTerm><marketSession>REGULAR</marketSession><limitPrice>99.50</limitPrice>" +
      "<Instrument><Product><securityType>EQ</securityType><symbol>AAPL</symbol></Product><orderAction>BUY</orderAction>" +
      "<quantityType>QUANTITY</quantityType><quantity>2</quantity></Instrument></Order></PreviewOrderRequest>",
  );
  assert.equal(fake.state.signatureFailures, 0, "the POST signature checks out");
  assert.equal(v.preview.referencePrice, 100, "the midpoint of the quote");
  assert.equal(v.preview.quote.source, "E*TRADE quote");
  assert.equal(v.preview.quote.bid, 99.9);
  assert.equal(v.preview.instrument.name, "APPLE INC COM");
  assert.equal(v.preview.estimate.source, "E*TRADE");
  assert.equal(v.preview.estimate.notional, 199);
  assert.deepEqual(v.preview.position, { before: 10, after: 12 });
  const row = rowOf(v.id);
  assert.equal(row?.broker_state.orderAction, "BUY");
  assert.ok(Number.isSafeInteger(row?.broker_state.previewId));
  assert.ok(!JSON.stringify(row).includes("84012345"), "no full account number in the row");
  assert.equal(await auditRow("broker.order.preview"), undefined, "a successful preview writes no audit row");
});

test("ETRADE_ORDER_BODY=json sends a JSON body to the same path", async () => {
  const jsonSvc = createBrokerService(testConfig({ ETRADE_ORDER_BODY: "json" }), { db, etradeUrls: fake.urls });
  const jsonApi = await listen((req, res) => jsonSvc.api.handle(req, res));
  try {
    const r = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99 }, jsonApi.url);
    assert.equal(r.status, 200, r.text);
    const w = lastWrite();
    assert.equal(w.path, "/v1/accounts/keyAlpha/orders/preview.json");
    assert.equal(w.contentType, "application/json");
    assert.equal(fake.state.bodyTypes.at(-1), "json");
    const body = JSON.parse(w.body);
    assert.equal(body.PreviewOrderRequest.clientOrderId, r.json.request.clientOrderId);
    assert.deepEqual(body.PreviewOrderRequest.Order[0].Instrument[0], { Product: { securityType: "EQ", symbol: "AAPL" }, orderAction: "BUY", quantityType: "QUANTITY", quantity: "1" });
    assert.equal(fake.state.signatureFailures, 0);
  } finally {
    await jsonApi.close();
  }
});

test("encodeOrderBody round-trips through the fake's parser: repeated Order and Instrument, omitted prices, escaped text", () => {
  const value = {
    orderType: "EQ",
    clientOrderId: "nc0123456789abcdef01",
    PreviewIds: [{ previewId: 7 }],
    Order: [
      {
        allOrNone: "false",
        priceType: "MARKET",
        limitPrice: null,
        stopPrice: undefined,
        Instrument: [
          { Product: { securityType: "EQ", symbol: `A&B<C>"D'` }, orderAction: "BUY", quantity: "1" },
          { Product: { securityType: "EQ", symbol: "MSFT" }, orderAction: "SELL", quantity: "2" },
        ],
      },
      { allOrNone: "false", priceType: "LIMIT", limitPrice: "10.00", Instrument: [{ Product: { securityType: "EQ", symbol: "SPY" }, orderAction: "BUY", quantity: "3" }] },
    ],
  };
  const xml = encodeOrderBody("PlaceOrderRequest", value);
  assert.equal(xml.contentType, "application/xml");
  assert.ok(xml.body.includes("<PreviewIds><previewId>7</previewId></PreviewIds>"));
  assert.ok(xml.body.includes("<symbol>A&amp;B&lt;C&gt;&quot;D&apos;</symbol>"));
  assert.ok(!xml.body.includes("limitPrice>null") && !xml.body.includes("stopPrice"), "null and undefined are left out");
  assert.ok(!/^<\?xml/.test(xml.body) && !/>\s+</.test(xml.body), "no declaration, no whitespace between elements");
  const expected = JSON.parse(JSON.stringify({ PlaceOrderRequest: value }));
  delete expected.PlaceOrderRequest.Order[0].limitPrice;
  assert.deepEqual(canon(parseOrderXml(xml.body)), canon(expected));
  const json = encodeOrderBody("PlaceOrderRequest", value, "json");
  assert.equal(json.contentType, "application/json");
  assert.deepEqual(JSON.parse(json.body), JSON.parse(JSON.stringify({ PlaceOrderRequest: value })));
  assert.equal(encodeOrderBody("CancelOrderRequest", { orderId: 11 }).body, "<CancelOrderRequest><orderId>11</orderId></CancelOrderRequest>");
});

test("parseEtradeError reads JSON and XML error bodies", () => {
  assert.deepEqual(parseEtradeError(JSON.stringify({ Error: { code: 1021, message: " Not enough. " } })), { code: 1021, message: "Not enough." });
  assert.deepEqual(parseEtradeError(JSON.stringify({ error: { code: "1011", message: "far" } })), { code: 1011, message: "far" });
  assert.deepEqual(parseEtradeError("<Error><code>1028</code><message>This is a duplicate order &amp; more.</message></Error>"), { code: 1028, message: "This is a duplicate order & more." });
  assert.deepEqual(parseEtradeError("<html><body>Bad Request</body></html>"), { code: null, message: null });
  assert.equal(parseEtradeError(JSON.stringify({ Error: { code: 1, message: "x".repeat(300) } })).message?.length, 200);
});

test("the preview echo must match: another quantity or another account is refused", async () => {
  fake.state.previewEcho = (eo) => {
    eo.Instrument[0].quantity = 3;
  };
  const r = await preview({ symbol: "AAPL", side: "BUY", quantity: 2, type: "LMT", limitPrice: 99.5 });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, "etrade_echo_mismatch");
  assert.equal(r.json.error, "E*TRADE's preview did not match the order Nasscord sent, so it was stopped. Nothing was placed.");

  fake.state.previewEcho = (_eo, resp) => {
    resp.accountId = "84099999";
  };
  const other = await preview({ symbol: "AAPL", side: "BUY", quantity: 2, type: "LMT", limitPrice: 99.5 });
  assert.equal(other.status, 409);
  assert.equal(other.json.code, "account_mismatch");

  fake.state.previewEcho = (eo) => {
    eo.limitPrice = 99.6;
  };
  const price = await preview({ symbol: "AAPL", side: "BUY", quantity: 2, type: "LMT", limitPrice: 99.5 });
  assert.equal(price.status, 409);
  assert.equal(price.json.code, "etrade_echo_mismatch");
});

test("preview messages: 1042 shows as duplicate_risk, an ERROR message refuses", async () => {
  fake.state.previewMessages = [{ code: 1042, type: "WARNING", description: "200|You have an existing open order for this security on the same side of the market." }];
  const r = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99.5 });
  assert.equal(r.status, 200, r.text);
  assert.ok(
    r.json.request.preview.warnings.some(
      (/** @type {any} */ w) => w.code === "duplicate_risk" && w.source === "broker" && w.text === "You have an existing open order for this security on the same side of the market.",
    ),
  );
  fake.state.previewMessages = [{ code: 1037, type: "ERROR", description: "We did not find enough available shares." }];
  const refused = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99.5 });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.code, "broker_refused");
  assert.equal(refused.json.error, "E*TRADE: We did not find enough available shares.");
});

test("Market + GTC is refused before any call to E*TRADE", async () => {
  const calls = fake.state.calls.length;
  const r = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "MKT", tif: "GTC" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "bad_ticket");
  assert.equal(r.json.error, "E*TRADE takes Market orders as Day orders only.");
  assert.equal(fake.state.calls.length, calls);
});

test("the quote gives the reference price: a limit 40% away is refused, a delayed quote is labelled", async () => {
  const far = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 60 });
  assert.equal(far.status, 400, far.text);
  assert.equal(far.json.code, "price_band");

  const q = fake.state.quotes.AAPL;
  fake.state.quotes.AAPL = { ...q, quoteStatus: "DELAYED" };
  try {
    const r = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99.5 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.request.preview.quote.source, "E*TRADE delayed quote");
  } finally {
    fake.state.quotes.AAPL = q;
  }
});

test("no quote: a Stop order is refused with no_reference_price, a Market order uses E*TRADE's estimate", async () => {
  const stop = await preview({ symbol: "MSFT", side: "BUY", quantity: 1, type: "STP", stopPrice: 120 });
  assert.equal(stop.status, 409, stop.text);
  assert.equal(stop.json.code, "no_reference_price");

  const mkt = await preview({ symbol: "MSFT", side: "BUY", quantity: 2, type: "MKT" });
  assert.equal(mkt.status, 200, mkt.text);
  assert.equal(mkt.json.request.preview.quote, undefined);
  assert.equal(mkt.json.request.preview.referencePrice, 100, "notional / quantity of the preview estimate");
  const w = lastWrite();
  assert.ok(!w.body.includes("limitPrice") && !w.body.includes("stopPrice"), "a Market order carries no price fields");
});

test("place sends the previewed clientOrderId, PreviewIds and order once; cancel sends E*TRADE's XML", async () => {
  const p = await preview({ symbol: "AAPL", side: "BUY", quantity: 2, type: "LMT", limitPrice: 99.5 });
  assert.equal(p.status, 200, p.text);
  const id = p.json.request.id;
  const previewBody = canon(lastWrite().parsed).PreviewOrderRequest;
  const placeCalls = fake.state.placeCalls;

  const r = await place(id);
  assert.equal(r.status, 200, r.text);
  const v = r.json.request;
  assert.equal(v.status, "placed");
  assert.match(v.brokerOrderId, /^[0-9]+$/);
  assert.deepEqual(v.brokerMessages, [{ id: "1026", text: "Your order was successfully entered during market hours." }]);
  assert.equal(fake.state.placeCalls, placeCalls + 1);
  const w = lastWrite();
  assert.equal(w.path, "/v1/accounts/keyAlpha/orders/place.json");
  assert.equal(w.contentType, "application/xml");
  const placeBody = canon(w.parsed).PlaceOrderRequest;
  assert.equal(placeBody.clientOrderId, previewBody.clientOrderId);
  assert.equal(placeBody.clientOrderId, v.clientOrderId);
  assert.deepEqual(placeBody.Order, previewBody.Order);
  assert.equal(Number(placeBody.PreviewIds[0].previewId), rowOf(id)?.broker_state.previewId);
  assert.ok(Array.isArray(rowOf(id)?.broker_state.knownOrderIds), "the order numbers listed before the send are kept");

  const again = await place(id);
  assert.equal(again.status, 200);
  assert.equal(again.json.request.status, "placed");
  assert.equal(fake.state.placeCalls, placeCalls + 1, "a second place sends nothing");

  const c = await cancel(`etrade:${accountId}:${v.brokerOrderId}`);
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.status, "cancel_requested");
  const cw = lastWrite();
  assert.equal(cw.method, "PUT");
  assert.equal(cw.path, "/v1/accounts/keyAlpha/orders/cancel.json");
  assert.equal(cw.body, `<CancelOrderRequest><orderId>${v.brokerOrderId}</orderId></CancelOrderRequest>`);
  assert.equal(rowOf(id)?.status, "cancel_requested");

  const cancels = fake.state.cancelCalls;
  const twice = await cancel(`etrade:${accountId}:${v.brokerOrderId}`);
  assert.equal(twice.status, 200);
  assert.equal(twice.json.message, "E*TRADE is already cancelling this order.");
  assert.equal(fake.state.cancelCalls, cancels, "no second cancel is sent");

  const gone = await cancel(`etrade:${accountId}:999999`);
  assert.equal(gone.status, 404);
  assert.equal(gone.json.code, "order_not_open");
  assert.equal(fake.state.signatureFailures, 0);
});

test("a 401 on place renews the token but never sends a second place", async () => {
  const p = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 98 });
  assert.equal(p.status, 200, p.text);
  const placeCalls = fake.state.placeCalls;
  const callsBefore = fake.state.calls.length;
  fake.state.failNext = { path: "/orders/place.json", kind: "401" };
  const r = await place(p.json.request.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.request.status, "rejected");
  assert.equal(r.json.request.error, "E*TRADE asked Nasscord to sign in again, so it did not take the order. Nothing was placed. Preview the order again.");
  assert.equal(fake.state.placeCalls, placeCalls + 1);
  assert.ok(fake.state.calls.slice(callsBefore).some((c) => c.path === "/oauth/renew_access_token"), "the token was renewed");
  assert.equal(rows("broker_connections").find((c) => c.id === connectionId)?.status, "active");
});

for (const [label, type, price] of /** @type {const} */ ([["LIMIT", "LMT", 97.25], ["MARKET", "MKT", null]])) {
  test(`accept_then_drop of a ${label} order gives unknown, and the reconcile finds it by its fields`, async () => {
    const p = await preview({ symbol: "AAPL", side: "BUY", quantity: type === "MKT" ? 4 : 5, type, ...(price ? { limitPrice: price } : {}) });
    assert.equal(p.status, 200, p.text);
    const id = p.json.request.id;
    const placeCalls = fake.state.placeCalls;
    fake.state.failNext = { path: "/orders/place.json", kind: "accept_then_drop" };
    const r = await place(id);
    assert.equal(r.status, 200, r.text);
    assert.equal(fake.state.placeCalls, placeCalls + 1, "sent once, never again");
    const audit = await auditRow("broker.order.place", (a) => a.meta?.requestId === id);
    assert.equal(audit?.meta.outcome, "unknown");
    const book = fake.state.orders.keyAlpha;
    const recorded = book.at(-1);
    assert.equal(recorded.OrderDetail[0].priceType, label);
    if (type === "MKT") {
      assert.equal(recorded.OrderDetail[0].limitPrice, 0);
      assert.equal(recorded.OrderDetail[0].stopPrice, 0);
    }
    // The reconcile inside the place call found it.
    assert.equal(r.json.request.status, "placed");
    assert.equal(r.json.request.brokerOrderId, String(recorded.orderId));
    const q = fake.state.ordersQueries.at(-1);
    assert.equal(q?.symbol, "AAPL");
    assert.match(String(q?.fromDate), /^\d{8}$/);
    assert.match(String(q?.toDate), /^\d{8}$/);
    assert.ok(await auditRow("broker.order.reconcile", (a) => a.meta?.requestId === id));
  });
}

test("place errors: XML and JSON bodies give the mapped sentences; 1028 is unknown, never a resend", async () => {
  const xml = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99 });
  fake.state.failNext = { path: "/orders/place.json", kind: "xml_error", code: 1021, message: "We cannot accept this order because there are insufficient funds in your account." };
  const r1 = await place(xml.json.request.id);
  assert.equal(r1.json.request.status, "rejected");
  assert.equal(r1.json.request.error, "E*TRADE: not enough buying power for this order.");

  offset += 61_000;
  const json = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99.01 });
  fake.state.failNext = { path: "/orders/place.json", kind: "json_error", code: 1033, message: "timed out" };
  const r2 = await place(json.json.request.id);
  assert.equal(r2.json.request.status, "rejected");
  assert.equal(r2.json.request.error, "E*TRADE: the preview expired. Preview the order again.");

  offset += 61_000;
  const dup = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99.02 });
  const placeCalls = fake.state.placeCalls;
  fake.state.failNext = { path: "/orders/place.json", kind: "xml_error", code: 1028, message: "This is a duplicate order." };
  const r3 = await place(dup.json.request.id);
  assert.equal(r3.json.request.status, "unknown");
  assert.doesNotMatch(r3.json.request.error, /Nothing was placed/);
  assert.equal(fake.state.placeCalls, placeCalls + 1);
});

test("preview errors: XML and JSON error bodies give the mapped sentences", async () => {
  fake.state.failNext = { path: "/orders/preview.json", kind: "xml_error", code: 1021 };
  const r1 = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99 });
  assert.equal(r1.status, 422);
  assert.equal(r1.json.code, "broker_refused");
  assert.equal(r1.json.error, "E*TRADE: not enough buying power for this order.");
  fake.state.failNext = { path: "/orders/preview.json", kind: "json_error", code: 1011, message: "far" };
  const r2 = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99 });
  assert.equal(r2.status, 422);
  assert.equal(r2.json.error, "E*TRADE: the price is too far from the market.");
  fake.state.failNext = { path: "/orders/preview.json", kind: "status_500" };
  const r3 = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99 });
  assert.equal(r3.status, 502);
  assert.equal(r3.json.code, "broker_unavailable");
});

test("html_rate_limit on place is rejected (E*TRADE did not process it)", async () => {
  const p = await preview({ symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 98.5 });
  fake.state.failNext = { path: "/orders/place.json", kind: "html_rate_limit" };
  const r = await place(p.json.request.id);
  assert.equal(r.json.request.status, "rejected");
  assert.equal(r.json.request.error, "E*TRADE was limiting requests, so it did not take the order. Nothing was placed. Preview it again in a few seconds.");
});

for (const [kind, limitPrice] of /** @type {const} */ ([["html_400", 96.1], ["status_302", 96.2], ["status_500", 96.3], ["drop", 96.4]])) {
  test(`${kind} on place gives unknown, and "not found" never reads as "not placed"`, async () => {
    const p = await preview({ symbol: "AAPL", side: "BUY", quantity: 6, type: "LMT", limitPrice });
    assert.equal(p.status, 200, p.text);
    const placeCalls = fake.state.placeCalls;
    fake.state.failNext = { path: "/orders/place.json", kind };
    const r = await place(p.json.request.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.request.status, "unknown");
    assert.match(r.json.request.error, /E\*TRADE/);
    assert.doesNotMatch(r.json.request.error, /Nothing was placed/);
    assert.equal(r.json.request.error, "E*TRADE does not list this order yet. That does not mean it was not placed. Check E*TRADE before you place it again.");
    assert.equal(fake.state.placeCalls, placeCalls + 1, "never a second place");
  });
}

test("a BUY against a short sends BUY_TO_COVER; a SHORT with a positive quantity reads as negative", async () => {
  fake.state.positions.keyRoth = [[etradePositionRow("TSLA", 9, 100, "SHORT")]];
  try {
    const r = await preview({ accountId: rothId, symbol: "TSLA", side: "BUY", quantity: 10, type: "LMT", limitPrice: 200 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.request.preview.position, { before: -100, after: -90 });
    assert.equal(lastWrite().path, "/v1/accounts/keyRoth/orders/preview.json");
    assert.equal(canon(lastWrite().parsed).PreviewOrderRequest.Order[0].Instrument[0].orderAction, "BUY_TO_COVER");
    assert.equal(rowOf(r.json.request.id)?.broker_state.orderAction, "BUY_TO_COVER");

    const sell = await preview({ accountId: rothId, symbol: "TSLA", side: "SELL", quantity: 1, type: "LMT", limitPrice: 200 });
    assert.equal(sell.status, 400);
    assert.equal(sell.json.code, "no_short");
  } finally {
    delete fake.state.positions.keyRoth;
  }
});

test("portfolio paging: a short on page 2 is found whether the total is totalPages, totalNoOfPages or missing; past the last page read is unreadable", async () => {
  const filler = (/** @type {number} */ n) => Array.from({ length: 2 }, (_, i) => etradePositionRow(`F${n}X${i}`, 100 + n * 10 + i, 1));
  fake.state.positions.keyRoth = [filler(1), [etradePositionRow("TSLA", 9, 100, "SHORT")]];
  try {
    for (const total of /** @type {const} */ (["totalPages", "totalNoOfPages", "none"])) {
      fake.state.portfolioTotal = total;
      const r = await preview({ accountId: rothId, symbol: "TSLA", side: "BUY", quantity: 10, type: "LMT", limitPrice: 200 });
      assert.equal(r.status, 200, `${total}: ${r.text}`);
      assert.deepEqual(r.json.request.preview.position, { before: -100, after: -90 }, total);
      assert.equal(canon(lastWrite().parsed).PreviewOrderRequest.Order[0].Instrument[0].orderAction, "BUY_TO_COVER", total);
    }

    // The short on page 11, beyond the 10 pages Nasscord reads: refused as unreadable, not read as 0.
    fake.state.portfolioTotal = "none";
    fake.state.positions.keyRoth = [...Array.from({ length: 10 }, (_, i) => filler(i + 1)), [etradePositionRow("TSLA", 9, 100, "SHORT")]];
    const previews = fake.state.previewCalls;
    const far = await preview({ accountId: rothId, symbol: "TSLA", side: "BUY", quantity: 10, type: "LMT", limitPrice: 200 });
    assert.equal(far.status, 502, far.text);
    assert.equal(far.json.code, "position_unreadable");
    assert.equal(far.json.error, "Nasscord could not read your TSLA position at E*TRADE.");
    assert.equal(fake.state.previewCalls, previews, "no preview call to E*TRADE");
  } finally {
    fake.state.portfolioTotal = "totalPages";
    delete fake.state.positions.keyRoth;
  }
});

test("a working SELL order counts against a Sell and blocks a Close", async () => {
  // keyAlpha holds 10 AAPL and has an open stop sell of 10 (order 502).
  const r = await preview({ symbol: "AAPL", side: "SELL", quantity: 1, type: "LMT", limitPrice: 101 });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.code, "no_short");
  assert.match(r.json.error, /working sell orders already cover 10/);
  const q = fake.state.ordersQueries.at(-1);
  assert.equal(q?.symbol, "AAPL");
  assert.equal(q?.count, "100");

  const close = await preview({ symbol: "AAPL", side: "SELL", quantity: 10, type: "LMT", limitPrice: 101, intent: "close", positionId: `etrade:${accountId}:1`, expectedPositionQty: 10 });
  assert.equal(close.status, 409, close.text);
  assert.equal(close.json.code, "working_sells");
});

test("unreadable working orders refuse a Sell before any preview call", async () => {
  const previews = fake.state.previewCalls;
  fake.state.failNext = { path: "/keyAlpha/orders", kind: "status_500" };
  const r = await preview({ symbol: "MSFT", side: "SELL", quantity: 1, type: "LMT", limitPrice: 101 });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, "working_orders_unreadable");
  assert.doesNotMatch(r.json.error, /Nothing was placed/);
  assert.equal(fake.state.previewCalls, previews);
});

test("working orders: List Orders pages are followed by marker; a list Nasscord cannot prove complete sends nothing", async () => {
  const saved = fake.state.orders.keyAlpha;
  /** A filled AAPL order E*TRADE lists before the open stop sell 502. @param {number} id */
  const filled = (id) => ({ ...saved[0], orderId: id });
  try {
    // Three pages of one order each: the open stop sell of 10 sits on the last page and still counts.
    fake.state.orders.keyAlpha = [filled(601), filled(602), saved[1]];
    fake.state.ordersPageSize = 1;
    const before = fake.state.ordersQueries.length;
    let r = await preview({ symbol: "AAPL", side: "SELL", quantity: 1, type: "LMT", limitPrice: 101 });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, "no_short");
    assert.match(r.json.error, /working sell orders already cover 10/);
    const pages = fake.state.ordersQueries.slice(before);
    assert.deepEqual(pages.map((q) => q.marker ?? null), [null, "1", "2"]);

    // More pages than Nasscord reads: incomplete, so no preview call is made.
    const previews = fake.state.previewCalls;
    fake.state.orders.keyAlpha = [601, 602, 603, 604, 605, 606].map(filled);
    r = await preview({ symbol: "AAPL", side: "SELL", quantity: 1, type: "LMT", limitPrice: 101 });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, "working_orders_unreadable");

    // A full page without a marker cannot be told from a cut list: incomplete too.
    fake.state.ordersPageSize = 100;
    fake.state.ordersOmitMarker = true;
    fake.state.orders.keyAlpha = Array.from({ length: 101 }, (_, i) => filled(700 + i));
    r = await preview({ symbol: "AAPL", side: "SELL", quantity: 1, type: "LMT", limitPrice: 101 });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, "working_orders_unreadable");
    assert.equal(fake.state.previewCalls, previews);
  } finally {
    fake.state.orders.keyAlpha = saved;
    fake.state.ordersPageSize = null;
    fake.state.ordersOmitMarker = false;
  }
});

test("reconcile: one match is found; several are named; known and older orders never count", async () => {
  const connection = /** @type {any} */ (rows("broker_connections").find((c) => c.id === connectionId));
  const account = /** @type {any} */ (rows("broker_accounts").find((a) => a.id === accountId));
  const trading = /** @type {import("../src/order-contract.mjs").TradingAdapter} */ (svc.etrade.trading);
  const ctx = { connection, account, requestId: null, deadline: Date.now() + 20_000, saveBrokerState: async () => {} };
  const ticket = /** @type {import("../src/order-contract.mjs").Ticket} */ ({
    symbol: "SPY", side: "BUY", quantity: 7, type: "STP_LMT", limitPrice: 501.5, stopPrice: 500, tif: "GTC", bracket: null, intent: "trade", positionId: null, expectedPositionQty: null,
  });
  const previewTime = Date.now();
  /** @param {number} orderId @param {number} placedTime @param {Record<string, unknown>} [over] */
  const order = (orderId, placedTime, over = {}) => ({
    orderId,
    OrderDetail: [{
      placedTime, status: "OPEN", orderTerm: "GOOD_UNTIL_CANCEL", priceType: "STOP_LIMIT", limitPrice: 501.5, stopPrice: 500, ...over,
      Instrument: [{ Product: { symbol: "SPY", securityType: "EQ" }, orderAction: "BUY", orderedQuantity: 7, filledQuantity: 0 }],
    }],
  });
  const book = fake.state.orders.keyAlpha;
  const keep = [...book];
  try {
    book.push(order(7001, previewTime - 3_600_000), order(7002, previewTime + 1_000), order(7003, previewTime + 2_000, { limitPrice: 501.6 }), order(7004, previewTime + 1_500));
    const input = { ticket, clientOrderIds: ["nc000000000000000001"], brokerState: { previewTime, orderAction: "BUY", knownOrderIds: ["7004"] }, sentAt: new Date(previewTime).toISOString() };
    assert.deepEqual(await trading.reconcileOrder(ctx, input), { found: true, brokerOrderId: "7002" });

    book.push(order(7005, previewTime + 3_000));
    const several = await trading.reconcileOrder(ctx, input);
    assert.equal(several.found, false);
    assert.equal(/** @type {any} */ (several).detail, "E*TRADE lists 2 orders that match this one (numbers 7002, 7005). Check them before you place it again.");

    const none = await trading.reconcileOrder(ctx, { ...input, brokerState: { ...input.brokerState, orderAction: "BUY_TO_COVER" } });
    assert.deepEqual(none, { found: false });

    fake.state.failNext = { path: "/keyAlpha/orders", kind: "status_500" };
    const down = await trading.reconcileOrder(ctx, input);
    assert.equal(down.found, null);
  } finally {
    book.splice(0, book.length, ...keep);
  }
});

test("place refuses before sending when the previewed order or the side no longer match", async () => {
  const connection = /** @type {any} */ (rows("broker_connections").find((c) => c.id === connectionId));
  const account = /** @type {any} */ (rows("broker_accounts").find((a) => a.id === accountId));
  const trading = /** @type {import("../src/order-contract.mjs").TradingAdapter} */ (svc.etrade.trading);
  const ctx = { connection, account, requestId: null, deadline: Date.now() + 38_000, saveBrokerState: async () => {} };
  const ticket = /** @type {import("../src/order-contract.mjs").Ticket} */ ({
    symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 99, stopPrice: null, tif: "DAY", bracket: null, intent: "trade", positionId: null, expectedPositionQty: null,
  });
  const order = buildOrder(ticket, "BUY");
  const base = { ticket, clientOrderId: "nc000000000000000002", previousClientOrderIds: [], acknowledged: [], approvedMessages: [], position: { qty: 0, workingSell: 0, workingBuy: 0, working: false } };
  const placeCalls = fake.state.placeCalls;

  await assert.rejects(
    trading.placeOrder(ctx, { ...base, brokerState: { previewId: 5, orderAction: "BUY", order: { ...order, limitPrice: "98.00" } } }),
    (e) => e instanceof OrderNotSentError && e.message === "The previewed order no longer matches. Preview it again.",
  );
  await assert.rejects(
    trading.placeOrder(ctx, { ...base, position: { ...base.position, qty: -5 }, brokerState: { previewId: 5, orderAction: "BUY", order } }),
    (e) => e instanceof OrderNotSentError && e.code === "position_changed",
  );
  await assert.rejects(
    trading.placeOrder(ctx, { ...base, brokerState: { orderAction: "BUY", order } }),
    (e) => e instanceof OrderNotSentError && e.message === "The preview of this order is incomplete. Preview it again.",
  );
  await assert.rejects(
    trading.placeOrder({ ...ctx, deadline: Date.now() + 1_000 }, { ...base, brokerState: { previewId: 5, orderAction: "BUY", order } }),
    (e) => e instanceof OrderNotSentError && e.status === 504,
  );
  assert.equal(fake.state.placeCalls, placeCalls, "nothing was sent");
});

test("signedSend refuses any call off ETRADE_WRITE_ALLOW before the network", async () => {
  let fetches = 0;
  /** @type {typeof fetch} */
  const countingFetch = async () => {
    fetches++;
    return new Response(JSON.stringify({ PreviewOrderResponse: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = createEtradeClient({ environment: "production", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, connectionId: randomUUID(), urls: fake.urls, fetch: countingFetch });
  const t = { token: "t", secret: "s" };
  const payload = { root: /** @type {const} */ ("PreviewOrderRequest"), value: { orderType: "EQ" } };
  const refused = [
    ["POST", "/v1/accounts/keyAlpha/orders/change.json"],
    ["POST", "/v1/accounts/keyAlpha/orders/preview"],
    ["GET", "/v1/accounts/keyAlpha/orders/preview.json"],
    ["PUT", "/v1/accounts/keyAlpha/orders/place.json"],
    ["POST", "/v1/accounts/keyAlpha/orders/cancel.json"],
    ["DELETE", "/v1/accounts/keyAlpha/orders/cancel.json"],
    ["POST", "/v1/accounts/keyAlpha/orders/preview.json?x=1"],
    ["POST", "/v1/accounts/../orders/preview.json"],
    ["POST", "/v1/accounts/key%2fAlpha/orders/preview.json"],
    ["POST", "/v1/accounts/keyAlpha/orders/place.json/"],
    ["POST", "/v1/market/quote/AAPL"],
    ["POST", "/oauth/renew_access_token"],
  ];
  for (const [method, path] of refused) {
    assert.equal(isAllowed(ETRADE_WRITE_ALLOW, method, path), false, `${method} ${path}`);
    await assert.rejects(client.signedSend(method, path, t, payload), (e) => e instanceof ReadOnlyViolation, `${method} ${path}`);
  }
  assert.equal(fetches, 0, "nothing left the process");
  const ok = await client.signedSend("POST", "/v1/accounts/keyAlpha/orders/preview.json", t, payload);
  assert.equal(ok.kind, "ok");
  assert.equal(fetches, 1);
});

test("signedSend measures the deadline again after the limiter's wait and sends nothing when too little is left", async () => {
  let fetches = 0;
  /** @type {typeof fetch} */
  const countingFetch = async () => {
    fetches++;
    return new Response(JSON.stringify({ PlaceOrderResponse: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let left = 30_000;
  // A limiter that waits (a back-off): the deadline is nearly used up when it lets the call go.
  const limiter = /** @type {any} */ ({ etrade: async () => void (left = 3_000), ok: () => {}, backoff: () => 1_000 });
  const client = createEtradeClient({ environment: "production", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, connectionId: randomUUID(), urls: fake.urls, fetch: countingFetch, limiter });
  const t = { token: "t", secret: "s" };
  const payload = { root: /** @type {const} */ ("PlaceOrderRequest"), value: { orderType: "EQ" } };
  await assert.rejects(
    client.signedSend("POST", "/v1/accounts/keyAlpha/orders/place.json", t, payload, { timeoutMs: 20_000, timeLeft: () => left, minLeftMs: 5_000 }),
    (/** @type {any} */ e) => e.code === "not_sent" && e.status === 504,
  );
  assert.equal(fetches, 0, "nothing left the process");
  left = 30_000;
  const ok = await client.signedSend("POST", "/v1/accounts/keyAlpha/orders/place.json", t, payload, { timeoutMs: 20_000, timeLeft: () => left, minLeftMs: 2_000 });
  assert.equal(ok.kind, "ok");
  assert.equal(fetches, 1);
});

test("pure helpers: orderAction, buildOrder and etradeSentence", () => {
  assert.equal(orderAction("BUY", 0), "BUY");
  assert.equal(orderAction("BUY", -3), "BUY_TO_COVER");
  assert.equal(orderAction("SELL", 10), "SELL");
  const t = /** @type {import("../src/order-contract.mjs").Ticket} */ ({
    symbol: "SPY", side: "SELL", quantity: 3, type: "STP_LMT", limitPrice: 0.5, stopPrice: 0.51, tif: "GTC", bracket: null, intent: "trade", positionId: null, expectedPositionQty: null,
  });
  assert.deepEqual(buildOrder(t, "SELL"), {
    allOrNone: "false",
    priceType: "STOP_LIMIT",
    orderTerm: "GOOD_UNTIL_CANCEL",
    marketSession: "REGULAR",
    limitPrice: "0.5000",
    stopPrice: "0.5100",
    Instrument: [{ Product: { securityType: "EQ", symbol: "SPY" }, orderAction: "SELL", quantityType: "QUANTITY", quantity: "3" }],
  });
  assert.deepEqual(Object.keys(buildOrder({ ...t, type: "MKT", limitPrice: null, stopPrice: null, tif: "DAY" }, "BUY")), ["allOrNone", "priceType", "orderTerm", "marketSession", "Instrument"]);
  assert.equal(etradeSentence(4124, "x"), "E*TRADE: you do not hold enough shares for this sell.");
  assert.equal(etradeSentence(1049, null), "E*TRADE is still working on an earlier request. Nothing was placed. Wait a moment and preview again.");
  assert.equal(etradeSentence(77777, "Something odd."), "E*TRADE: Something odd.");
  assert.equal(etradeSentence(77777, null), "E*TRADE refused the order (code 77777).");
});

test("no secret in the log of the order path or in the order rows", () => {
  assert.ok(logLines.some((l) => l.includes("etrade order outcome")), "the order path logged");
  const all = JSON.stringify([rows("order_requests"), rows("audit_events"), logLines]);
  assert.ok(!all.includes(CONSUMER_SECRET));
  assert.ok(!all.includes(CONSUMER_KEY));
  assert.ok(!all.includes("84012345"), "no full account number");
  assert.ok(!all.includes("keyAlpha"), "no account key");
  assert.ok(!/oauth_signature|OAuth /.test(all), "no OAuth header");
  assert.equal(fake.state.signatureFailures, 0, "every request E*TRADE saw was signed correctly");
});
