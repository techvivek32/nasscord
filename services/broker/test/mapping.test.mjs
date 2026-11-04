import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectionView,
  etradeAccountRows,
  etradeAccountSummary,
  etradeExecutions,
  etradeOrders,
  etradePosition,
  ibkrAccountRows,
  ibkrAccountSummary,
  ibkrExecution,
  ibkrOrder,
  ibkrPosition,
  maskAccountNumber,
  mapOrderType,
} from "../src/mapping.mjs";
import { etDateKey, etToUtc, nextMidnightEt } from "../src/time.mjs";

const acct = { id: "11111111-1111-4111-8111-111111111111", external_id: "U1234567" };
const T = Date.parse("2026-11-03T15:00:00Z");

test("account numbers are masked", () => {
  assert.equal(maskAccountNumber("U1234567"), "U12•••67");
  assert.equal(maskAccountNumber("84012345"), "840•••45");
  assert.equal(maskAccountNumber("123"), "•••23");
});

test("midnight Eastern, across both DST changes", () => {
  assert.equal(new Date(nextMidnightEt(Date.parse("2026-11-03T13:00:00Z"))).toISOString(), "2026-11-04T05:00:00.000Z");
  // 23:59 ET on Nov 3 (EST) is 04:59Z on Nov 4: midnight is a minute away
  assert.equal(new Date(nextMidnightEt(Date.parse("2026-11-04T04:59:00Z"))).toISOString(), "2026-11-04T05:00:00.000Z");
  // exactly midnight: the next one, a day later
  assert.equal(new Date(nextMidnightEt(Date.parse("2026-11-04T05:00:00Z"))).toISOString(), "2026-11-05T05:00:00.000Z");
  // summer (EDT, UTC-4)
  assert.equal(new Date(nextMidnightEt(Date.parse("2026-07-01T12:00:00Z"))).toISOString(), "2026-07-02T04:00:00.000Z");
  // the day DST ends (2026-11-01): the next midnight is already EST
  assert.equal(new Date(nextMidnightEt(Date.parse("2026-11-01T12:00:00Z"))).toISOString(), "2026-11-02T05:00:00.000Z");
  // the day before DST starts (2027-03-14): midnight of the 14th is still EST
  assert.equal(new Date(nextMidnightEt(Date.parse("2027-03-13T18:00:00Z"))).toISOString(), "2027-03-14T05:00:00.000Z");
  assert.equal(new Date(nextMidnightEt(Date.parse("2027-03-14T12:00:00Z"))).toISOString(), "2027-03-15T04:00:00.000Z");
  assert.equal(etDateKey(Date.parse("2026-11-04T04:30:00Z")), "2026-11-03");
  assert.equal(new Date(etToUtc(2026, 12, 31, 9, 30)).toISOString(), "2026-12-31T14:30:00.000Z");
});

test("connection view has the contract's fields", () => {
  const v = connectionView(
    /** @type {any} */ ({
      id: "c1",
      broker_id: "ibkr",
      method: "ibkr_gateway",
      environment: "paper",
      status: "active",
      status_detail: null,
      session_expires_at: "2026-11-04T05:00:00+00:00",
      last_ok_at: null,
    }),
    /** @type {any} */ ([
      { id: "a1", connection_id: "c1", label: "Main", display_number: "DU1•••67", type: "paper", included: true },
      { id: "a2", connection_id: "other", label: "x", display_number: "x", type: "paper", included: true },
    ]),
  );
  assert.deepEqual(v, {
    id: "c1",
    brokerId: "ibkr",
    method: "ibkr_gateway",
    environment: "paper",
    status: "active",
    statusDetail: null,
    sessionExpiresAt: "2026-11-04T05:00:00.000Z",
    lastOkAt: null,
    accounts: [{ id: "a1", label: "Main", displayNumber: "DU1•••67", type: "paper", included: true }],
  });
});

test("IBKR accounts: types, labels, paper detection, iserver fallback", () => {
  const rows = ibkrAccountRows(
    {
      portfolioAccounts: [
        { id: "U1234567", accountId: "U1234567", accountAlias: null, desc: "U1234567", type: "INDIVIDUAL", tradingType: "STKMRGN" },
        { id: "U7654321", accountId: "U7654321", accountAlias: "Roth", desc: "U7654321", type: "IRA ROTH" },
      ],
      iserverAccounts: { accounts: ["U1234567", "U7654321", "DU9999999"], aliases: { DU9999999: "Sim" } },
    },
    { id: "c", workspace_id: "w", environment: "production" },
  );
  assert.deepEqual(
    rows.map((r) => [r.external_id, r.type, r.label, r.display_number]),
    [
      ["U1234567", "margin", "IBKR Margin", "U12•••67"],
      ["U7654321", "roth", "Roth", "U76•••21"],
      ["DU9999999", "paper", "Sim", "DU9•••99"],
    ],
  );
});

test("IBKR summary, positions, orders, executions", () => {
  const s = ibkrAccountSummary(
    { netliquidation: { amount: 105234.567, currency: "USD" }, buyingpower: { amount: 400000 }, totalcashvalue: { amount: 25000.1 } },
    { upnl: { "U1234567.Core": { dpl: -321.456 } } },
    acct,
  );
  assert.deepEqual(s, { accountId: acct.id, netLiq: 105234.57, buyingPower: 400000, cash: 25000.1, dayPnl: -321.46, currency: "USD" });

  // pnl/partitioned failed (null) and the summary lacks cash: those values are left out, never sent as 0
  assert.deepEqual(ibkrAccountSummary({ netliquidation: { amount: 50000, currency: "CAD" }, buyingpower: { amount: 0 } }, null, acct), {
    accountId: acct.id,
    netLiq: 50000,
    buyingPower: 0,
    currency: "CAD",
  });
  assert.deepEqual(ibkrAccountSummary({}, { upnl: { "U7654321.Core": { dpl: 5 } } }, acct), { accountId: acct.id, currency: "USD" });
  assert.equal(ibkrAccountSummary({}, { upnl: { "U1234567.Core": { dpl: 0 } } }, acct).dayPnl, 0);

  const p = ibkrPosition(
    { conid: 265598, ticker: "AAPL", contractDesc: "AAPL", position: 10, mktPrice: 230.5, mktValue: 2305, avgCost: 200, avgPrice: 200, unrealizedPnl: 305, currency: "USD", assetClass: "STK" },
    acct,
  );
  assert.deepEqual(p, {
    id: `ibkr:${acct.id}:265598`,
    accountId: acct.id,
    brokerId: "ibkr",
    symbol: "AAPL",
    qty: 10,
    avgCost: 200,
    last: 230.5,
    marketValue: 2305,
    unrealizedPnl: 305,
    currency: "USD",
    secType: "STK",
  });
  assert.equal(p.dayPnl, undefined, "IBKR sent no day P&L for the position: left out, not 0");
  assert.equal(ibkrPosition({ conid: 2, ticker: "MSFT", position: 1, dailyPnl: 0 }, acct).dayPnl, 0, "a reported 0 stays 0");
  assert.equal(ibkrPosition({ conid: 3, ticker: "NVDA", position: 1, dailyPnL: -12.3 }, acct).dayPnl, -12.3);
  const opt = ibkrPosition({ conid: 1, ticker: "AAPL", contractDesc: "AAPL JAN2027 250 C [AAPL  270115C00250000 100]", position: -2, avgCost: 1250, avgPrice: 12.5, assetClass: "OPT" }, acct);
  assert.equal(opt.symbol, "AAPL JAN2027 250 C [AAPL  270115C00250000 100]");
  assert.equal(opt.avgCost, 12.5);
  assert.equal(opt.qty, -2);

  const o = ibkrOrder(
    { acct: "U1234567", orderId: 1290035, ticker: "AVGO", side: "SELL", totalSize: 12, filledQuantity: 0, orderType: "Stop", price: "", auxPrice: "168.5", timeInForce: "GTC", status: "Submitted", lastExecutionTime_r: Date.parse("2026-11-03T14:30:00Z"), parentId: 1290034 },
    acct,
    T,
  );
  assert.equal(o.type, "STP");
  assert.equal(o.price, 168.5);
  assert.equal(o.status, "working");
  assert.equal(o.tif, "GTC");
  assert.equal(o.placedAt, "2026-11-03T14:30:00.000Z");
  assert.equal(o.parentId, `ibkr:${acct.id}:1290034`);
  assert.equal(o.clientId, "ibkr-1290035");
  assert.equal(ibkrOrder({ orderId: 1, status: "Inactive", orderType: "LMT", price: 1, side: "B", lastExecutionTime: "261103143000" }, acct, T).status, "rejected");
  assert.equal(ibkrOrder({ orderId: 1, status: "Inactive", orderType: "LMT", price: 1, side: "B", lastExecutionTime: "261103143000" }, acct, T).placedAt, "2026-11-03T14:30:00.000Z");
  assert.equal(ibkrOrder({ orderId: 2, status: "PendingSubmit", orderType: "MKT", side: "BUY" }, acct, T).status, "submitted");

  const buy = ibkrExecution({ execution_id: "0000e0d5.1", symbol: "AVGO", side: "B", size: 12, price: "172.77", commission: "1.00", net_amount: 2073.24, account: "U1234567", trade_time_r: Date.parse("2026-09-30T16:46:33Z") }, acct, T);
  assert.deepEqual(buy, { id: `ibkr:${acct.id}:0000e0d5.1`, accountId: acct.id, brokerId: "ibkr", symbol: "AVGO", side: "BUY", qty: 12, price: 172.77, commission: 1, net: -2074.24, tradedAt: "2026-09-30T16:46:33.000Z" });
  const sell = ibkrExecution({ execution_id: "x", symbol: "MSFT", side: "S", size: 15, price: 430.83, commission: 0, trade_time: "20260929-19:28:00" }, acct, T);
  assert.equal(sell.net, 6462.45);
  assert.equal(sell.tradedAt, "2026-09-29T19:28:00.000Z");
});

test("order types map onto Nasscord's five", () => {
  assert.equal(mapOrderType("MARKET", false), "MKT");
  assert.equal(mapOrderType("Limit", true), "LMT");
  assert.equal(mapOrderType("STOP_LIMIT", true), "STP");
  assert.equal(mapOrderType("TRAILING_STOP_PRCT", false), "TRAIL");
  assert.equal(mapOrderType("MIT", true), "MIT");
  assert.equal(mapOrderType("weird", true), "LMT");
});

const ETRADE_LIST = {
  AccountListResponse: {
    Accounts: {
      Account: [
        { accountId: "84012345", accountIdKey: "dBZOKt9xDrtRSAOl4MSiiA", accountMode: "MARGIN", accountDesc: "Brokerage", accountType: "INDIVIDUAL", institutionType: "BROKERAGE", accountStatus: "ACTIVE" },
        { accountId: "84099999", accountIdKey: "closedKey", accountDesc: "Old", accountStatus: "CLOSED" },
        { accountId: "84055555", accountIdKey: "rothKey", accountMode: "CASH", accountDesc: "", accountName: "", accountType: "ROTHIRA", accountStatus: "ACTIVE" },
      ],
    },
  },
};

test("E*TRADE accounts, balance, positions", () => {
  const rows = etradeAccountRows(ETRADE_LIST, { id: "c", workspace_id: "w" });
  assert.deepEqual(rows.map((r) => [r.external_id, r.display_number, r.type, r.label]), [
    ["dBZOKt9xDrtRSAOl4MSiiA", "840•••45", "margin", "Brokerage"],
    ["rothKey", "840•••55", "roth", "E*TRADE Roth IRA"],
  ]);

  const sum = etradeAccountSummary(
    { BalanceResponse: { accountMode: "MARGIN", Computed: { marginBuyingPower: 50000, cashBuyingPower: 25000, cashBalance: 12345.678, RealTimeValues: { totalAccountValue: 98765.43 } } } },
    { todaysGainLoss: 210.5 },
    acct,
  );
  assert.deepEqual(sum, { accountId: acct.id, netLiq: 98765.43, buyingPower: 50000, cash: 12345.68, dayPnl: 210.5, currency: "USD" });
  // no portfolio totals (no positions, or the call failed) and no balance answer: nothing is reported
  assert.deepEqual(etradeAccountSummary(null, null, acct), { accountId: acct.id, currency: "USD" });

  const pos = etradePosition(
    { positionId: 140357348131, symbolDescription: "MSFT", quantity: 15, positionType: "LONG", daysGain: 33.45, marketValue: 6462.45, totalGain: 33.45, costPerShare: 428.6, Quick: { lastTrade: 430.83 }, Product: { symbol: "MSFT", securityType: "EQ" } },
    acct,
  );
  assert.deepEqual(pos, { id: `etrade:${acct.id}:140357348131`, accountId: acct.id, brokerId: "etrade", symbol: "MSFT", qty: 15, avgCost: 428.6, last: 430.83, dayPnl: 33.45, marketValue: 6462.45, unrealizedPnl: 33.45, currency: "USD", secType: "STK" });
  assert.equal(etradePosition({ quantity: 5, positionType: "SHORT", Product: { symbol: "X", securityType: "EQ" } }, acct).qty, -5);
});

test("E*TRADE orders and the executions derived from them", () => {
  const resp = {
    OrdersResponse: {
      Order: [
        {
          orderId: 482,
          OrderDetail: [
            {
              placedTime: Date.parse("2026-11-03T14:31:00Z"),
              executedTime: Date.parse("2026-11-03T14:31:02Z"),
              status: "EXECUTED",
              orderTerm: "GOOD_FOR_DAY",
              priceType: "LIMIT",
              limitPrice: 121.4,
              marketSession: "REGULAR",
              Instrument: [{ Product: { symbol: "NVDA", securityType: "EQ" }, orderAction: "BUY", orderedQuantity: 38, filledQuantity: 38, averageExecutionPrice: 121.38, estimatedCommission: 0 }],
            },
          ],
        },
        {
          orderId: 483,
          OrderDetail: {
            placedTime: Date.parse("2026-11-03T14:32:00Z"),
            status: "OPEN",
            orderTerm: "GOOD_UNTIL_CANCEL",
            priceType: "TRAILING_STOP_PRCT",
            offsetValue: 2.5,
            marketSession: "EXTENDED",
            Instrument: { Product: { symbol: "NVDA", securityType: "EQ" }, orderAction: "SELL", orderedQuantity: 38 },
          },
        },
      ],
    },
  };
  const orders = etradeOrders(resp, acct, T);
  assert.equal(orders.length, 2);
  assert.deepEqual(
    orders.map((o) => [o.brokerRef, o.side, o.type, o.price, o.trailPct, o.tif, o.status, o.outsideRth]),
    [
      ["482", "BUY", "LMT", 121.4, undefined, "DAY", "filled", false],
      ["483", "SELL", "TRAIL", undefined, 2.5, "GTC", "working", true],
    ],
  );
  const ex = etradeExecutions(resp, acct, T);
  assert.equal(ex.length, 1);
  assert.deepEqual(ex[0], { id: `etrade:${acct.id}:482`, accountId: acct.id, brokerId: "etrade", symbol: "NVDA", side: "BUY", qty: 38, price: 121.38, commission: 0, net: -4612.44, tradedAt: "2026-11-03T14:31:02.000Z", provisional: true });
  assert.deepEqual(etradeOrders(null, acct, T), []);
});
