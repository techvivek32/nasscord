import assert from "node:assert/strict";
import { test } from "node:test";
import { badGateway, HttpError } from "../src/errors.mjs";
import { isAllowed } from "../src/http.mjs";
import {
  batches,
  CALL_TIMEOUT_MS,
  categoryOf,
  createTradeStationClient,
  MAX_HISTORY_PAGES,
  MIN_CALL_MS,
  orderBudget,
  sinceDate,
  TRADESTATION_HOSTS,
  TRADESTATION_READ_ALLOW,
  tradestationHosts,
} from "../src/tradestation/client.mjs";
import { keyProblem, TRADESTATION_MESSAGES, tsTokenError } from "../src/tradestation/index.mjs";
import {
  errorSentence,
  mergeOrders,
  tsAccountRows,
  tsAccountSummary,
  tsExecutions,
  tsOrder,
  tsOrders,
  tsOrderStatus,
  tsOrderType,
  tsPosition,
  tsSecType,
} from "../src/tradestation/mapping.mjs";

/**
 * TradeStation v3 answers -> Nasscord shapes, the key and token-error rules, and the read-only
 * allowlist, as pure functions. Payloads follow TradeStation's v3 specification (numbers as strings).
 */

const T0 = Date.parse("2026-11-16T15:00:00Z");
const A1 = { id: "11111111-1111-4111-8111-111111111111", external_id: "123456782" };
const A2 = { id: "22222222-2222-4222-8222-222222222222", external_id: "210FUT01" };

test("accounts: closed ones are left out, types and labels follow AccountType, a restriction shows in the label", () => {
  const rows = tsAccountRows(
    [
      { AccountID: "123456782", AccountType: "Margin", Status: "Active", Currency: "USD" },
      { AccountID: "123456790", AccountType: "Cash", Status: "Active" },
      { AccountID: "210FUT01", AccountType: "Futures", Status: "Closing Transaction Only" },
      { AccountID: "11111DVP", AccountType: "DVP", Status: "Active", Alias: "Trust desk" },
      { AccountID: "99999999", AccountType: "Margin", Status: "Closed" },
      { AccountID: "../orders", AccountType: "Cash", Status: "Active" },
      { AccountID: "123456782", AccountType: "Margin", Status: "Active" },
      {},
    ],
    "production",
  );
  assert.deepEqual(rows, [
    { broker_id: "tradestation", external_id: "123456782", display_number: "123•••82", label: "TradeStation Margin", type: "margin" },
    { broker_id: "tradestation", external_id: "123456790", display_number: "123•••90", label: "TradeStation Cash", type: "individual" },
    { broker_id: "tradestation", external_id: "210FUT01", display_number: "210•••01", label: "TradeStation Futures (Closing Transaction Only)", type: "individual" },
    { broker_id: "tradestation", external_id: "11111DVP", display_number: "111•••VP", label: "Trust desk", type: "individual" },
  ]);
});

test("accounts on SIM are Paper", () => {
  const [row] = tsAccountRows([{ AccountID: "SIM1234567M", AccountType: "Margin", Status: "Active" }], "paper");
  assert.equal(row.type, "paper");
  assert.equal(row.label, "TradeStation Paper");
});

test("balances: strings parsed, day P&L from TodaysProfitLoss, else equity since the beginning of the day", () => {
  assert.deepEqual(tsAccountSummary({ AccountID: "123456782", Equity: "25010.55", CashBalance: "1000.10", BuyingPower: "50000", TodaysProfitLoss: "-12.3" }, A1), {
    accountId: A1.id,
    netLiq: 25010.55,
    cash: 1000.1,
    buyingPower: 50000,
    dayPnl: -12.3,
    currency: "USD",
  });
  const fromBod = tsAccountSummary({ AccountID: "123456782", Equity: "25010.55" }, A1, { AccountID: "123456782", BalanceDetail: { Equity: "25000.00" } });
  assert.equal(fromBod.dayPnl, 10.55);
  const missing = tsAccountSummary({ AccountID: "123456782" }, A1);
  assert.deepEqual(missing, { accountId: A1.id, currency: "USD" }, "values TradeStation did not send are left out, never 0");
});

test("positions: shorts are negative whether Quantity comes signed or not; asset types map to secType", () => {
  const long = tsPosition(
    { AccountID: "123456782", PositionID: "64630792", Symbol: "MSFT", AssetType: "STOCK", LongShort: "Long", Quantity: "10", AveragePrice: "400.10", Last: "410.5", MarketValue: "4105", UnrealizedProfitLoss: "104", TodaysProfitLoss: "-3.2" },
    A1,
  );
  assert.deepEqual(long, {
    id: `tradestation:${A1.id}:64630792`,
    accountId: A1.id,
    brokerId: "tradestation",
    symbol: "MSFT",
    qty: 10,
    avgCost: 400.1,
    last: 410.5,
    currency: "USD",
    secType: "STK",
    dayPnl: -3.2,
    marketValue: 4105,
    unrealizedPnl: 104,
  });
  assert.equal(tsPosition({ Symbol: "TSLA", LongShort: "Short", Quantity: "5" }, A1).qty, -5);
  assert.equal(tsPosition({ Symbol: "TSLA", LongShort: "Short", Quantity: "-5" }, A1).qty, -5);
  assert.equal(tsPosition({ Symbol: "X", Quantity: "1", MarkToMarketPrice: "7" }, A1).last, 7);
  assert.equal(tsSecType("STOCKOPTION"), "OPT");
  assert.equal(tsSecType("INDEXOPTION"), "OPT");
  assert.equal(tsSecType("FUTURE"), "FUT");
  assert.equal(tsSecType("FUTUREOPTION"), "FOP");
  assert.equal(tsSecType(undefined), "STK");
});

test("order status codes", () => {
  for (const c of ["OPN", "ACK", "DON", "FPR", "UCN", "LAT"]) assert.equal(tsOrderStatus(c), "working", c);
  assert.equal(tsOrderStatus("FLL"), "filled");
  for (const c of ["CAN", "EXP", "OUT", "UCH", "TSC", "FLP"]) assert.equal(tsOrderStatus(c), "cancelled", c);
  for (const c of ["REJ", "BRO"]) assert.equal(tsOrderStatus(c), "rejected", c);
  assert.equal(tsOrderStatus("ZZZ"), "working", "an unknown code of a live order");
  assert.equal(tsOrderStatus("ZZZ", true), "cancelled", "an unknown code of a closed order never shows as working");
  assert.equal(tsOrderStatus("OPN", true), "working");
});

test("order types", () => {
  assert.equal(tsOrderType("Market", false), "MKT");
  assert.equal(tsOrderType("Limit", true), "LMT");
  assert.equal(tsOrderType("StopMarket", true), "STP");
  assert.equal(tsOrderType("StopLimit", true), "STP");
  assert.equal(tsOrderType("TrailingStop", false), "TRAIL");
  assert.equal(tsOrderType("Something", true), "LMT");
  assert.equal(tsOrderType("", false), "MKT");
});

test("an order: one Order per leg, durations, prices and fills", () => {
  const [one] = tsOrder(
    {
      AccountID: "123456782",
      OrderID: "1001",
      OrderType: "Limit",
      Status: "FLL",
      Duration: "GTC",
      LimitPrice: "101.50",
      FilledPrice: "101.25",
      OpenedDateTime: "2026-11-16T14:30:00Z",
      ClosedDateTime: "2026-11-16T14:31:00Z",
      Legs: [{ Symbol: "AAPL", AssetType: "STOCK", BuyOrSell: "Buy", QuantityOrdered: "10", ExecQuantity: "10", ExecutionPrice: "101.25" }],
    },
    A1,
    T0,
  );
  assert.deepEqual(one, {
    id: `tradestation:${A1.id}:1001`,
    clientId: "tradestation-1001",
    accountId: A1.id,
    brokerId: "tradestation",
    symbol: "AAPL",
    side: "BUY",
    qty: 10,
    type: "LMT",
    tif: "GTC",
    status: "filled",
    placedAt: "2026-11-16T14:30:00.000Z",
    brokerRef: "1001",
    price: 101.5,
    filledQty: 10,
    avgFill: 101.25,
    outsideRth: false,
  });

  const spread = tsOrder(
    {
      AccountID: "123456782",
      OrderID: "1002",
      OrderType: "StopMarket",
      Status: "OPN",
      Duration: "DYP",
      StopPrice: "3.10",
      OpenedDateTime: "bad date",
      Legs: [
        { Symbol: "SPY 261218C600", AssetType: "STOCKOPTION", BuyOrSell: "BuyToOpen", QuantityOrdered: "2", ExecQuantity: "0" },
        { Symbol: "SPY 261218C610", AssetType: "STOCKOPTION", BuyOrSell: "SellToOpen", QuantityOrdered: "2", ExecQuantity: "0" },
      ],
    },
    A1,
    T0,
  );
  assert.equal(spread.length, 2);
  assert.deepEqual(
    spread.map((o) => [o.id, o.side, o.type, o.price, o.tif, o.outsideRth, o.status, o.placedAt, o.avgFill]),
    [
      [`tradestation:${A1.id}:1002:0`, "BUY", "STP", 3.1, "DAY", true, "working", new Date(T0).toISOString(), undefined],
      [`tradestation:${A1.id}:1002:1`, "SELL", "STP", 3.1, "DAY", true, "working", new Date(T0).toISOString(), undefined],
    ],
  );

  const [trail] = tsOrder({ AccountID: "123456782", OrderID: "1003", OrderType: "TrailingStop", Status: "ACK", AdvancedOptions: { TrailingStop: { Percent: "2.5" } }, Legs: [{ Symbol: "QQQ", BuyOrSell: "Sell", QuantityOrdered: "1" }] }, A1, T0);
  assert.equal(trail.type, "TRAIL");
  assert.equal(trail.trailPct, 2.5);
  assert.equal(trail.price, undefined);
  assert.deepEqual(tsOrder({ AccountID: "123456782", Legs: [{ Symbol: "X" }] }, A1, T0), [], "an order without an OrderID is dropped");
});

test("orders of both lists are merged once each (the /orders copy first), for the read's accounts only", () => {
  const current = [
    { AccountID: "123456782", OrderID: "1", Status: "FLL", Legs: [{ Symbol: "A", BuyOrSell: "Buy", QuantityOrdered: "1", ExecQuantity: "1" }] },
    { AccountID: "123456782", OrderID: "2", Status: "OPN", Legs: [{ Symbol: "B", BuyOrSell: "Buy", QuantityOrdered: "1" }] },
  ];
  const history = [
    { AccountID: "123456782", OrderID: "1", Status: "OPN", Legs: [{ Symbol: "A", BuyOrSell: "Buy", QuantityOrdered: "1" }] },
    { AccountID: "123456782", OrderID: "3", Status: "CAN", Legs: [{ Symbol: "C", BuyOrSell: "Sell", QuantityOrdered: "1" }] },
    { AccountID: "555555555", OrderID: "4", Status: "FLL", Legs: [{ Symbol: "D", BuyOrSell: "Buy", QuantityOrdered: "1" }] },
    { AccountID: "210FUT01", OrderID: "1", Status: "FLL", Legs: [{ Symbol: "ESZ26", BuyOrSell: "Buy", QuantityOrdered: "1" }] },
  ];
  const merged = mergeOrders(current, history, [A1, A2]);
  assert.deepEqual(
    merged.map((o) => `${o.AccountID}:${o.OrderID}:${o.Status}`),
    ["123456782:1:FLL", "123456782:2:OPN", "123456782:3:CAN", "210FUT01:1:FLL"],
  );
  const orders = tsOrders(merged, [A1, A2], T0);
  assert.equal(new Set(orders.map((o) => o.id)).size, orders.length, "order ids are unique");
  assert.equal(orders.find((o) => o.brokerRef === "1" && o.accountId === A1.id)?.status, "filled");
});

test("executions from legs: commission split over executed legs, options times 100, futures net is the commission", () => {
  const orders = [
    {
      AccountID: "123456782",
      OrderID: "10",
      Status: "FLL",
      CommissionFee: "1.31",
      OpenedDateTime: "2026-11-16T14:00:00Z",
      ClosedDateTime: "2026-11-16T14:05:00Z",
      Legs: [
        { Symbol: "SPY 261218C600", AssetType: "STOCKOPTION", BuyOrSell: "BuyToOpen", QuantityOrdered: "2", ExecQuantity: "2", ExecutionPrice: "3.10" },
        { Symbol: "SPY 261218C610", AssetType: "STOCKOPTION", BuyOrSell: "SellToOpen", QuantityOrdered: "2", ExecQuantity: "2", ExecutionPrice: "1.20" },
        { Symbol: "SPY 261218C620", AssetType: "STOCKOPTION", BuyOrSell: "SellToOpen", QuantityOrdered: "2", ExecQuantity: "0" },
      ],
    },
    {
      AccountID: "123456782",
      OrderID: "11",
      Status: "FPR",
      CommissionFee: "0.50",
      FilledPrice: "50.00",
      OpenedDateTime: "2026-11-16T14:10:00Z",
      Legs: [{ Symbol: "XYZ", AssetType: "STOCK", BuyOrSell: "SellShort", QuantityOrdered: "100", ExecQuantity: "40" }],
    },
    {
      AccountID: "210FUT01",
      OrderID: "12",
      Status: "FLL",
      CommissionFee: "2.25",
      ClosedDateTime: "2026-11-16T14:20:00Z",
      Legs: [{ Symbol: "ESZ26", AssetType: "FUTURE", BuyOrSell: "Buy", QuantityOrdered: "1", ExecQuantity: "1", ExecutionPrice: "6000.25" }],
    },
    { AccountID: "123456782", OrderID: "13", Status: "CAN", Legs: [{ Symbol: "NOPE", BuyOrSell: "Buy", QuantityOrdered: "5", ExecQuantity: "0" }] },
  ];
  const ex = tsExecutions(orders, [A1, A2], T0);
  assert.deepEqual(
    ex.map((e) => [e.id, e.symbol, e.side, e.qty, e.price, e.commission, e.net, e.tradedAt, e.provisional ?? false]),
    [
      [`tradestation:${A1.id}:10:0`, "SPY 261218C600", "BUY", 2, 3.1, 0.66, -620.66, "2026-11-16T14:05:00.000Z", false],
      [`tradestation:${A1.id}:10:1`, "SPY 261218C610", "SELL", 2, 1.2, 0.65, 239.35, "2026-11-16T14:05:00.000Z", false],
      [`tradestation:${A1.id}:11`, "XYZ", "SELL", 40, 50, 0.5, 1999.5, "2026-11-16T14:10:00.000Z", true],
      [`tradestation:${A2.id}:12`, "ESZ26", "BUY", 1, 6000.25, 2.25, -2.25, "2026-11-16T14:20:00.000Z", false],
    ],
  );
  const total = ex.filter((e) => e.id.includes(":10:")).reduce((s, e) => s + e.commission, 0);
  assert.equal(Math.round(total * 100), 131, "the split adds up to the order's commission");
});

test("Errors[] entries become sentences with the account masked and no broker text", () => {
  assert.equal(errorSentence({ AccountID: "123456782", Error: "Forbidden", Message: "secret detail 123456782" }, "balances"), "TradeStation could not send the balances of account 123•••82 (Forbidden).");
  assert.equal(errorSentence({ Error: "<script>" }, "orders"), "TradeStation could not send the orders.");
});

test("API keys: a legacy key (capital letters with dashes) is refused with a sentence asking for a newer key", () => {
  assert.equal(keyProblem("EAC7BF97-1A2B-4C3D-8E9F-0123456789AB"), TRADESTATION_MESSAGES.legacyKey);
  assert.match(TRADESTATION_MESSAGES.legacyKey, /newer API key/);
  assert.equal(keyProblem("aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY"), null, "an Auth0 key passes");
  assert.equal(keyProblem("key with spaces"), TRADESTATION_MESSAGES.badKey);
  assert.equal(keyProblem(""), TRADESTATION_MESSAGES.badKey);
});

test("token errors: Auth0's answers as the engine acts on them", () => {
  assert.equal(tsTokenError(403, { error: "invalid_grant" }), "invalid_grant");
  assert.equal(tsTokenError(401, { error: "access_denied", error_description: "Unauthorized" }), "invalid_client");
  assert.equal(tsTokenError(400, { error: "invalid_client" }), "invalid_client");
  assert.equal(tsTokenError(403, { error: "access_denied" }), "invalid_grant", "the user's grant was refused: a new login, not a bad key");
  assert.equal(tsTokenError(500, null), "other");
  assert.equal(tsTokenError(429, { error: "too_many_requests" }), "other");
});

test("read-only allowlist: the six read endpoints only; order entry, revoke and odd paths are refused", () => {
  const allowed = [
    "/v3/brokerage/accounts",
    "/v3/brokerage/accounts/123456782/balances",
    "/v3/brokerage/accounts/123456782,210FUT01/bodbalances",
    "/v3/brokerage/accounts/123456782/positions",
    "/v3/brokerage/accounts/123456782/orders",
    "/v3/brokerage/accounts/SIM1234567M/historicalorders",
  ];
  for (const p of allowed) assert.equal(isAllowed([...TRADESTATION_READ_ALLOW], "GET", p), true, p);
  for (const p of allowed) for (const m of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal(isAllowed([...TRADESTATION_READ_ALLOW], m, p), false, `${m} ${p}`);
  const refused = [
    ["POST", "/v3/orderexecution/orders"],
    ["POST", "/v3/orderexecution/orderconfirm"],
    ["POST", "/v3/orderexecution/ordergroups"],
    ["PUT", "/v3/orderexecution/orders/123"],
    ["DELETE", "/v3/orderexecution/orders/123"],
    ["GET", "/v3/orderexecution/routes"],
    ["POST", "/oauth/revoke"],
    ["POST", "/oauth/token"],
    ["GET", "/v3/brokerage/accounts/123456782/orders/1001"],
    ["GET", "/v3/brokerage/stream/accounts/123456782/orders"],
    ["GET", "/v3/brokerage/accounts/../orderexecution/orders"],
    ["GET", "/v3/brokerage/accounts/123456782/balances?x=1"],
    ["GET", "/v3/brokerage/accounts/%2e%2e/balances"],
    ["GET", `/v3/brokerage/accounts/${Array.from({ length: 26 }, (_, i) => `A${i}`).join(",")}/balances`],
    ["GET", "/v3/marketdata/quotes/MSFT"],
  ];
  for (const [m, p] of refused) assert.equal(isAllowed([...TRADESTATION_READ_ALLOW], m, p), false, `${m} ${p}`);
});

test("client helpers: batches of 10 checked ids, rate categories, the since date, hosts", () => {
  const ids = Array.from({ length: 23 }, (_, i) => `ACC${i}`);
  assert.deepEqual(
    batches(ids).map((b) => b.length),
    [10, 10, 3],
  );
  assert.deepEqual(batches(["A1", "A1", "A2"]), [["A1", "A2"]]);
  assert.throws(() => batches(["123,456"]), /refused/);
  assert.throws(() => batches([".."]), /refused/);
  assert.equal(categoryOf("/v3/brokerage/accounts"), "accounts");
  assert.equal(categoryOf("/v3/brokerage/accounts/1/balances"), "balances");
  assert.equal(categoryOf("/v3/brokerage/accounts/1/bodbalances"), "balances");
  assert.equal(categoryOf("/v3/brokerage/accounts/1/positions"), "positions");
  assert.equal(categoryOf("/v3/brokerage/accounts/1/historicalorders"), "orders");
  assert.equal(sinceDate(Date.parse("2026-08-19T03:00:00Z")), "2026-08-19");
  const fakes = { signin: "http://127.0.0.1:1", live: "http://127.0.0.1:2", sim: "http://127.0.0.1:3" };
  assert.deepEqual(tradestationHosts(fakes, false), fakes);
  assert.deepEqual(tradestationHosts(fakes, true), { ...TRADESTATION_HOSTS }, "local fakes never stand in for TradeStation in production");
  assert.deepEqual(tradestationHosts({}, false), { ...TRADESTATION_HOSTS });
});

test("order paging: the page cap and the time budget end a read with what came so far (cut); the read's first call is never cut", async () => {
  let t = 0;
  /** @type {Array<{ path: string, timeoutMs: number | undefined }>} */
  const calls = [];
  let more = true;
  /** @type {(n: number) => unknown} the error call n throws, if any */
  let failAt = () => null;
  const http = /** @type {any} */ (
    () => ({
      get: async (/** @type {string} */ path, /** @type {any} */ _query, /** @type {any} */ o) => {
        calls.push({ path, timeoutMs: o?.timeoutMs });
        t += 1_000;
        const e = failAt(calls.length);
        if (e) throw e;
        return { Orders: [{ OrderID: String(calls.length) }], ...(more ? { NextToken: `n${calls.length}` } : {}) };
      },
    })
  );
  const c = createTradeStationClient({ http, base: "https://sim-api.tradestation.com", token: "t", bucketPrefix: "tradestation:test", now: () => t });
  const reset = () => {
    calls.length = 0;
    failAt = () => null;
    more = true;
  };

  // No budget: the page cap ends it, with a NextToken left.
  const capped = await c.historicalOrders(["100000001"], "2026-08-01");
  assert.equal(calls.length, MAX_HISTORY_PAGES);
  assert.equal(capped.items.length, MAX_HISTORY_PAGES);
  assert.equal(capped.cut, "pages");
  assert.ok(calls.every((x) => x.timeoutMs === undefined), "the client's own limit applies");
  reset();
  more = false;
  assert.equal((await c.orders(["100000001"])).cut, null, "everything read");

  // A 3.5 s budget and calls of 1 s: three calls, then too little is left for a fourth.
  reset();
  const budget = orderBudget(() => t, 3_500);
  const timed = await c.historicalOrders(["100000001"], "2026-08-01", budget);
  assert.deepEqual(
    calls.map((x) => x.timeoutMs),
    [3_500, 2_500, 1_500],
    "each call waits at most the time left",
  );
  assert.equal(timed.items.length, 3);
  assert.equal(timed.cut, "time");
  reset();
  const none = await c.orders(["100000001"], budget);
  assert.equal(calls.length, 0, "the budget is shared by the read's calls");
  assert.deepEqual([none.items.length, none.cut], [0, "time"]);

  // A later call that times out ends the read with what came; the first one fails the read.
  reset();
  const slowLater = badGateway("TradeStation did not answer within 6 seconds. Try again in a moment.", "broker_timeout");
  failAt = (n) => (n === 2 ? slowLater : null);
  const later = await c.orders(["100000001"], orderBudget(() => t, 20_000));
  assert.equal(calls[0].timeoutMs, CALL_TIMEOUT_MS, "never more than one call's own limit");
  assert.deepEqual([later.items.length, later.cut], [1, "time"]);
  reset();
  failAt = (n) => (n === 1 ? slowLater : null);
  await assert.rejects(c.orders(["100000001"], orderBudget(() => t, 20_000)), (/** @type {unknown} */ e) => e instanceof HttpError && e.code === "broker_timeout");
  reset();
  const late = orderBudget(() => t, 0);
  more = false;
  assert.equal((await c.orders(["100000001"], late)).items.length, 1, "the first call is made even with no time left");
  assert.equal(calls[0].timeoutMs, MIN_CALL_MS);
  // Other errors are the read's failure whenever they come.
  reset();
  failAt = (n) => (n === 2 ? badGateway("TradeStation is not answering right now (503). Try again in a moment.", "broker_down") : null);
  await assert.rejects(c.orders(["100000001"], orderBudget(() => t, 20_000)), (/** @type {unknown} */ e) => e instanceof HttpError && e.code === "broker_down");
});
