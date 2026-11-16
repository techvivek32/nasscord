import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alpacaAccountRow,
  alpacaAccountSummary,
  alpacaAccountType,
  alpacaExecution,
  alpacaExecutions,
  alpacaOrder,
  alpacaOrders,
  alpacaOrderStatus,
  alpacaOrderType,
  alpacaPosition,
  alpacaSecType,
  isAccountClosed,
} from "../src/alpaca/mapping.mjs";

// Recorded-style payloads: the field names and string encoding of Alpaca's Trading API v2 docs.
const ACCOUNT = {
  id: "904837e3-3b76-47ec-b432-046db621571b",
  account_number: "010203ABCD",
  status: "ACTIVE",
  crypto_status: "ACTIVE",
  currency: "USD",
  buying_power: "262113.632",
  regt_buying_power: "262113.632",
  non_marginable_buying_power: "131056.82",
  cash: "-23140.2",
  portfolio_value: "103820.56",
  equity: "103820.56",
  last_equity: "102716.42",
  long_market_value: "126960.76",
  short_market_value: "0",
  multiplier: "4",
  pattern_day_trader: false,
  trading_blocked: false,
  created_at: "2019-06-12T22:47:07.99658Z",
};
const acct = { id: "acc-uuid-1" };
const T0 = Date.parse("2026-11-16T15:00:00.000Z");

test("account: type, row, summary and the closed check", () => {
  assert.equal(alpacaAccountType(ACCOUNT, "production"), "margin");
  assert.equal(alpacaAccountType({ ...ACCOUNT, multiplier: "1" }, "production"), "individual");
  assert.equal(alpacaAccountType({ ...ACCOUNT, multiplier: "4" }, "paper"), "paper", "the paper host is always Paper");
  assert.equal(alpacaAccountType({ ...ACCOUNT, status: "PAPER_ONLY", multiplier: "1" }, "production"), "paper");

  assert.deepEqual(alpacaAccountRow(ACCOUNT, "production"), {
    broker_id: "alpaca",
    external_id: ACCOUNT.id,
    display_number: "010•••CD",
    label: "Alpaca Margin",
    type: "margin",
  });
  assert.equal(alpacaAccountRow({ ...ACCOUNT, account_number: "PA3XYZ12QW" }, "paper").label, "Alpaca Paper");
  assert.equal(alpacaAccountRow({ id: "abcdef-123" }, "production").display_number, "abc•••23", "falls back to the id");

  assert.deepEqual(alpacaAccountSummary(ACCOUNT, acct), {
    accountId: "acc-uuid-1",
    netLiq: 103820.56,
    buyingPower: 262113.63,
    cash: -23140.2,
    dayPnl: 1104.14,
    currency: "USD",
  });
  const partial = alpacaAccountSummary({ id: "x", cash: "12.5" }, acct);
  assert.deepEqual(partial, { accountId: "acc-uuid-1", cash: 12.5, currency: "USD" }, "values Alpaca did not send are left out, never 0");
  assert.equal(alpacaAccountSummary({ equity: "100", currency: "" }, acct).dayPnl, undefined, "no day P&L without last_equity");

  assert.equal(isAccountClosed({ status: "ACCOUNT_CLOSED" }), true);
  assert.equal(isAccountClosed(ACCOUNT), false);
});

test("positions: strings, shorts, options and crypto", () => {
  const stock = alpacaPosition(
    {
      asset_id: "904837e3-3b76-47ec-b432-046db621571b",
      symbol: "AAPL",
      exchange: "NASDAQ",
      asset_class: "us_equity",
      avg_entry_price: "100.0",
      qty: "5",
      side: "long",
      market_value: "600.0",
      cost_basis: "500.0",
      unrealized_pl: "100.0",
      unrealized_plpc: "0.20",
      unrealized_intraday_pl: "10.0",
      current_price: "120.0",
      lastday_price: "118.0",
      change_today: "0.0169",
    },
    acct,
  );
  assert.deepEqual(stock, {
    id: "alpaca:acc-uuid-1:904837e3-3b76-47ec-b432-046db621571b",
    accountId: "acc-uuid-1",
    brokerId: "alpaca",
    symbol: "AAPL",
    qty: 5,
    avgCost: 100,
    last: 120,
    currency: "USD",
    secType: "STK",
    marketValue: 600,
    unrealizedPnl: 100,
    dayPnl: 10,
  });

  const short = alpacaPosition({ asset_id: "s1", symbol: "TSLA", asset_class: "us_equity", qty: "-3", side: "short", avg_entry_price: "250", current_price: "240", market_value: "-720", unrealized_pl: "30" }, acct);
  assert.equal(short.qty, -3);
  assert.equal(short.marketValue, -720);
  assert.equal(alpacaPosition({ symbol: "TSLA", qty: "3", side: "short", current_price: "1" }, acct).qty, -3, "a short is negative even if Alpaca sent a positive qty");

  const option = alpacaPosition({ asset_id: "o1", symbol: "AAPL240119C00190000", asset_class: "us_option", qty: "2", side: "long", avg_entry_price: "1.25", current_price: "1.5", market_value: "300" }, acct);
  assert.equal(option.secType, "OPT");
  assert.equal(option.unrealizedPnl, undefined, "not reported, left out");
  assert.equal(option.dayPnl, undefined);

  const crypto = alpacaPosition({ asset_id: "c1", symbol: "BTCUSD", asset_class: "crypto", qty: "0.0123", side: "long", avg_entry_price: "60000", current_price: "65000.5" }, acct);
  assert.equal(crypto.secType, "CRYPTO");
  assert.equal(crypto.qty, 0.0123);

  assert.equal(alpacaSecType(undefined, "SPY250321P00500000"), "OPT");
  assert.equal(alpacaSecType("", "ETH/USD"), "CRYPTO");
  assert.equal(alpacaSecType(null, "MSFT"), "STK");
  assert.equal(alpacaSecType("us_future", "X"), "US_FUTURE", "an unknown class is passed on, not guessed");
});

test("orders: types, statuses, prices and legs", () => {
  for (const [raw, want] of /** @type {const} */ ([
    ["market", "MKT"],
    ["limit", "LMT"],
    ["stop", "STP"],
    ["stop_limit", "STP"],
    ["trailing_stop", "TRAIL"],
    ["", "MKT"],
  ])) {
    assert.equal(alpacaOrderType(raw), want, raw);
  }
  for (const [raw, want] of /** @type {const} */ ([
    ["new", "submitted"],
    ["accepted", "submitted"],
    ["pending_new", "submitted"],
    ["partially_filled", "working"],
    ["held", "working"],
    ["accepted_for_bidding", "working"],
    ["filled", "filled"],
    ["canceled", "cancelled"],
    ["expired", "cancelled"],
    ["done_for_day", "cancelled"],
    ["replaced", "cancelled"],
    ["pending_cancel", "cancelled"],
    ["rejected", "rejected"],
    ["something_new", "working"],
  ])) {
    assert.equal(alpacaOrderStatus(raw), want, raw);
  }

  const limit = alpacaOrder(
    {
      id: "61e69015-8549-4bfd-b9c3-01e75843f47d",
      client_order_id: "eb9e2aaa-f71a-4f51-b5b4-52a6c565dad4",
      created_at: "2021-03-16T18:38:01.942282Z",
      submitted_at: "2021-03-16T18:38:01.937734Z",
      filled_at: null,
      symbol: "AAPL",
      asset_class: "us_equity",
      qty: "100",
      filled_qty: "40",
      filled_avg_price: "129.5",
      order_class: "",
      order_type: "limit",
      type: "limit",
      side: "buy",
      time_in_force: "gtc",
      limit_price: "130.00",
      stop_price: null,
      status: "partially_filled",
      extended_hours: true,
      legs: null,
    },
    acct,
    T0,
  );
  assert.deepEqual(limit, {
    id: "alpaca:acc-uuid-1:61e69015-8549-4bfd-b9c3-01e75843f47d",
    clientId: "eb9e2aaa-f71a-4f51-b5b4-52a6c565dad4",
    accountId: "acc-uuid-1",
    brokerId: "alpaca",
    symbol: "AAPL",
    side: "BUY",
    qty: 100,
    type: "LMT",
    tif: "GTC",
    status: "working",
    placedAt: "2021-03-16T18:38:01.937Z",
    brokerRef: "61e69015-8549-4bfd-b9c3-01e75843f47d",
    price: 130,
    filledQty: 40,
    avgFill: 129.5,
    outsideRth: true,
  });

  const stopLimit = alpacaOrder({ id: "s1", symbol: "MSFT", type: "stop_limit", side: "sell", qty: "1", time_in_force: "day", stop_price: "300", limit_price: "299", status: "new", submitted_at: "2026-11-10T14:00:00Z" }, acct, T0);
  assert.equal(stopLimit.type, "STP");
  assert.equal(stopLimit.price, 300, "a stop order shows its stop price");
  assert.equal(stopLimit.tif, "DAY");
  assert.equal(stopLimit.side, "SELL");

  const trail = alpacaOrder({ id: "t1", symbol: "SPY", type: "trailing_stop", side: "sell", qty: "2", trail_percent: "1.5", status: "new" }, acct, T0);
  assert.equal(trail.type, "TRAIL");
  assert.equal(trail.trailPct, 1.5);
  assert.equal(trail.price, undefined);
  assert.equal(trail.placedAt, new Date(T0).toISOString(), "no time from Alpaca: the fetch time");

  const notional = alpacaOrder({ id: "n1", symbol: "AAPL", type: "market", side: "buy", qty: null, notional: "500", filled_qty: "0", status: "accepted" }, acct, T0);
  assert.equal(notional.qty, 0);
  assert.equal(notional.status, "submitted");
  assert.equal(notional.clientId, "alpaca-n1");

  const bracket = {
    id: "p1",
    client_order_id: "c-p1",
    symbol: "NVDA",
    type: "market",
    order_class: "bracket",
    side: "buy",
    qty: "10",
    filled_qty: "10",
    filled_avg_price: "120.1",
    time_in_force: "gtc",
    status: "filled",
    submitted_at: "2026-11-15T15:00:00Z",
    legs: [
      { id: "l1", symbol: "NVDA", type: "limit", side: "sell", qty: "10", limit_price: "130", time_in_force: "gtc", status: "new", submitted_at: "2026-11-15T15:00:00Z" },
      { id: "l2", symbol: "NVDA", type: "stop", side: "sell", qty: "10", stop_price: "115", time_in_force: "gtc", status: "held", submitted_at: "2026-11-15T15:00:00Z" },
    ],
  };
  // The open-orders call can send a leg on its own as well: it is kept once, with its parent.
  const list = alpacaOrders([{ ...bracket.legs[0], legs: null }, bracket, bracket, { client_order_id: "no-id" }], acct, T0);
  assert.equal(list.length, 3);
  const leg = list.find((o) => o.brokerRef === "l1");
  assert.equal(leg?.parentId, "alpaca:acc-uuid-1:p1");
  assert.equal(list.find((o) => o.brokerRef === "l2")?.status, "working");
  assert.equal(list.find((o) => o.brokerRef === "l2")?.price, 115);
  assert.deepEqual(alpacaOrders(/** @type {any} */ (null), acct, T0), []);
});

test("executions: fills and partial fills, options, unknown activity types", () => {
  const fill = {
    id: "20220202135509981::2d7be4ff-d1f0-4c3b-8d7b-3b8a2ca9a6e4",
    activity_type: "FILL",
    transaction_time: "2022-02-02T18:55:09.981482Z",
    type: "fill",
    price: "174.78",
    qty: "2",
    side: "sell",
    symbol: "AAPL",
    leaves_qty: "0",
    order_id: "b5abe576-6a8a-49f3-a353-46b72c1ccae9",
    cum_qty: "2",
    order_status: "filled",
  };
  assert.deepEqual(alpacaExecution(fill, acct, T0), {
    id: "alpaca:acc-uuid-1:20220202135509981::2d7be4ff-d1f0-4c3b-8d7b-3b8a2ca9a6e4",
    accountId: "acc-uuid-1",
    brokerId: "alpaca",
    symbol: "AAPL",
    side: "SELL",
    qty: 2,
    price: 174.78,
    commission: 0,
    net: 349.56,
    tradedAt: "2022-02-02T18:55:09.981Z",
    provisional: true,
  });
  const partial = alpacaExecution({ ...fill, id: "p-1", type: "partial_fill", side: "buy", qty: "1", leaves_qty: "1", cum_qty: "1" }, acct, T0);
  assert.equal(partial?.qty, 1);
  assert.equal(partial?.net, -174.78, "a buy costs money");
  const option = alpacaExecution({ ...fill, id: "o-1", symbol: "AAPL240119C00190000", side: "buy", qty: "3", price: "1.25" }, acct, T0);
  assert.equal(option?.net, -375, "an option contract is 100 shares");
  const short = alpacaExecution({ ...fill, id: "ss-1", side: "sell_short" }, acct, T0);
  assert.equal(short?.side, "SELL");

  assert.equal(alpacaExecution({ ...fill, activity_type: "DIV" }, acct, T0), null);
  assert.equal(alpacaExecution({ ...fill, qty: "0" }, acct, T0), null);
  assert.equal(alpacaExecution({ ...fill, id: "" }, acct, T0), null);
  const all = alpacaExecutions([fill, { activity_type: "VOF", id: "v1" }, { ...fill, id: "f2" }], acct, T0);
  assert.equal(all.length, 2, "unknown activity types are skipped, not fatal");
  assert.deepEqual(alpacaExecutions(/** @type {any} */ (undefined), acct, T0), []);
});
