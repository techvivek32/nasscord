import assert from "node:assert/strict";
import { test } from "node:test";
import {
  schwabAccountRows,
  schwabAccountSummary,
  schwabAccountType,
  schwabExecutions,
  schwabFeesByOrder,
  schwabHashes,
  schwabOrders,
  schwabOrderStatus,
  schwabPosition,
  schwabPrefs,
  schwabSecType,
  schwabTime,
} from "../src/schwab/mapping.mjs";

const ACCT = { id: "11111111-2222-3333-4444-555555555555" };
const NOW = Date.parse("2026-11-16T15:00:00Z");

test("account hashes: only well-formed pairs", () => {
  assert.deepEqual(
    schwabHashes([
      { accountNumber: "12345678", hashValue: "ABCDEF0123" },
      { accountNumber: 87654321, hashValue: "FFFF" },
      { accountNumber: "1", hashValue: "../x" },
      { accountNumber: "", hashValue: "AAAA" },
      null,
    ]),
    { 12345678: "ABCDEF0123", 87654321: "FFFF" },
  );
  assert.deepEqual(schwabHashes({ not: "a list" }), {});
});

test("accounts: type from MARGIN/CASH, Roth and IRA from the nickname, masked numbers, nickname labels", () => {
  const prefs = schwabPrefs({
    accounts: [
      { accountNumber: "11112222", nickName: "Swing", type: "BROKERAGE" },
      { accountNumber: "33334444", nickName: "Roth Contributory IRA" },
      { accountNumber: "55556666", nickName: "Rollover IRA" },
      { accountNumber: "77778888", nickName: "77778888" },
    ],
    streamerInfo: [{ schwabClientCustomerId: "not read" }],
  });
  assert.equal(prefs.size, 4);
  const rows = schwabAccountRows(
    [
      { securitiesAccount: { type: "MARGIN", accountNumber: "11112222" } },
      { securitiesAccount: { type: "CASH", accountNumber: "33334444" } },
      { securitiesAccount: { type: "CASH", accountNumber: "55556666" } },
      { securitiesAccount: { type: "CASH", accountNumber: "77778888" } },
      { securitiesAccount: { type: "CASH", accountNumber: "11112222" } },
      { securitiesAccount: { type: "CASH" } },
    ],
    prefs,
  );
  assert.deepEqual(
    rows.map((r) => [r.external_id, r.display_number, r.label, r.type, r.broker_id]),
    [
      ["11112222", "111•••22", "Swing", "margin", "schwab"],
      ["33334444", "333•••44", "Roth Contributory IRA", "roth", "schwab"],
      ["55556666", "555•••66", "Rollover IRA", "ira", "schwab"],
      ["77778888", "777•••88", "Schwab Individual", "individual", "schwab"],
    ],
    "a duplicate and a row without a number are left out; a nickname that is the number is not shown",
  );
  assert.equal(schwabAccountType({ type: "MARGIN" }, undefined), "margin");
  assert.equal(schwabAccountType({ type: "CASH" }, { nickName: "", type: "IRA" }), "ira");
  // userPreference sometimes arrives as a one-element array.
  assert.equal(schwabPrefs([{ accounts: [{ accountNumber: "1", nickName: "A" }] }]).get("1")?.nickName, "A");
});

test("balances: margin and cash accounts; day P&L only when Schwab sends it", () => {
  const margin = schwabAccountSummary(
    {
      securitiesAccount: {
        type: "MARGIN",
        currentBalances: { liquidationValue: 1000.123, cashBalance: 200, buyingPower: 1500, availableFunds: 900 },
        positions: [{ currentDayProfitLoss: 5 }, { currentDayProfitLoss: -1.25 }, {}],
      },
    },
    ACCT,
  );
  assert.deepEqual(margin, { accountId: ACCT.id, netLiq: 1000.12, buyingPower: 1500, cash: 200, dayPnl: 3.75, currency: "USD" });
  const cash = schwabAccountSummary(
    {
      securitiesAccount: { type: "CASH", currentBalances: { totalCash: 50, cashAvailableForTrading: 40 }, positions: [{}] },
      aggregatedBalance: { liquidationValue: 60 },
    },
    ACCT,
  );
  assert.deepEqual(cash, { accountId: ACCT.id, netLiq: 60, buyingPower: 40, cash: 50, currency: "USD" }, "nothing reported is left out, never 0");
  assert.deepEqual(schwabAccountSummary({}, ACCT), { accountId: ACCT.id, currency: "USD" });
});

test("positions: long, short, options (x100), funds; unrealized from the side's open P&L", () => {
  const long = schwabPosition(
    { longQuantity: 3, shortQuantity: 0, averagePrice: 10, marketValue: 33, longOpenProfitLoss: 3, currentDayProfitLoss: 1, instrument: { assetType: "EQUITY", symbol: "XYZ", cusip: "C1" } },
    ACCT,
  );
  assert.deepEqual(long, {
    id: `schwab:${ACCT.id}:EQUITY:C1`,
    accountId: ACCT.id,
    brokerId: "schwab",
    symbol: "XYZ",
    qty: 3,
    avgCost: 10,
    last: 11,
    marketValue: 33,
    unrealizedPnl: 3,
    dayPnl: 1,
    currency: "USD",
    secType: "STK",
  });
  const shortOpt = schwabPosition(
    { longQuantity: 0, shortQuantity: 1, averageShortPrice: 2, marketValue: -250, shortOpenProfitLoss: -50, instrument: { assetType: "OPTION", symbol: "QQQ   261218P00400000" } },
    ACCT,
  );
  assert.equal(shortOpt.qty, -1);
  assert.equal(shortOpt.last, 2.5);
  assert.equal(shortOpt.avgCost, 2);
  assert.equal(shortOpt.unrealizedPnl, -50);
  assert.equal(shortOpt.symbol, "QQQ 261218P00400000");
  assert.equal(shortOpt.dayPnl, undefined, "not sent, not 0");
  assert.equal(schwabPosition({ longQuantity: 1, instrument: { assetType: "MUTUAL_FUND", symbol: "SWPPX" } }, ACCT).secType, "FUND");
  assert.equal(schwabPosition({ longQuantity: 1, instrument: { assetType: "MUTUAL_FUND", symbol: "SWPPX" } }, ACCT).last, undefined, "no market value: no price, never 0");
  assert.deepEqual(
    ["EQUITY", "COLLECTIVE_INVESTMENT", "OPTION", "MUTUAL_FUND", "FIXED_INCOME", "CASH_EQUIVALENT", "", "NEW_THING"].map(schwabSecType),
    ["STK", "STK", "OPT", "FUND", "BOND", "CASH", "STK", "NEW_THING"],
  );
});

test("order status and times", () => {
  assert.deepEqual(
    ["WORKING", "QUEUED", "ACCEPTED", "PENDING_ACTIVATION", "AWAITING_PARENT_ORDER", "FILLED", "CANCELED", "EXPIRED", "REPLACED", "REJECTED", "NEW", "PENDING_CANCEL"].map(schwabOrderStatus),
    ["working", "working", "working", "working", "working", "filled", "cancelled", "cancelled", "cancelled", "rejected", "submitted", "working"],
  );
  assert.equal(schwabTime("2026-11-16T14:30:15+0000", NOW), "2026-11-16T14:30:15.000Z");
  assert.equal(schwabTime("2026-11-16T09:30:15-0500", NOW), "2026-11-16T14:30:15.000Z");
  assert.equal(schwabTime(undefined, NOW), new Date(NOW).toISOString());
  assert.equal(schwabTime("garbage", NOW), new Date(NOW).toISOString());
});

test("orders: one per leg, types, prices, trailing percent, fills, child orders and sessions", () => {
  const orders = schwabOrders(
    [
      {
        orderId: 1,
        orderType: "LIMIT",
        price: 10,
        duration: "GOOD_TILL_CANCEL",
        session: "AM",
        status: "WORKING",
        enteredTime: "2026-11-16T13:00:00+0000",
        orderLegCollection: [{ legId: 1, instruction: "BUY_TO_COVER", quantity: 5, instrument: { symbol: "ABC", assetType: "EQUITY" } }],
        filledQuantity: 2,
        orderActivityCollection: [{ activityType: "EXECUTION", activityId: 7, executionLegs: [{ legId: 1, quantity: 2, price: 9.95, time: "2026-11-16T13:00:01+0000" }] }],
      },
      {
        orderId: 2,
        orderType: "NET_DEBIT",
        price: 1.2,
        session: "NORMAL",
        status: "FILLED",
        orderStrategyType: "SINGLE",
        complexOrderStrategyType: "VERTICAL",
        orderLegCollection: [
          { legId: 1, instruction: "BUY_TO_OPEN", quantity: 1, instrument: { symbol: "SPY   261218C00600000", assetType: "OPTION" } },
          { legId: 2, instruction: "SELL_TO_OPEN", quantity: 1, instrument: { symbol: "SPY   261218C00610000", assetType: "OPTION" } },
        ],
        orderActivityCollection: [
          {
            activityType: "EXECUTION",
            executionLegs: [
              { legId: 1, quantity: 1, price: 3.0 },
              { legId: 2, quantity: 1, price: 1.8 },
            ],
          },
        ],
      },
      {
        orderStrategyType: "OCO",
        orderId: 3,
        status: "WORKING",
        childOrderStrategies: [
          { orderId: 4, orderType: "STOP_LIMIT", stopPrice: 90, price: 89, status: "WORKING", orderLegCollection: [{ instruction: "SELL", quantity: 5, instrument: { symbol: "ABC" } }] },
          { orderId: 5, orderType: "TRAILING_STOP", stopPriceLinkType: "VALUE", stopPriceOffset: 1, status: "WORKING", orderLegCollection: [{ instruction: "SELL", quantity: 5, instrument: { symbol: "ABC" } }] },
        ],
      },
      { orderId: 6, orderType: "MARKET_ON_CLOSE", status: "CANCELED", orderLegCollection: [{ instruction: "SELL_SHORT", quantity: 3, instrument: { symbol: "ZZZ" } }] },
      { orderType: "LIMIT", orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "NOID" } }] },
    ],
    ACCT,
    NOW,
  );
  const ids = orders.map((o) => o.id.replace(`schwab:${ACCT.id}:`, ""));
  const byId = Object.fromEntries(orders.map((o, i) => [ids[i], o]));
  assert.deepEqual(ids, ["1", "2:0", "2:1", "4", "5", "6"], "an OCO container without legs and an order without id are not orders");
  assert.deepEqual(
    (({ side, qty, type, price, tif, status, filledQty, avgFill, outsideRth, placedAt, clientId, brokerRef }) => ({ side, qty, type, price, tif, status, filledQty, avgFill, outsideRth, placedAt, clientId, brokerRef }))(byId["1"]),
    { side: "BUY", qty: 5, type: "LMT", price: 10, tif: "GTC", status: "working", filledQty: 2, avgFill: 9.95, outsideRth: true, placedAt: "2026-11-16T13:00:00.000Z", clientId: "schwab-1", brokerRef: "1" },
  );
  assert.equal(byId["2:0"].type, "LMT", "a net debit spread is a limit order");
  assert.equal(byId["2:0"].side, "BUY");
  assert.equal(byId["2:1"].side, "SELL");
  assert.equal(byId["2:1"].avgFill, 1.8, "fills per leg");
  assert.equal(byId["2:0"].placedAt, new Date(NOW).toISOString(), "no enteredTime: the read time");
  assert.equal(byId["4"].type, "STP");
  assert.equal(byId["4"].price, 90, "a stop-limit shows its stop");
  assert.equal(byId["4"].parentId, undefined, "the OCO container has no Order to point at");
  assert.equal(byId["5"].type, "TRAIL");
  assert.equal(byId["5"].trailPct, undefined, "a trailing amount in dollars is not a percent");
  assert.equal(byId["6"].type, "MKT");
  assert.equal(byId["6"].status, "cancelled");
  assert.equal(byId["6"].side, "SELL");
  assert.equal(byId["6"].outsideRth, undefined, "no session sent: not claimed either way");
});

test("executions: one per execution leg; fees from TRADE transactions spread by quantity, else provisional", () => {
  const orders = [
    {
      orderId: 10,
      orderLegCollection: [{ legId: 1, instruction: "SELL", instrument: { symbol: "ABC", assetType: "EQUITY" } }],
      orderActivityCollection: [
        {
          activityType: "EXECUTION",
          activityId: 100,
          executionLegs: [
            { legId: 1, quantity: 30, price: 10, time: "2026-11-16T14:00:00+0000" },
            { legId: 1, quantity: 70, price: 10.1, time: "2026-11-16T14:00:05+0000" },
          ],
        },
        { activityType: "ORDER_ACTION", activityId: 101 },
      ],
    },
    {
      orderId: 11,
      closeTime: "2026-11-16T14:10:00+0000",
      orderLegCollection: [{ legId: 1, instruction: "BUY_TO_OPEN", instrument: { symbol: "SPY   261218C00600000", assetType: "OPTION" } }],
      orderActivityCollection: [{ activityType: "EXECUTION", executionLegs: [{ legId: 1, quantity: 1, price: 2.5 }] }],
    },
    { orderId: 12, orderLegCollection: [{ instruction: "BUY", instrument: { symbol: "NOFILL" } }] },
  ];
  const transactions = [
    {
      type: "TRADE",
      orderId: 10,
      transferItems: [
        { feeType: "COMMISSION", cost: -1 },
        { feeType: "SEC_FEE", cost: -0.02 },
        { feeType: "TAF_FEE", cost: -0.01 },
        { instrument: { symbol: "ABC" }, amount: -100, cost: 1007, price: 10.07 },
      ],
    },
    { type: "TRADE", orderId: 10, transferItems: [{ feeType: "COMMISSION", cost: -0.97 }] },
    { type: "DIVIDEND_OR_INTEREST", orderId: 11, transferItems: [{ feeType: "COMMISSION", cost: -5 }] },
  ];
  assert.equal(schwabFeesByOrder(transactions).get("10"), 2);
  assert.equal(schwabFeesByOrder(transactions).has("11"), false, "only TRADE transactions");

  const fills = schwabExecutions(orders, transactions, ACCT, NOW);
  assert.equal(fills.length, 3);
  const [a, b, c] = fills;
  assert.deepEqual(
    { id: a.id, side: a.side, qty: a.qty, price: a.price, commission: a.commission, net: a.net, tradedAt: a.tradedAt, provisional: a.provisional },
    { id: `schwab:${ACCT.id}:10:100:1:0`, side: "SELL", qty: 30, price: 10, commission: 0.6, net: 299.4, tradedAt: "2026-11-16T14:00:00.000Z", provisional: undefined },
  );
  assert.equal(b.commission, 1.4);
  assert.equal(b.net, 705.6);
  assert.deepEqual({ symbol: c.symbol, side: c.side, net: c.net, provisional: c.provisional, tradedAt: c.tradedAt }, {
    symbol: "SPY 261218C00600000",
    side: "BUY",
    net: -250,
    provisional: true,
    tradedAt: "2026-11-16T14:10:00.000Z",
  });

  const noTransactions = schwabExecutions(orders, null, ACCT, NOW);
  assert.ok(noTransactions.every((f) => f.provisional === true && f.commission === 0), "the transactions call failed: provisional, never invented");
});

test("executions: fees go only to the fills already booked; a fill not booked yet stays provisional", () => {
  const order = {
    orderId: 42,
    status: "FILLED",
    orderLegCollection: [{ legId: 1, instruction: "BUY", quantity: 10, instrument: { assetType: "EQUITY", symbol: "AAPL" } }],
    orderActivityCollection: [
      // Listed later-first on purpose: booking follows the fill times, not the array.
      { activityType: "EXECUTION", activityId: 2, executionLegs: [{ legId: 1, quantity: 5, price: 101, time: "2026-11-11T14:30:00+0000" }] },
      { activityType: "EXECUTION", activityId: 1, executionLegs: [{ legId: 1, quantity: 5, price: 100, time: "2026-11-10T14:30:01+0000" }] },
    ],
  };
  const day1 = {
    type: "TRADE",
    activityId: 501,
    orderId: 42,
    transferItems: [
      { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: 0, cost: -1, feeType: "COMMISSION" },
      { instrument: { assetType: "EQUITY", symbol: "AAPL" }, amount: 5, cost: -500, price: 100 },
    ],
  };
  const [late, early] = schwabExecutions([order], [day1], ACCT, NOW);
  assert.deepEqual({ qty: early.qty, price: early.price, commission: early.commission, net: early.net, provisional: early.provisional }, {
    qty: 5,
    price: 100,
    commission: 1,
    net: -501,
    provisional: undefined,
  });
  assert.deepEqual({ price: late.price, commission: late.commission, provisional: late.provisional }, { price: 101, commission: 0, provisional: true });

  // The second day is booked: both fills final, each with its own day's fees.
  const day2 = { ...day1, activityId: 502, transferItems: [{ feeType: "COMMISSION", cost: -0.5 }, { instrument: { assetType: "EQUITY", symbol: "AAPL" }, amount: 5, cost: -505, price: 101 }] };
  const both = schwabExecutions([order], [day1, day2], ACCT, NOW);
  assert.ok(both.every((f) => f.provisional === undefined && f.commission === 0.75), "1.50 of booked fees over 10 booked shares");

  // Fees with no traded item to count: shared by every fill, none known to be booked in full.
  const feesOnly = schwabExecutions([order], [{ type: "TRADE", orderId: 42, transferItems: [{ feeType: "COMMISSION", cost: -1 }] }], ACCT, NOW);
  assert.ok(feesOnly.every((f) => f.provisional === true && f.commission === 0.5));
});

test("executions: a TRADE transaction of an order outside the 60-day order window is a fill of its own", () => {
  const listed = {
    orderId: 10,
    orderLegCollection: [{ legId: 1, instruction: "BUY", instrument: { symbol: "ABC", assetType: "EQUITY" } }],
    orderActivityCollection: [{ activityType: "EXECUTION", activityId: 1, executionLegs: [{ legId: 1, quantity: 1, price: 10, time: "2026-11-16T14:00:00+0000" }] }],
  };
  const transactions = [
    // The listed order: its fill comes from the execution legs, never twice.
    { type: "TRADE", activityId: 600, orderId: 10, transferItems: [{ instrument: { assetType: "EQUITY", symbol: "ABC" }, amount: 1, cost: -10, price: 10 }] },
    {
      type: "TRADE",
      activityId: 601,
      orderId: 77,
      time: "2026-11-12T15:00:00+0000",
      transferItems: [
        { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: 0, cost: -0.65, feeType: "COMMISSION" },
        { instrument: { assetType: "EQUITY", symbol: "MSFT" }, amount: 10, cost: -4000, price: 400, positionEffect: "OPENING" },
      ],
    },
    {
      type: "TRADE",
      orderId: 78,
      time: "2026-11-13T15:00:00+0000",
      transferItems: [
        { feeType: "OPT_REG_FEE", cost: -0.04 },
        { instrument: { assetType: "OPTION", symbol: "SPY   261218C00600000" }, amount: -2, cost: 700 },
      ],
    },
    { type: "TRADE", transferItems: [{ instrument: { assetType: "EQUITY", symbol: "NOID" }, amount: 1, cost: -1, price: 1 }] },
  ];
  const fills = schwabExecutions([listed], transactions, ACCT, NOW);
  assert.equal(fills.length, 3, "the listed order once, the two older orders, nothing without an id");
  const msft = /** @type {any} */ (fills.find((f) => f.symbol === "MSFT"));
  assert.deepEqual(msft, {
    id: `schwab:${ACCT.id}:77:tx601:0`,
    accountId: ACCT.id,
    brokerId: "schwab",
    symbol: "MSFT",
    side: "BUY",
    qty: 10,
    price: 400,
    commission: 0.65,
    net: -4000.65,
    tradedAt: "2026-11-12T15:00:00.000Z",
  });
  const spy = /** @type {any} */ (fills.find((f) => f.symbol.startsWith("SPY")));
  assert.deepEqual(
    { id: spy.id, side: spy.side, qty: spy.qty, price: spy.price, commission: spy.commission, net: spy.net, provisional: spy.provisional },
    { id: `schwab:${ACCT.id}:78:tx#0:0`, side: "SELL", qty: 2, price: 3.5, commission: 0.04, net: 699.96, provisional: undefined },
  );
  assert.deepEqual(schwabExecutions([listed], null, ACCT, NOW).length, 1, "no transactions read: only the listed fills");
});
