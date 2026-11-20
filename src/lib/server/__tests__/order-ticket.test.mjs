import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  buildTicketBody,
  defaultAccountId,
  emptyDraft,
  fitToCaps,
  parsePrice,
  parseQuantity,
  prefillFromPosition,
  sizeSuggestion,
  ticketLimitError,
} from "@/lib/order-ticket";

/*
 * The order ticket's pure rules (src/lib/order-ticket.ts): where a wrong side, a wrong quantity or a wrong
 * account could be born. Run with the command in alias-hooks.mjs.
 */

const ALL_CAPS = {
  types: ["MKT", "LMT", "STP", "STP_LMT"],
  tif: ["DAY", "GTC"],
  marketGtc: true,
  bracket: { entryTypes: ["MKT", "LMT"], stopTypes: ["STP", "STP_LMT"] },
  notes: [],
};
const ETRADE_CAPS = { types: ["MKT", "LMT", "STP", "STP_LMT"], tif: ["DAY", "GTC"], marketGtc: false, bracket: null, notes: [] };
const IBKR_LIVE_CAPS = { types: ["MKT", "LMT"], tif: ["DAY", "GTC"], marketGtc: true, bracket: null, notes: [] };

// Wednesday 2026-11-18, 11:00 ET (16:00 UTC) and 18:00 ET (23:00 UTC).
const OPEN = new Date("2026-11-18T16:00:00Z");
const CLOSED = new Date("2026-11-18T23:00:00Z");

const accountId = randomUUID();
const position = (qty, over = {}) => ({ id: `alpaca:${accountId}:AAPL`, accountId, symbol: "aapl", qty, last: 190.12, ...over });

test("Close of a short gives a Buy of the whole position with the signed quantity the user saw", () => {
  const d = prefillFromPosition(position(-300), "close", { now: OPEN, broker: "Alpaca" });
  assert.ok(!("error" in d));
  assert.equal(d.side, "BUY");
  assert.equal(d.quantityText, "300");
  assert.equal(d.expectedPositionQty, -300);
  assert.equal(d.intent, "close");
  assert.equal(d.symbol, "AAPL");
  assert.equal(d.accountId, accountId);
  assert.equal(d.type, "MKT");
  assert.equal(d.tif, "DAY");
  const long = prefillFromPosition(position(120), "close", { now: OPEN, broker: "Alpaca" });
  assert.ok(!("error" in long));
  assert.equal(long.side, "SELL");
  assert.equal(long.quantityText, "120");
});

test("Sell from a fractional row suggests the whole shares and leaves the quantity empty", () => {
  const d = prefillFromPosition(position(12.5), "sell", { now: OPEN, broker: "Alpaca" });
  assert.ok(!("error" in d));
  assert.equal(d.side, "SELL");
  assert.equal(d.suggestion, 12);
  assert.equal(d.quantityText, "");
});

test("Buy and Sell never fill in the quantity; a short row offers a cover suggestion; no Sell on a short", () => {
  const buy = prefillFromPosition(position(50), "buy", { now: OPEN, broker: "Alpaca" });
  assert.ok(!("error" in buy));
  assert.equal(buy.quantityText, "");
  assert.equal(buy.suggestion, null);
  const cover = prefillFromPosition(position(-40), "buy", { now: OPEN, broker: "Alpaca" });
  assert.ok(!("error" in cover));
  assert.equal(cover.side, "BUY");
  assert.equal(cover.suggestion, 40);
  assert.equal(cover.quantityText, "");
  const sellShort = prefillFromPosition(position(-40), "sell", { now: OPEN, broker: "Alpaca" });
  assert.ok("error" in sellShort);
});

test("Close of a fractional position answers the sentence", () => {
  const d = prefillFromPosition(position(12.5), "close", { now: OPEN, broker: "Alpaca" });
  assert.deepEqual(d, { error: "Close fractional positions in Alpaca." });
});

test("Close while the market is closed is a Limit order with an empty price", () => {
  const d = prefillFromPosition(position(100), "close", { now: CLOSED, broker: "Alpaca" });
  assert.ok(!("error" in d));
  assert.equal(d.type, "LMT");
  assert.equal(d.limitText, "");
  assert.equal(d.tif, "DAY");
  // A Saturday at noon ET is closed too.
  const sat = prefillFromPosition(position(100), "close", { now: new Date("2026-11-21T17:00:00Z"), broker: "Alpaca" });
  assert.ok(!("error" in sat));
  assert.equal(sat.type, "LMT");
});

test("defaultAccountId: row, header account, paper first, the only account, else none", () => {
  const live1 = { id: "a-live-1", connection: { environment: "production" } };
  const live2 = { id: "a-live-2", connection: { environment: "production" } };
  const paper = { id: "a-paper", connection: { environment: "paper" } };
  const tradable = [live1, paper, live2];
  assert.equal(defaultAccountId({ prefillAccountId: "a-live-2", selected: "a-paper", tradable, paperFirst: true }), "a-live-2");
  assert.equal(defaultAccountId({ prefillAccountId: "not-tradable", selected: "a-live-1", tradable, paperFirst: true }), "a-live-1");
  assert.equal(defaultAccountId({ selected: "not-tradable", tradable, paperFirst: true }), "a-paper");
  assert.equal(defaultAccountId({ selected: null, tradable: [live1], paperFirst: false }), "a-live-1");
  assert.equal(defaultAccountId({ selected: null, tradable: [live1, live2], paperFirst: true }), null);
  assert.equal(defaultAccountId({ selected: null, tradable: [live1, paper], paperFirst: false }), null);
  assert.equal(defaultAccountId({ selected: null, tradable: [], paperFirst: true }), null);
});

test("switching to an E*TRADE account drops a bracket, and buildTicketBody never sends it", () => {
  const draft = {
    ...emptyDraft(accountId),
    symbol: "AAPL",
    quantityText: "10",
    type: "LMT",
    limitText: "185.5",
    tif: "GTC",
    bracketOn: true,
    stopLossStopText: "180",
    takeProfitText: "195",
  };
  const onAlpaca = buildTicketBody(draft, ALL_CAPS);
  assert.ok(!("error" in onAlpaca), JSON.stringify(onAlpaca));
  assert.deepEqual(onAlpaca.bracket, { takeProfit: { limitPrice: 195 }, stopLoss: { stopPrice: 180 } });
  assert.equal(onAlpaca.tif, "GTC");

  const fitted = fitToCaps(draft, ETRADE_CAPS, "E*TRADE");
  assert.equal(fitted.draft.bracketOn, false);
  assert.equal(fitted.notes.length, 1);
  assert.match(fitted.notes[0], /^E\*TRADE does not take bracket orders/);
  const onEtrade = buildTicketBody(draft, ETRADE_CAPS);
  assert.ok(!("error" in onEtrade), JSON.stringify(onEtrade));
  assert.equal(onEtrade.bracket, undefined);
  assert.equal("bracket" in onEtrade, false);
});

test("an account without Stop limit resets the type to Limit and says why", () => {
  const draft = { ...emptyDraft(accountId), type: "STP_LMT", limitText: "10", stopText: "11" };
  const fitted = fitToCaps(draft, IBKR_LIVE_CAPS, "IBKR");
  assert.equal(fitted.draft.type, "LMT");
  assert.deepEqual(fitted.notes, ["IBKR does not take Stop limit orders from Nasscord, so the type is now Limit."]);
});

test("Market with marketGtc false forces Day; a bracket forces Good till cancelled", () => {
  const mkt = fitToCaps({ ...emptyDraft(accountId), type: "MKT", tif: "GTC" }, ETRADE_CAPS, "E*TRADE");
  assert.equal(mkt.draft.tif, "DAY");
  assert.deepEqual(mkt.notes, ["E*TRADE takes Market orders as Day orders only."]);
  const bracket = fitToCaps({ ...emptyDraft(accountId), type: "LMT", tif: "DAY", bracketOn: true }, ALL_CAPS, "Alpaca");
  assert.equal(bracket.draft.tif, "GTC");
  const body = buildTicketBody(
    { ...emptyDraft(accountId), symbol: "AAPL", quantityText: "5", type: "MKT", tif: "DAY", bracketOn: true, stopLossStopText: "180", takeProfitText: "195" },
    ALL_CAPS,
  );
  assert.ok(!("error" in body), JSON.stringify(body));
  assert.equal(body.tif, "GTC");
});

test("buildTicketBody sends a stop price only for Stop types and never the sizing stop", () => {
  const draft = { ...emptyDraft(accountId), symbol: "brk b", quantityText: "3", type: "LMT", limitText: "410.25", stopText: "400", sizingStopText: "395" };
  const body = buildTicketBody(draft, ALL_CAPS);
  assert.ok(!("error" in body), JSON.stringify(body));
  assert.deepEqual(body, { accountId, symbol: "BRK.B", side: "BUY", quantity: 3, type: "LMT", limitPrice: 410.25, tif: "DAY", intent: "trade" });
  const stop = buildTicketBody({ ...draft, type: "STP", side: "SELL" }, ALL_CAPS);
  assert.ok(!("error" in stop), JSON.stringify(stop));
  assert.equal(stop.stopPrice, 400);
  assert.equal(stop.limitPrice, undefined);
  assert.deepEqual(buildTicketBody({ ...draft, accountId: null }, ALL_CAPS), { error: "Pick an account." });
});

test("a close ticket carries the position id and the expected quantity", () => {
  const d = prefillFromPosition(position(-300), "close", { now: OPEN, broker: "Alpaca" });
  assert.ok(!("error" in d));
  const body = buildTicketBody(d, ALL_CAPS);
  assert.ok(!("error" in body), JSON.stringify(body));
  assert.equal(body.intent, "close");
  assert.equal(body.side, "BUY");
  assert.equal(body.quantity, 300);
  assert.equal(body.expectedPositionQty, -300);
  assert.equal(body.positionId, `alpaca:${accountId}:AAPL`);
});

test("strict parsing: no partial numbers, no exponents", () => {
  assert.equal(parsePrice("185.5O"), null);
  assert.equal(parsePrice("0.12345"), null);
  assert.equal(parsePrice("185.555"), null);
  assert.equal(parsePrice("1e3"), null);
  assert.equal(parsePrice("-5"), null);
  assert.equal(parsePrice(""), null);
  assert.equal(parsePrice("185.5"), 185.5);
  assert.equal(parsePrice("0.1234"), 0.1234);
  assert.equal(parseQuantity("1e3"), null);
  assert.equal(parseQuantity("10.0"), null);
  assert.equal(parseQuantity("0"), null);
  assert.equal(parseQuantity("1000001"), null);
  assert.equal(parseQuantity("250"), 250);
});

test("ticketLimitError names both limits", () => {
  const caps = { limits: { maxQty: 10_000, maxNotional: 250_000 } };
  const base = { ...emptyDraft(accountId), symbol: "AAPL", type: "LMT", limitText: "100" };
  assert.equal(ticketLimitError({ ...base, quantityText: "10001" }, caps), "Up to 10,000 shares per order.");
  assert.equal(ticketLimitError({ ...base, quantityText: "3000" }, caps), "This order is worth about $300,000, above the $250,000 Nasscord allows per order.");
  assert.equal(ticketLimitError({ ...base, quantityText: "2000" }, caps), null);
  // A Sell, and a Buy that covers a short, are bounded by the position.
  assert.equal(ticketLimitError({ ...base, side: "SELL", quantityText: "3000" }, caps), null);
  assert.equal(ticketLimitError({ ...base, quantityText: "3000" }, caps, -5000), null);
});

test("sizeSuggestion caps at the per-order maximum and needs both prices", () => {
  assert.equal(sizeSuggestion({ netLiq: 100_000, riskPct: 1, entry: 100, stop: 98, maxQty: 10_000 }), 500);
  assert.equal(sizeSuggestion({ netLiq: 100_000, riskPct: 1, entry: 100, stop: 98, maxQty: 200 }), 200);
  assert.equal(sizeSuggestion({ netLiq: 100_000, riskPct: 1, entry: 100, stop: null, maxQty: 10_000 }), null);
  assert.equal(sizeSuggestion({ netLiq: null, riskPct: 1, entry: 100, stop: 98, maxQty: 10_000 }), null);
});
