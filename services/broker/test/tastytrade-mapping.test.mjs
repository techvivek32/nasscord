import assert from "node:assert/strict";
import { test } from "node:test";
import { paged } from "../src/tastytrade/client.mjs";
import {
  itemsOf,
  mergeOrders,
  signed,
  tastytradeAccountRows,
  tastytradeAccountsRef,
  tastytradeAccountSummary,
  tastytradeAccountType,
  tastytradeCustomerRef,
  tastytradeExecutions,
  tastytradeOrders,
  tastytradeOrderStatus,
  tastytradeOrderType,
  tastytradePosition,
  tastytradeSecType,
  tastytradeSymbol,
  tastytradeTokenError,
} from "../src/tastytrade/mapping.mjs";

const ACCOUNT = { id: "acc-uuid-1" };
const NOW = Date.parse("2026-11-16T15:00:00Z");

test("accounts: closed ones left out, nickname or type as the label, Roth before IRA, masked numbers", () => {
  const rows = tastytradeAccountRows([
    { account: { "account-number": "5WT00001", "account-type-name": "Individual", nickname: "Main", "margin-or-cash": "Margin", "is-closed": false }, "authority-level": "owner" },
    { account: { "account-number": "5WT00002", "account-type-name": "Roth IRA", nickname: "", "margin-or-cash": "Cash" }, "authority-level": "owner" },
    { account: { "account-number": "5WT00003", "account-type-name": "Traditional IRA", "margin-or-cash": "Margin" }, "authority-level": "read-only" },
    { account: { "account-number": "5WT00004", "account-type-name": "Individual", "margin-or-cash": "Cash" }, "authority-level": "trade-only" },
    { account: { "account-number": "5WT00009", "account-type-name": "Individual", "is-closed": true } },
    { account: { "account-number": "5WT00001", "account-type-name": "Individual" } },
    { account: {} },
    null,
  ]);
  assert.deepEqual(rows, [
    { broker_id: "tastytrade", external_id: "5WT00001", display_number: "5WT•••01", label: "Main", type: "margin" },
    { broker_id: "tastytrade", external_id: "5WT00002", display_number: "5WT•••02", label: "Roth IRA", type: "roth" },
    { broker_id: "tastytrade", external_id: "5WT00003", display_number: "5WT•••03", label: "Traditional IRA", type: "ira" },
    { broker_id: "tastytrade", external_id: "5WT00004", display_number: "5WT•••04", label: "Individual", type: "individual" },
  ]);
  assert.equal(tastytradeAccountType({ "account-type-name": "SEP IRA" }), "ira");
  assert.equal(tastytradeAccountType({ "account-type-name": "Beneficiary Roth IRA" }), "roth");
  assert.equal(tastytradeAccountType({ "account-type-name": "Entity", "margin-or-cash": "Margin" }), "margin");
  assert.deepEqual(tastytradeAccountRows(undefined), []);
});

test("login identity: the customer reference, never the 'me' id; a hash of the accounts as a fallback", () => {
  assert.equal(tastytradeCustomerRef({ id: "me", "external-id": "C0000037211", "first-name": "Pat" }), "cust:C0000037211");
  assert.equal(tastytradeCustomerRef({ id: "me" }), null, "the API answers 'me' as the id, which names nobody");
  assert.equal(tastytradeCustomerRef({ "external-id": "has space" }), null);
  assert.equal(tastytradeCustomerRef(null), null);
  const a = tastytradeAccountsRef(["5WT00002", "5WT00001"]);
  assert.match(String(a), /^h:[0-9a-f]{64}$/);
  assert.equal(tastytradeAccountsRef(["5WT00001", "5WT00002", "5WT00001"]), a, "order and duplicates do not change it");
  assert.ok(!String(a).includes("5WT"), "never the numbers themselves");
  assert.equal(tastytradeAccountsRef([]), null);
});

test("balances: net liq, cash and equity buying power; no day P&L; missing values left out", () => {
  assert.deepEqual(
    tastytradeAccountSummary({ "net-liquidating-value": "25340.504", "cash-balance": "-12.10", "equity-buying-power": "40000.00", currency: "usd" }, ACCOUNT),
    { accountId: ACCOUNT.id, netLiq: 25_340.5, buyingPower: 40_000, cash: -12.1, currency: "USD" },
  );
  assert.deepEqual(tastytradeAccountSummary({}, ACCOUNT), { accountId: ACCOUNT.id, currency: "USD" }, "nothing invented");
});

test("positions: signed by direction, valued with the mark and the multiplier; no mark -> close, no day P&L", () => {
  const opt = tastytradePosition(
    {
      symbol: "SPY   261218C00600000",
      "instrument-type": "Equity Option",
      quantity: "2",
      "quantity-direction": "Short",
      "average-open-price": "3.10",
      "close-price": "3.30",
      "average-daily-market-close-price": "3.30",
      "mark-price": "3.50",
      multiplier: 100,
    },
    ACCOUNT,
  );
  assert.deepEqual(opt, {
    id: `tastytrade:${ACCOUNT.id}:SPY 261218C00600000`,
    accountId: ACCOUNT.id,
    brokerId: "tastytrade",
    symbol: "SPY 261218C00600000",
    qty: -2,
    avgCost: 3.1,
    last: 3.5,
    currency: "USD",
    secType: "OPT",
    marketValue: -700,
    unrealizedPnl: -80,
    dayPnl: -40,
  });
  const future = tastytradePosition(
    { symbol: "/ESZ6", "instrument-type": "Future", quantity: "1", "quantity-direction": "Long", "average-open-price": "6000", "close-price": "6010", mark: "6020", multiplier: 50 },
    ACCOUNT,
  );
  assert.deepEqual([future.marketValue, future.unrealizedPnl, future.dayPnl, future.secType], [301_000, 1_000, 500, "FUT"], "the day base falls back to the close");
  const noMark = tastytradePosition({ symbol: "VTI", "instrument-type": "Equity", quantity: "5", "quantity-direction": "Long", "average-open-price": "250", "close-price": "260" }, ACCOUNT);
  assert.equal(noMark.last, 260);
  assert.equal(noMark.marketValue, 1_300);
  assert.equal(noMark.unrealizedPnl, 50);
  assert.equal(noMark.dayPnl, undefined, "no day P&L without a current price");
  const nothing = tastytradePosition({ symbol: "X", quantity: "1", "quantity-direction": "Long" }, ACCOUNT);
  assert.deepEqual([nothing.last, nothing.avgCost, nothing.marketValue, nothing.unrealizedPnl], [undefined, undefined, undefined, undefined], "no price or cost: no invented value");
  assert.equal(tastytradeSecType("Future Option"), "FOP");
  assert.equal(tastytradeSecType("Cryptocurrency"), "CRYPTO");
  assert.equal(tastytradeSecType("Equity"), "STK");
  assert.equal(tastytradeSymbol("  SPY   261218C00600000 "), "SPY 261218C00600000");
});

test("order types and statuses", () => {
  assert.equal(tastytradeOrderType("Limit", true), "LMT");
  assert.equal(tastytradeOrderType("Marketable Limit", true), "LMT");
  assert.equal(tastytradeOrderType("Market", false), "MKT");
  assert.equal(tastytradeOrderType("Notional Market", false), "MKT");
  assert.equal(tastytradeOrderType("Stop", true), "STP");
  assert.equal(tastytradeOrderType("Stop Limit", true), "STP");
  assert.equal(tastytradeOrderType("Something New", true), "LMT");
  for (const s of ["Received", "Routed", "In Flight", "Live", "Cancel Requested", "Replace Requested", "Contingent"]) assert.equal(tastytradeOrderStatus(s), "working", s);
  assert.equal(tastytradeOrderStatus("Filled"), "filled");
  for (const s of ["Cancelled", "Expired", "Removed", "Partially Removed"]) assert.equal(tastytradeOrderStatus(s), "cancelled", s);
  assert.equal(tastytradeOrderStatus("Rejected"), "rejected");
});

test("orders: one per leg, fills averaged, stop trigger as the stop price, Ext outside regular hours, GTC kept", () => {
  const list = [
    {
      id: "101",
      "order-type": "Limit",
      "time-in-force": "Day",
      price: "150.00",
      status: "Filled",
      "received-at": "2026-11-16T13:00:00.000+00:00",
      "external-identifier": "my-ref-1",
      legs: [
        {
          symbol: "AAPL",
          quantity: "10",
          "remaining-quantity": "0",
          action: "Buy to Open",
          fills: [
            { quantity: "4", "fill-price": "149.90" },
            { quantity: "6", "fill-price": "150.00" },
          ],
        },
      ],
    },
    {
      id: "102",
      "order-type": "Stop",
      "time-in-force": "GTC",
      "stop-trigger": "140.00",
      status: "Live",
      "received-at": "2026-08-18T13:00:00.000+00:00",
      legs: [{ symbol: "AAPL", quantity: "5", "remaining-quantity": "5", action: "Sell to Close", fills: [] }],
    },
    {
      id: "103",
      "order-type": "Limit",
      "time-in-force": "GTC Ext",
      price: "1.25",
      status: "Cancelled",
      legs: [
        { symbol: "SPY   261218C00600000", quantity: "2", "remaining-quantity": "2", action: "Sell to Open" },
        { symbol: "SPY   261218C00610000", quantity: "2", "remaining-quantity": "2", action: "Buy to Open" },
      ],
    },
    { id: "104", "order-type": "Market", "time-in-force": "Day", status: "Received", legs: [] },
    { "order-type": "Market", legs: [{ symbol: "X", quantity: "1" }] },
  ];
  const out = tastytradeOrders(list, ACCOUNT, NOW);
  assert.equal(out.length, 4, "an order without legs or an id is left out");
  const [a, b, c1, c2] = out;
  assert.deepEqual(a, {
    id: `tastytrade:${ACCOUNT.id}:101`,
    clientId: "my-ref-1",
    accountId: ACCOUNT.id,
    brokerId: "tastytrade",
    symbol: "AAPL",
    side: "BUY",
    qty: 10,
    type: "LMT",
    tif: "DAY",
    status: "filled",
    placedAt: "2026-11-16T13:00:00.000Z",
    brokerRef: "101",
    price: 150,
    filledQty: 10,
    avgFill: 149.96,
    outsideRth: false,
  });
  assert.deepEqual([b.type, b.price, b.tif, b.status, b.side, b.filledQty, b.clientId], ["STP", 140, "GTC", "working", "SELL", 0, "tastytrade-102"]);
  assert.deepEqual([c1.id, c2.id], [`tastytrade:${ACCOUNT.id}:103:0`, `tastytrade:${ACCOUNT.id}:103:1`]);
  assert.deepEqual([c1.symbol, c1.side, c2.side, c1.tif, c1.outsideRth, c1.price], ["SPY 261218C00600000", "SELL", "BUY", "GTC", true, 1.25]);
  assert.equal(c1.placedAt, new Date(NOW).toISOString(), "no time sent: the read's time");
});

test("merge: an order in several lists is kept once, the latest update wins", () => {
  const merged = mergeOrders(
    [{ id: "1", status: "Live", "updated-at": "2026-11-16T10:00:00Z" }, { id: "2", status: "Filled" }],
    [{ id: "1", status: "Filled", "updated-at": "2026-11-16T11:00:00Z" }, { id: "3" }],
    [{ id: "1", status: "Live", "updated-at": "2026-11-16T09:00:00Z" }, { id: "" }],
    null,
  );
  assert.deepEqual(
    merged.map((o) => [o.id, o.status]),
    [
      ["1", "Filled"],
      ["2", "Filled"],
      ["3", undefined],
    ],
  );
});

test("executions: Trade transactions only, fees by their effect, net by its effect, estimated fees provisional", () => {
  const out = tastytradeExecutions(
    [
      {
        id: 9001,
        "transaction-type": "Trade",
        action: "Buy to Open",
        symbol: "AAPL",
        quantity: "4",
        price: "149.90",
        value: "599.60",
        "value-effect": "Debit",
        commission: "0.00",
        "commission-effect": "None",
        "clearing-fees": "0.02",
        "clearing-fees-effect": "Debit",
        "regulatory-fees": "0.01",
        "regulatory-fees-effect": "Debit",
        "net-value": "599.63",
        "net-value-effect": "Debit",
        "executed-at": "2026-11-16T13:00:01.000+00:00",
      },
      {
        id: 9003,
        "transaction-type": "Trade",
        "transaction-sub-type": "Sell to Open",
        symbol: "SPY   261218C00600000",
        quantity: "2",
        price: "2.50",
        value: "500.00",
        "value-effect": "Credit",
        commission: "2.00",
        "commission-effect": "Debit",
        "clearing-fees": "0.20",
        "clearing-fees-effect": "Debit",
        "regulatory-fees": "0.05",
        "regulatory-fees-effect": "Debit",
        "proprietary-index-option-fees": "0.10",
        "proprietary-index-option-fees-effect": "Credit",
        "executed-at": "2026-11-13T15:00:00.000+00:00",
        "is-estimated-fee": true,
      },
      { id: 9004, "transaction-type": "Money Movement", value: "1000", "value-effect": "Credit" },
      { id: 9006, "transaction-type": "Trade", quantity: "0", symbol: "Z" },
      { id: 9007, "transaction-type": "Trade", quantity: "1", symbol: "Q", price: "5", value: "5", "value-effect": "Debit" },
      {
        id: 9008,
        "transaction-type": "Trade",
        action: "Sell to Close",
        symbol: "SHOP",
        quantity: "10",
        price: "100.00",
        value: "1000.00",
        "value-effect": "Credit",
        commission: "1.00",
        "commission-effect": "Debit",
        "other-charge": "0.50",
        "other-charge-description": "ADR fee",
        "other-charge-effect": "Debit",
        "currency-conversion-fees": "2.25",
        "currency-conversion-fees-effect": "Debit",
        "net-value": "996.25",
        "net-value-effect": "Credit",
        "executed-at": "2026-11-16T14:00:00.000+00:00",
      },
    ],
    ACCOUNT,
    NOW,
  );
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], {
    id: `tastytrade:${ACCOUNT.id}:t:9001`,
    accountId: ACCOUNT.id,
    brokerId: "tastytrade",
    symbol: "AAPL",
    side: "BUY",
    qty: 4,
    price: 149.9,
    commission: 0.03,
    net: -599.63,
    tradedAt: "2026-11-16T13:00:01.000Z",
  });
  assert.deepEqual(
    [out[1].side, out[1].symbol, out[1].commission, out[1].net, out[1].provisional],
    ["SELL", "SPY 261218C00600000", 2.15, 497.85, true],
    "no net-value: the value less the fees (a rebate lowers them)",
  );
  assert.deepEqual([out[2].side, out[2].net, out[2].commission], ["BUY", -5, 0], "no action: the value's effect says it was bought");
  assert.deepEqual([out[3].side, out[3].commission, out[3].net], ["SELL", 3.75, 996.25], "other charges and currency conversion fees are costs too");
  assert.equal(signed("3", "None"), 0);
  assert.equal(signed(undefined, "Debit"), undefined);
});

test("token errors: client problems trip the breaker, a dead grant or code ends one login, outages are other", () => {
  assert.equal(tastytradeTokenError(401, { error: { code: "invalid_client", message: "x" } }), "invalid_client");
  assert.equal(tastytradeTokenError(400, { error: "unauthorized_client" }), "invalid_client");
  assert.equal(tastytradeTokenError(400, { error: { code: "invalid_grant" } }), "invalid_grant");
  assert.equal(tastytradeTokenError(400, { error: { code: "invalid_refresh_token" } }), "invalid_grant");
  assert.equal(tastytradeTokenError(401, { error: { code: "unauthorized", message: "The grant was removed" } }), "invalid_client", "a bare 401 counts, so repeated ones pause token calls");
  assert.equal(tastytradeTokenError(401, null), "invalid_client", "the HTML 401 of a missing User-Agent");
  assert.equal(tastytradeTokenError(400, { error: { code: "validation_error" } }), "invalid_grant", "never retried in a loop");
  assert.equal(tastytradeTokenError(503, { error: { code: "unavailable" } }), "other");
  assert.equal(tastytradeTokenError(500, null), "other");
});

test("envelopes and paging: items from data.items, pages until total-pages or a short page, capped and flagged when cut", async () => {
  assert.deepEqual(itemsOf({ data: { items: [1, 2] } }), [1, 2]);
  assert.deepEqual(itemsOf({ data: {} }), []);
  assert.deepEqual(itemsOf(null), []);
  /** @type {number[]} */
  const asked = [];
  const five = [1, 2, 3, 4, 5];
  const page = async (/** @type {number} */ offset) => {
    asked.push(offset);
    return { data: { items: five.slice(offset * 2, offset * 2 + 2) }, pagination: { "total-pages": 3 } };
  };
  assert.deepEqual(await paged(page, 2, 10), { items: [1, 2, 3, 4, 5], truncated: false });
  assert.deepEqual(asked, [0, 1, 2]);
  asked.length = 0;
  assert.deepEqual(await paged(page, 2, 2), { items: [1, 2, 3, 4], truncated: true }, "the page cap, and tastytrade had more");
  assert.deepEqual(await paged(page, 2, 3), { items: [1, 2, 3, 4, 5], truncated: false }, "the cap reached on the last page is not a cut");
  const noMeta = async (/** @type {number} */ offset) => ({ data: { items: five.slice(offset * 2, offset * 2 + 2) } });
  assert.deepEqual(await paged(noMeta, 2, 10), { items: [1, 2, 3, 4, 5], truncated: false }, "without pagination: until a short page");
  assert.deepEqual(await paged(noMeta, 2, 2), { items: [1, 2, 3, 4], truncated: true }, "without pagination: a full last page at the cap counts as cut");
  const nullCount = async (/** @type {number} */ offset) => ({ data: { items: five.slice(offset * 2, offset * 2 + 2) }, pagination: { "total-pages": null } });
  assert.deepEqual(await paged(nullCount, 2, 10), { items: [1, 2, 3, 4, 5], truncated: false }, "a null total-pages is no count, not zero pages");
});
