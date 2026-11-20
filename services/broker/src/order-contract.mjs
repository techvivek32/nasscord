import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { etDateKey, etParts } from "./time.mjs";

/**
 * Order entry contract (docs/real-backend.md section 13), shared by the order core (orders.mjs) and the
 * trading part of the three adapters that may place orders: ibkr_gateway, etrade_oauth1 and alpaca_key.
 * Every other adapter stays read-only. Pure: no I/O and no logging here.
 *
 * Rules every TradingAdapter follows:
 * - capabilities(connection, accounts): what this connection may send now; { blocked: sentence } when it is a
 *   trading connection that cannot send for a reason the user should read; null when it never sends.
 * - previewOrder: no side effect at the broker (IBKR what-if, E*TRADE preview, Alpaca reads). Throws an
 *   HttpError with a sentence a user can read when the order cannot go ahead.
 * - positionState: the signed position in shares of ticket.symbol in ctx.account right now, never cached (0 when
 *   there is none; a short is always negative), plus the working orders on each side, which it must read when
 *   the ticket is a SELL or a close or the position is short. Throws OrderNotSentError when it cannot read what
 *   it must (a preview turns that into an HttpError with the same sentence).
 * - placeOrder: sends at most one order (IBKR: one POST plus the reply confirmations of that same order) and
 *   never repeats a send. Before anything is sent, every failure throws OrderNotSentError, a limiter refusal
 *   included. Once the order request has started to go out, it never throws: a timeout, a socket error, a 5xx,
 *   a status it does not list or an unreadable answer returns { status: "unknown" }.
 * - reconcileOrder: reads only. "found: false" never means that the order was not placed.
 * - cancelOrder: checks that the order is open in ctx.account, sends one cancel and never repeats it.
 * - Every broker account number comes from ctx.account.external_id, never from the request.
 * - Logs ids, statuses and broker codes only.
 */

/** The only connect methods that may place orders. */
export const TRADING_METHODS = Object.freeze(["ibkr_gateway", "etrade_oauth1", "alpaca_key"]);

/** order_requests.status values (supabase/migrations/20261121120000_order_entry.sql). */
export const ORDER_REQUEST_STATUSES = Object.freeze(["preview", "sending", "placed", "rejected", "unknown", "needs_confirmation", "cancel_requested", "cancelled"]);

/** Nasscord's client order id: "nc" + 18 lower-case hex digits, 20 characters (E*TRADE allows at most 20 letters and digits). */
export const CLIENT_ORDER_ID_RE = /^nc[0-9a-f]{18}$/;

/** A new client order id (72 random bits). */
export function newClientOrderId() {
  return `nc${randomBytes(9).toString("hex")}`;
}

/** The highest price a ticket may carry. */
export const MAX_PRICE = 100_000;

/**
 * A price a ticket may carry: above 0, at most MAX_PRICE, at most 2 decimals at or above $1 and 4 below.
 * @param {unknown} p
 * @returns {p is number}
 */
export function isValidPrice(p) {
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > MAX_PRICE) return false;
  const scale = p >= 1 ? 100 : 10_000;
  return Math.abs(Math.round(p * scale) - p * scale) < 1e-6;
}

/** The price as text for a broker: "185.50", or 4 decimals below $1. @param {number} p */
export function formatPrice(p) {
  return p >= 1 ? p.toFixed(2) : p.toFixed(4);
}

/** A ticker as Nasscord stores it: trimmed, upper case, a run of spaces becomes "." ("BRK B" is "BRK.B"). @param {unknown} s */
export function normalizeSymbol(s) {
  return String(s ?? "").trim().toUpperCase().replace(/\s+/g, ".");
}

/**
 * The hash an approval of a broker message is tied to (IBKR reply questions): the same id with another text
 * asks again. @param {string} text
 */
export function messageTextHash(text) {
  return createHash("sha256").update(String(text).trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
}

/** NYSE full closures, 2026 to 2028, as nyse.com lists them (checked 2026-11-20). Eastern dates. */
export const US_MARKET_CLOSED = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);

/** NYSE early closes (13:00 ET), 2026 to 2028. */
export const US_MARKET_EARLY_CLOSE = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);

/** The last Eastern date the two lists above cover. */
export const US_MARKET_CALENDAR_END = "2028-12-31";

/**
 * Whether the US regular session (09:30 to 16:00 ET, to 13:00 on an early-close day) is open at `ms`.
 * known: false after US_MARKET_CALENDAR_END, where only weekends and hours are checked.
 * @param {number} ms
 * @returns {{ open: boolean, known: boolean }}
 */
export function usRegularSession(ms) {
  const p = etParts(ms);
  const day = etDateKey(ms);
  const known = day <= US_MARKET_CALENDAR_END;
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  if (weekday === 0 || weekday === 6 || US_MARKET_CLOSED.has(day)) return { open: false, known };
  const minutes = p.hour * 60 + p.minute;
  const closesAt = US_MARKET_EARLY_CLOSE.has(day) ? 13 * 60 : 16 * 60;
  return { open: minutes >= 9 * 60 + 30 && minutes < closesAt, known };
}

/**
 * Two reads of one signed position, taken before and after the working orders were read: the one
 * that allows less. A fill between the reads then counts on the safe side (a sell that filled is
 * in the second position and maybe still in the working list; never in neither). Same sign: the
 * smaller size. Different signs, or a zero: 0 (no long to sell, no short to cover).
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function saferPosition(a, b) {
  if (a === b) return a;
  if (a > 0 && b > 0) return Math.min(a, b);
  if (a < 0 && b < 0) return Math.max(a, b);
  return 0;
}

/** Nothing reached the broker: the order was not sent. The core marks the request rejected with this sentence. */
export class OrderNotSentError extends HttpError {
  /** @param {number} status @param {string} message @param {string} [code] */
  constructor(status, message, code = "order_not_sent") {
    super(status, message, { code });
    this.name = "OrderNotSentError";
  }
}

/**
 * @typedef {import("./db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("./db.mjs").AccountRow} AccountRow
 * @typedef {"MKT" | "LMT" | "STP" | "STP_LMT"} TicketType
 * @typedef {"BUY" | "SELL"} TicketSide
 * @typedef {"DAY" | "GTC"} TicketTif
 * @typedef {{ takeProfit: { limitPrice: number }, stopLoss: { stopPrice: number, limitPrice: number | null } }} Bracket
 * @typedef {{
 *   symbol: string,
 *   side: TicketSide,
 *   quantity: number,
 *   type: TicketType,
 *   limitPrice: number | null,
 *   stopPrice: number | null,
 *   tif: TicketTif,
 *   bracket: Bracket | null,
 *   intent: "trade" | "close",
 *   positionId: string | null,
 *   expectedPositionQty: number | null,
 * }} Ticket
 *   A validated ticket (orders.mjs). The account is ctx.account, never a field here. Brackets are always GTC.
 * @typedef {{
 *   types: TicketType[],
 *   tif: TicketTif[],
 *   marketGtc: boolean,
 *   bracket: { entryTypes: Array<"MKT" | "LMT">, stopTypes: Array<"STP" | "STP_LMT"> } | null,
 *   notes: string[],
 * }} TradingCapabilities
 *   notes: plain sentences the ticket shows for this connection (what it cannot do and why).
 * @typedef {TradingCapabilities | { blocked: string } | null} CapabilityAnswer
 *   blocked: a trading connection that cannot send now, with the sentence the terminal shows (an IBKR login with
 *   more than one account, for example). null: this connection never sends orders.
 * @typedef {{ code: string, text: string, source: "broker" | "nasscord" }} OrderWarning
 * @typedef {{ key: string, text: string }} OrderNotice
 *   A notice the confirm dialog must show; the place request echoes its key in `acknowledged`.
 * @typedef {{ id: string, text: string }} BrokerMessage
 * @typedef {{ id: string, textHash: string }} ApprovedMessage
 *   A broker message the user approved in a second dialog: its id and messageTextHash(text).
 * @typedef {{ bid?: number, ask?: number, last?: number, at?: string, source: string }} Quote
 * @typedef {{ name?: string, exchange?: string }} Instrument
 *   The broker's own name for the symbol ("Apple Inc"), shown next to the ticker in the confirm dialog.
 * @typedef {{
 *   notional?: number, commission?: number, total?: number, source: string,
 *   brokerText?: { amount?: string, commission?: string, total?: string },
 * }} Estimate
 *   source: who made the numbers, in words ("IBKR", "E*TRADE", "Nasscord, from the IEX quote").
 *   brokerText: the broker's own display strings, shown as they are (IBKR what-if).
 * @typedef {{ qty: number, workingSell: number, workingBuy: number, working: boolean }} PositionState
 *   qty: signed shares (a short is negative). workingSell / workingBuy: shares still to fill in working orders of
 *   this account and symbol on each side (every open order counts at its remaining quantity, each exit of a
 *   bracket on its own). working: true when the working orders were read; false means both are 0 because the
 *   adapter did not need them (a BUY with qty >= 0).
 * @typedef {{
 *   connection: ConnectionRow,
 *   account: AccountRow,
 *   requestId: string | null,
 *   deadline: number,
 *   saveBrokerState: (patch: Record<string, unknown>) => Promise<void>,
 * }} OrderCtx
 *   requestId: null during a preview. deadline: epoch ms after which no new step starts (OrderNotSentError before
 *   a send, "unknown" after one). saveBrokerState: merges patch into order_requests.broker_state and resolves once
 *   it is stored (a no-op during a preview).
 * @typedef {{
 *   position: PositionState,
 *   referencePrice: number | null,
 *   quote: Quote | null,
 *   instrument: Instrument | null,
 *   estimate: Estimate,
 *   buyingPower?: number,
 *   marketOpen?: boolean,
 *   nextOpen?: string,
 *   warnings: OrderWarning[],
 *   notices: OrderNotice[],
 *   brokerState: Record<string, unknown>,
 * }} BrokerPreview
 *   referencePrice: the market price per share the limits are checked against, or null. It never comes from the
 *   user's own price (a what-if or preview estimate of a priced order uses that price).
 *   marketOpen: set by an adapter that asks the broker (Alpaca's clock); otherwise the core uses usRegularSession.
 *   brokerState: what placeOrder needs later (stored in order_requests.broker_state; never a secret).
 * @typedef {{
 *   ticket: Ticket,
 *   clientOrderId: string,
 *   previousClientOrderIds: string[],
 *   brokerState: Record<string, unknown>,
 *   acknowledged: string[],
 *   approvedMessages: ApprovedMessage[],
 *   position: PositionState,
 * }} PlaceInput
 *   previousClientOrderIds: ids of earlier attempts of this ticket (IBKR confirmation rounds), oldest first.
 *   acknowledged: notice keys of this row that the user confirmed (never more than the row's notices).
 *   approvedMessages: every broker message the user approved in a second dialog for this ticket (IBKR only).
 *   position: read by the core right before this call, inside the lock.
 * @typedef {{ id: string, role?: "entry" | "take_profit" | "stop_loss" }} BrokerOrderRef
 * @typedef {(
 *   { status: "placed", brokerOrderId: string, brokerOrderIds?: BrokerOrderRef[], messages?: BrokerMessage[], warnings?: OrderWarning[] }
 *   | { status: "rejected", error: string, code: string, messages?: BrokerMessage[] }
 *   | { status: "needs_confirmation", messages: BrokerMessage[], brokerState: Record<string, unknown> }
 *   | { status: "unknown", error: string }
 * )} PlaceOutcome
 *   needs_confirmation and rejected only when no order of this attempt is live at the broker.
 * @typedef {{ ticket: Ticket, clientOrderIds: string[], brokerState: Record<string, unknown>, sentAt: string | null }} ReconcileInput
 *   clientOrderIds: every attempt's id, the current one first.
 * @typedef {(
 *   { found: true, brokerOrderId: string, brokerOrderIds?: BrokerOrderRef[], rejected?: boolean }
 *   | { found: false, detail?: string }
 *   | { found: null, reason: string }
 * )} ReconcileOutcome
 *   found false: complete reads list no such order now, which never proves that it was not placed; detail is a
 *   sentence (E*TRADE: several candidates). found null: could not check now (session down, paced, rate limited,
 *   an incomplete list).
 * @typedef {{ status: "cancel_requested" | "cancelled", message: string }} CancelOutcome
 * @typedef {{
 *   capabilities: (connection: ConnectionRow, accounts: AccountRow[]) => CapabilityAnswer,
 *   previewOrder: (ctx: OrderCtx, ticket: Ticket, clientOrderId: string) => Promise<BrokerPreview>,
 *   positionState: (ctx: OrderCtx, ticket: Ticket, brokerState: Record<string, unknown>) => Promise<PositionState>,
 *   placeOrder: (ctx: OrderCtx, input: PlaceInput) => Promise<PlaceOutcome>,
 *   reconcileOrder: (ctx: OrderCtx, input: ReconcileInput) => Promise<ReconcileOutcome>,
 *   cancelOrder: (ctx: OrderCtx, brokerOrderId: string) => Promise<CancelOutcome>,
 * }} TradingAdapter
 *   accounts: every account row of the connection (included or not).
 */
