import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIENT_ORDER_ID_RE,
  formatPrice,
  isValidPrice,
  messageTextHash,
  newClientOrderId,
  normalizeSymbol,
  OrderNotSentError,
  ORDER_REQUEST_STATUSES,
  TRADING_METHODS,
  US_MARKET_CLOSED,
  usRegularSession,
} from "../src/order-contract.mjs";
import { HttpError } from "../src/errors.mjs";
import { etToUtc } from "../src/time.mjs";

test("trading methods and statuses are the migration's", () => {
  assert.deepEqual([...TRADING_METHODS], ["ibkr_gateway", "etrade_oauth1", "alpaca_key"]);
  assert.deepEqual([...ORDER_REQUEST_STATUSES], ["preview", "sending", "placed", "rejected", "unknown", "needs_confirmation", "cancel_requested", "cancelled"]);
  assert.throws(() => /** @type {any} */ (TRADING_METHODS).push("alpaca_oauth"));
});

test("client order ids: nc plus 18 hex digits, 20 characters, never repeated", () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) {
    const id = newClientOrderId();
    assert.match(id, CLIENT_ORDER_ID_RE);
    assert.equal(id.length, 20);
    ids.add(id);
  }
  assert.equal(ids.size, 500);
});

test("isValidPrice: above 0, at most 100000, 2 decimals from $1, 4 below", () => {
  for (const p of [185.5, 185.55, 1, 0.1234, 0.0001, 0.5, 99_999.99, 100_000, 12]) assert.equal(isValidPrice(p), true, String(p));
  for (const p of [0, -1, 185.555, 0.12345, 100_000.01, NaN, Infinity, "185.5", null, undefined, 1.001]) {
    assert.equal(isValidPrice(p), false, String(p));
  }
  // floating point: 0.1 + 0.2 is not exactly 0.3, but it is a valid 2-decimal price
  assert.equal(isValidPrice(0.1 + 0.2 + 1), true);
});

test("formatPrice: 2 decimals from $1, 4 below", () => {
  assert.equal(formatPrice(185.5), "185.50");
  assert.equal(formatPrice(1), "1.00");
  assert.equal(formatPrice(0.1234), "0.1234");
  assert.equal(formatPrice(0.5), "0.5000");
});

test("normalizeSymbol: trimmed, upper case, spaces become one dot", () => {
  assert.equal(normalizeSymbol(" aapl "), "AAPL");
  assert.equal(normalizeSymbol("brk b"), "BRK.B");
  assert.equal(normalizeSymbol("BRK   B"), "BRK.B");
  assert.equal(normalizeSymbol(null), "");
  assert.equal(normalizeSymbol(undefined), "");
});

test("messageTextHash: spacing does not change it, a word does", () => {
  const a = messageTextHash("You are submitting an order without market data.");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(messageTextHash("  You are submitting   an order\nwithout market data. "), a);
  assert.notEqual(messageTextHash("You are submitting an order without live market data."), a);
});

test("OrderNotSentError is an HttpError with a code", () => {
  const e = new OrderNotSentError(409, "Nothing was placed.");
  assert.ok(e instanceof HttpError);
  assert.equal(e.status, 409);
  assert.equal(e.code, "order_not_sent");
  assert.equal(e.name, "OrderNotSentError");
  assert.equal(new OrderNotSentError(429, "x", "rate_limited").code, "rate_limited");
});

/** @param {string} day "2026-11-27" @param {number} hour @param {number} minute */
const et = (day, hour, minute) => {
  const [y, m, d] = day.split("-").map(Number);
  return etToUtc(y, m, d, hour, minute);
};

test("usRegularSession: hours, weekends, every 2026 holiday, the early close", () => {
  assert.deepEqual(usRegularSession(et("2026-11-20", 12, 0)), { open: true, known: true });
  assert.equal(usRegularSession(et("2026-11-20", 9, 29)).open, false);
  assert.equal(usRegularSession(et("2026-11-20", 9, 30)).open, true);
  assert.equal(usRegularSession(et("2026-11-20", 15, 59)).open, true);
  assert.equal(usRegularSession(et("2026-11-20", 16, 0)).open, false);
  assert.equal(usRegularSession(et("2026-11-21", 12, 0)).open, false, "Saturday");
  assert.equal(usRegularSession(et("2026-11-22", 12, 0)).open, false, "Sunday");
  for (const day of [...US_MARKET_CLOSED].filter((d) => d.startsWith("2026-"))) {
    assert.equal(usRegularSession(et(day, 12, 0)).open, false, day);
  }
  assert.equal(usRegularSession(et("2026-11-27", 12, 59)).open, true);
  assert.equal(usRegularSession(et("2026-11-27", 13, 0)).open, false);
  assert.equal(usRegularSession(et("2026-12-24", 13, 30)).open, false);
});

test("usRegularSession across both daylight-saving changes", () => {
  // 2026-03-09 (the Monday after the spring change): 09:30 ET is 13:30 UTC
  assert.equal(usRegularSession(Date.UTC(2026, 2, 9, 13, 29)).open, false);
  assert.equal(usRegularSession(Date.UTC(2026, 2, 9, 13, 30)).open, true);
  // 2026-03-06 (before): 09:30 ET is 14:30 UTC
  assert.equal(usRegularSession(Date.UTC(2026, 2, 6, 14, 29)).open, false);
  assert.equal(usRegularSession(Date.UTC(2026, 2, 6, 14, 30)).open, true);
  // 2026-11-02 (the Monday after the fall change): 16:00 ET is 21:00 UTC
  assert.equal(usRegularSession(Date.UTC(2026, 10, 2, 20, 59)).open, true);
  assert.equal(usRegularSession(Date.UTC(2026, 10, 2, 21, 0)).open, false);
  // the change days themselves are Sundays: closed
  assert.equal(usRegularSession(et("2026-03-08", 12, 0)).open, false);
  assert.equal(usRegularSession(et("2026-11-01", 12, 0)).open, false);
});

test("usRegularSession past the calendar: known is false, hours and weekends still apply", () => {
  assert.deepEqual(usRegularSession(et("2029-01-02", 12, 0)), { open: true, known: false });
  assert.deepEqual(usRegularSession(et("2029-01-06", 12, 0)), { open: false, known: false });
});
