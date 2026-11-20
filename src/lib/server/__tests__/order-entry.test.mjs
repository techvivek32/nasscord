import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { formatPrice as serviceFormatPrice, isValidPrice as serviceIsValidPrice, normalizeSymbol as serviceNormalizeSymbol } from "../../../../services/broker/src/order-contract.mjs";
import {
  CLIENT_ORDER_ID_RE,
  defaultTarget,
  formatOrderPrice,
  isDangerWarning,
  isNasscordOrder,
  isValidPrice,
  normalizeSymbol,
  ORDER_COPY,
  placeSchema,
  stoppedChecking,
  ticketSchema,
  cancelSchema,
} from "@/lib/order-entry";
import { BrokerServiceError, orderOutcomeUnknown } from "@/lib/server/broker-service";

/*
 * The client-safe order entry rules (src/lib/order-entry.ts), pinned to the broker service's own contract
 * (services/broker/src/order-contract.mjs), and the app's rule for "may this order step have reached the
 * broker" (orderOutcomeUnknown in src/lib/server/broker-service.ts). Run with the command in alias-hooks.mjs.
 */

const accountId = randomUUID();
const base = { accountId, symbol: "AAPL", side: "BUY", quantity: 10, type: "LMT", limitPrice: 185.5, tif: "DAY", intent: "trade" };

/** The first message of a refused ticket, or null when it passes. @param {Record<string, unknown>} over */
function refusal(over) {
  const r = ticketSchema.safeParse({ ...base, ...over });
  return r.success ? null : r.error.issues[0]?.message;
}

test("ticketSchema: a plain limit ticket passes, and the symbol is stored as the service stores it", () => {
  const r = ticketSchema.safeParse({ ...base, symbol: " brk b " });
  assert.ok(r.success, JSON.stringify(r.error?.issues));
  assert.equal(r.data.symbol, "BRK.B");
  assert.equal(serviceNormalizeSymbol(" brk b "), "BRK.B");
  assert.equal(normalizeSymbol("  spy "), "SPY");
  assert.equal(refusal({ symbol: "1ABC" }), "Enter a US stock or ETF symbol.");
  assert.equal(refusal({ symbol: "ABCDEFGHIJK" }), "Enter a US stock or ETF symbol.");
});

test("ticketSchema: field rules and their sentences", () => {
  assert.equal(refusal({ accountId: "nope" }), "Pick an account.");
  assert.equal(refusal({ side: "buy" }), "Pick Buy or Sell.");
  assert.equal(refusal({ quantity: 1.5 }), "Enter whole shares.");
  assert.equal(refusal({ quantity: 0 }), "Enter at least 1 share.");
  assert.ok(refusal({ quantity: 1_000_001 }));
  assert.equal(refusal({ limitPrice: 185.555 }), "Use a price above 0 with at most 2 decimals (4 below $1).");
  assert.equal(refusal({ limitPrice: 0.12345 }), "Use a price above 0 with at most 2 decimals (4 below $1).");
  assert.equal(refusal({ limitPrice: null }), "Use a price above 0 with at most 2 decimals (4 below $1).", "null is refused: unused fields are left out");
  assert.equal(refusal({ limitPrice: undefined }), "Enter a limit price.");
  assert.equal(refusal({ type: "MKT" }), "This order type has no limit price.");
  assert.equal(refusal({ type: "STP", limitPrice: undefined }), "Enter a stop price.");
  assert.equal(refusal({ stopPrice: 180 }), "This order type has no stop price.");
  assert.equal(refusal({ type: "STP_LMT", stopPrice: 186 }), null);
  assert.equal(refusal({ intent: "close" }), "Open Close from the Positions page.");
  assert.equal(refusal({ intent: "close", positionId: "alpaca:x:AAPL", expectedPositionQty: -300, side: "BUY", quantity: 300 }), null);
});

test("ticketSchema: brackets are buy entries, Market or Limit, always Good till cancelled", () => {
  const bracket = { takeProfit: { limitPrice: 195 }, stopLoss: { stopPrice: 178 } };
  assert.equal(refusal({ bracket, tif: "GTC" }), null);
  assert.equal(refusal({ bracket, tif: "DAY" }), "A bracket is sent as Good till cancelled, so its stop-loss and take-profit stay after today's close.");
  assert.equal(refusal({ bracket, tif: "GTC", side: "SELL" }), "Brackets are for buy orders: Nasscord does not open short positions.");
  assert.equal(refusal({ bracket, tif: "GTC", type: "STP", limitPrice: undefined, stopPrice: 190 }), "A bracket enters with a Market or Limit order.");
  assert.equal(
    refusal({ bracket: { takeProfit: { limitPrice: 180 }, stopLoss: { stopPrice: 178 } }, tif: "GTC" }),
    "For a buy bracket, the stop-loss goes below the entry and the take-profit above it.",
  );
  assert.equal(
    refusal({ bracket: { takeProfit: { limitPrice: 195 }, stopLoss: { stopPrice: 186 } }, tif: "GTC" }),
    "For a buy bracket, the stop-loss goes below the entry and the take-profit above it.",
  );
  assert.equal(
    refusal({ bracket: { takeProfit: { limitPrice: 195 }, stopLoss: { stopPrice: 178, limitPrice: 179 } }, tif: "GTC" }),
    "The stop-loss limit goes at or below its stop price.",
  );
  assert.equal(refusal({ bracket, tif: "GTC", type: "MKT", limitPrice: undefined }), null, "a Market entry is checked by the service against its reference price");
  assert.equal(refusal({ bracket, tif: "GTC", intent: "close", positionId: "p", expectedPositionQty: 10 }), "Open Close from the Positions page.");
});

test("placeSchema and cancelSchema", () => {
  const id = randomUUID();
  const p = placeSchema.safeParse({ requestId: id });
  assert.ok(p.success);
  assert.deepEqual(p.data.acknowledged, []);
  assert.equal(placeSchema.safeParse({ requestId: "x" }).error?.issues[0]?.message, "Send the order request id.");
  assert.ok(!placeSchema.safeParse({ requestId: id, acknowledged: Array(11).fill("k") }).success);
  assert.ok(!placeSchema.safeParse({ requestId: id, acknowledged: ["k".repeat(65)] }).success);
  assert.ok(!placeSchema.safeParse({ requestId: id, confirmBrokerMessages: ["o".repeat(33)] }).success);
  assert.ok(cancelSchema.safeParse({ accountId: id, orderId: "alpaca:x:y" }).success);
  assert.ok(!cancelSchema.safeParse({ accountId: id, orderId: "ab" }).success);
  assert.ok(!cancelSchema.safeParse({ accountId: id, orderId: "a".repeat(201) }).success);
});

test("isValidPrice matches the broker service's rule", () => {
  const cases = [185.5, 185.55, 185.555, 0.1234, 0.12345, 1, 0.99, 100_000, 100_000.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.005, 999.99, 0.0001];
  for (const p of cases) assert.equal(isValidPrice(p), serviceIsValidPrice(p), String(p));
  assert.equal(isValidPrice(185.5), true);
  assert.equal(isValidPrice(185.555), false);
  assert.equal(isValidPrice(0.12345), false);
});

test("formatOrderPrice shows the price exactly as it is sent", () => {
  assert.equal(formatOrderPrice(0.1234), "0.1234");
  assert.equal(formatOrderPrice(1234.5), "1,234.50");
  assert.equal(formatOrderPrice(185.5), "185.50");
  assert.equal(formatOrderPrice(1), "1.00");
  // The digits are the service's (formatPrice), with thousands separators.
  for (const p of [0.5, 0.1234, 1, 185.55, 99_999.99]) assert.equal(formatOrderPrice(p).replace(/,/g, ""), serviceFormatPrice(p));
});

test("defaultTarget: TradeScope's 0.72 R above a buy entry, only when the stop is below it", () => {
  assert.equal(defaultTarget(100, 90), 107.2);
  assert.equal(defaultTarget(185.5, 178), 190.9);
  assert.equal(defaultTarget(100, 100), null);
  assert.equal(defaultTarget(100, 110), null);
  assert.equal(defaultTarget(Number.NaN, 90), null);
});

test("client order ids and danger warnings", () => {
  assert.ok(CLIENT_ORDER_ID_RE.test("nc0f3a9c2b7d1e4f5a60"));
  assert.equal(isNasscordOrder("nc0f3a9c2b7d1e4f5a60"), true);
  assert.equal(isNasscordOrder("NC0F3A9C2B7D1E4F5A60"), false);
  assert.equal(isNasscordOrder(undefined), false);
  assert.equal(isDangerWarning("ibkr_bracket_incomplete", "paper"), true);
  assert.equal(isDangerWarning("ibkr_bracket_incomplete", "production"), true);
  for (const code of ["ibkr_echo_mismatch", "etrade_echo_mismatch", "alpaca_echo_mismatch"]) {
    assert.equal(isDangerWarning(code, "production"), true, code);
    assert.equal(isDangerWarning(code, "paper"), false, code);
  }
  assert.equal(isDangerWarning("recent_similar", "production"), false);
  assert.match(stoppedChecking("IBKR"), /^Nasscord stopped checking this order automatically\. Check IBKR directly, then mark it as checked\.$/);
});

test("orderOutcomeUnknown: only a deliberate refusal proves that nothing was sent", () => {
  const table = [
    ["timeout", new BrokerServiceError(504, "t", { kind: "timeout" }), true],
    ["unreachable", new BrokerServiceError(503, "u", { kind: "unreachable" }), true],
    ["unreadable", new BrokerServiceError(502, "r", { kind: "unreadable" }), true],
    ["500 without a code", new BrokerServiceError(502, "x", { serviceStatus: 500 }), true],
    ["500 with code error", new BrokerServiceError(502, "x", { serviceStatus: 500, code: "error" }), true],
    ["503 shutting_down", new BrokerServiceError(502, "x", { serviceStatus: 503, code: "shutting_down" }), false],
    ["409 busy", new BrokerServiceError(409, "x", { serviceStatus: 409, code: "busy" }), false],
    ["409 without a code", new BrokerServiceError(409, "x", { serviceStatus: 409 }), false],
    ["never called (not configured)", new BrokerServiceError(503, "x"), false],
    ["a TypeError", new TypeError("boom"), true],
    ["a string", "boom", true],
  ];
  for (const [name, err, expected] of table) assert.equal(orderOutcomeUnknown(err), expected, String(name));
});

test("no em-dash in the order copy", () => {
  for (const s of Object.values(ORDER_COPY)) assert.ok(!s.includes("\u2014"), s);
});
