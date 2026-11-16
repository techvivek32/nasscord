import { cents, clean, maskAccountNumber, num, num0, reported, side, TYPE_LABEL } from "../mapping.mjs";
import { parseTime } from "../time.mjs";

/**
 * TradeStation API v3 answers -> Nasscord shapes (src/mapping.mjs has the shapes). Pure functions.
 *
 * - TradeStation sends money and quantities as JSON strings ("10234.56"); num() parses them. A value
 *   TradeStation did not send is left out, never sent as 0.
 * - external_id is TradeStation's AccountID. `accountId` in every answer is broker_accounts.id.
 * - Orders come from two lists: /orders (today's and open orders) and /historicalorders (closed
 *   orders since a date). The same order can be in both; it is kept once (the /orders copy, the
 *   newer one). Every leg is its own Order (multi-leg orders get ":<leg>" on the id).
 * - v3 has no fills, transactions or cash-activity endpoint, so executions come from order legs
 *   (ExecQuantity at ExecutionPrice). Dividends, deposits and fees are not available.
 *
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").OrderType} OrderType
 * @typedef {import("../mapping.mjs").OrderStatus} OrderStatus
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../db.mjs").Environment} Environment
 * @typedef {{ id: string, external_id: string }} AccountRef a broker_accounts row (id and AccountID)
 * @typedef {{ AccountID?: string, Error?: string, Message?: string }} TsError an Errors[] entry
 */

/** An AccountID as it may appear in a path: letters, digits, "_" and "-". */
export const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Account statuses that mean the account can no longer be read. */
const CLOSED = new Set(["CLOSED"]);

/** True when TradeStation lists the account as closed (it is left out of the account list). @param {any} a */
export const isAccountClosed = (a) => CLOSED.has(clean(a?.Status).toUpperCase());

/**
 * Paper (SIM) connection -> paper; Margin -> margin; Cash, Futures and DVP -> individual.
 * @param {any} a an Accounts[] entry
 * @param {Environment} environment
 * @returns {AccountType}
 */
export function tsAccountType(a, environment) {
  if (environment === "paper") return "paper";
  return clean(a?.AccountType).toUpperCase() === "MARGIN" ? "margin" : "individual";
}

/**
 * The account's kind in a label: "Margin", "Cash", "Futures", "DVP" (or Paper on SIM).
 * @param {any} a @param {Environment} environment
 */
function kindWord(a, environment) {
  if (environment === "paper") return TYPE_LABEL.paper;
  const t = clean(a?.AccountType).toUpperCase();
  if (t === "MARGIN") return "Margin";
  if (t === "CASH") return "Cash";
  if (t === "FUTURES") return "Futures";
  if (t === "DVP") return "DVP";
  return TYPE_LABEL.individual;
}

/**
 * An Accounts[] entry -> a broker_accounts row (without connection and workspace), or null for an
 * entry without a usable AccountID. A status other than Active ("Closing Transaction Only",
 * "Restricted", ...) is shown in the label, so the user sees why orders may be refused.
 * @param {any} a
 * @param {Environment} environment
 */
export function tsAccountRow(a, environment) {
  const id = clean(a?.AccountID);
  if (!ACCOUNT_ID.test(id)) return null;
  const alias = clean(a?.Alias).slice(0, 60);
  const status = clean(a?.Status);
  const base = alias || `TradeStation ${kindWord(a, environment)}`;
  const label = status && status.toUpperCase() !== "ACTIVE" ? `${base} (${status.slice(0, 60)})` : base;
  return {
    broker_id: /** @type {const} */ ("tradestation"),
    external_id: id,
    display_number: maskAccountNumber(id),
    label,
    type: tsAccountType(a, environment),
  };
}

/**
 * The open accounts of /v3/brokerage/accounts as broker_accounts rows (closed ones and entries
 * without an AccountID left out, duplicates kept once).
 * @param {any[]} list
 * @param {Environment} environment
 */
export function tsAccountRows(list, environment) {
  /** @type {Map<string, NonNullable<ReturnType<typeof tsAccountRow>>>} */
  const out = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (isAccountClosed(a)) continue;
    const row = tsAccountRow(a, environment);
    if (row && !out.has(row.external_id)) out.set(row.external_id, row);
  }
  return [...out.values()];
}

/**
 * A Balances[] entry -> account summary. Day P&L is TradeStation's TodaysProfitLoss; when it is
 * missing, the change in equity since the beginning of the day (BODBalances), when both exist.
 * @param {any} b
 * @param {AccountRef} account
 * @param {any} [bod] the account's BODBalances[] entry
 * @returns {AccountSummary}
 */
export function tsAccountSummary(b, account, bod) {
  const equity = num(b?.Equity);
  const bodEquity = num(bod?.BalanceDetail?.Equity) ?? num(bod?.Equity);
  const day = num(b?.TodaysProfitLoss) ?? (equity !== undefined && bodEquity !== undefined ? equity - bodEquity : undefined);
  return {
    accountId: account.id,
    ...reported({
      netLiq: equity,
      buyingPower: num(b?.BuyingPower),
      cash: num(b?.CashBalance),
      dayPnl: day,
    }),
    currency: clean(b?.Currency).toUpperCase() || "USD",
  };
}

/**
 * TradeStation AssetType -> secType. STOCK -> STK, STOCKOPTION and INDEXOPTION -> OPT, FUTURE -> FUT,
 * FUTUREOPTION -> FOP; anything else keeps TradeStation's word.
 * @param {unknown} raw
 */
export function tsSecType(raw) {
  const t = clean(/** @type {string} */ (raw)).toUpperCase().replace(/[\s_]/g, "");
  if (t === "STOCK" || t === "EQUITY") return "STK";
  if (t === "STOCKOPTION" || t === "INDEXOPTION" || t === "OPTION") return "OPT";
  if (t === "FUTURE" || t === "FUTURES") return "FUT";
  if (t === "FUTUREOPTION") return "FOP";
  if (t === "INDEX") return "IND";
  return t || "STK";
}

/**
 * A Positions[] entry -> Position. Quantity is signed by LongShort (TradeStation may send it
 * unsigned or already negative for a short).
 * @param {any} p
 * @param {AccountRef} account
 * @returns {Position}
 */
export function tsPosition(p, account) {
  const short = clean(p?.LongShort).toUpperCase() === "SHORT";
  const qty = Math.abs(num0(p?.Quantity)) * (short ? -1 : 1);
  const symbol = clean(p?.Symbol);
  /** @type {Position} */
  const out = {
    id: `tradestation:${account.id}:${clean(p?.PositionID) || symbol}`,
    accountId: account.id,
    brokerId: "tradestation",
    symbol,
    qty,
    currency: "USD",
    secType: tsSecType(p?.AssetType),
  };
  // A price or cost TradeStation did not send is left out, never shown as 0.
  const avg = num(p?.AveragePrice);
  if (avg !== undefined) out.avgCost = avg;
  const last = num(p?.Last) ?? num(p?.MarkToMarketPrice);
  if (last !== undefined) out.last = last;
  const day = num(p?.TodaysProfitLoss);
  if (day !== undefined) out.dayPnl = cents(day);
  const mv = num(p?.MarketValue);
  if (mv !== undefined) out.marketValue = cents(mv);
  const upl = num(p?.UnrealizedProfitLoss);
  if (upl !== undefined) out.unrealizedPnl = cents(upl);
  return out;
}

/** Status codes of a finished order that filled, was cancelled, or was rejected. */
const FILLED = new Set(["FLL"]);
const CANCELLED = new Set(["CAN", "EXP", "OUT", "UCH", "TSC", "FLP"]);
const REJECTED = new Set(["REJ", "BRO"]);
/** Codes of an order that is still live (sent, received, queued, partly filled, a cancel or replace in flight). */
const LIVE = ["OPN", "ACK", "DON", "FPR", "UCN", "RSN", "CND", "OSO", "SUS", "RJC", "RJR", "LAT", "STT", "STC"];

/**
 * TradeStation's order status code -> OrderStatus.
 * - FLL -> filled.
 * - CAN, EXP, OUT (UROut), UCH (replaced), TSC (trade server cancelled), FLP (partially filled, the
 *   rest out) -> cancelled; the filled part stays in filledQty and in executions.
 * - REJ, BRO -> rejected.
 * - OPN, ACK, DON, FPR, UCN and the other live codes (LAT: too late to cancel) -> working. An unknown code on an order that
 *   already has a ClosedDateTime counts as cancelled, so a closed order never shows as working.
 * @param {unknown} code
 * @param {boolean} [closed] the order has a ClosedDateTime
 * @returns {OrderStatus}
 */
export function tsOrderStatus(code, closed = false) {
  const s = clean(/** @type {string} */ (code)).toUpperCase();
  if (FILLED.has(s)) return "filled";
  if (CANCELLED.has(s)) return "cancelled";
  if (REJECTED.has(s)) return "rejected";
  if (closed && !LIVE.includes(s)) return "cancelled";
  return "working";
}

/**
 * TradeStation OrderType -> OrderType: Market -> MKT, Limit -> LMT, StopMarket and StopLimit -> STP,
 * a trailing stop -> TRAIL.
 * @param {unknown} raw
 * @param {boolean} hasPrice
 * @returns {OrderType}
 */
export function tsOrderType(raw, hasPrice) {
  const t = clean(/** @type {string} */ (raw)).toUpperCase().replace(/[\s_-]/g, "");
  if (t === "MARKET") return "MKT";
  if (t === "LIMIT") return "LMT";
  if (t.startsWith("TRAIL")) return "TRAIL";
  if (t === "STOPMARKET" || t === "STOPLIMIT" || t === "STOP") return "STP";
  return hasPrice ? "LMT" : "MKT";
}

/** Durations that stay until cancelled (Good Till Cancelled or Good Till Date, with or without "plus"). */
const GTC = new Set(["GTC", "GCP", "GTD", "GDP"]);
/** "Plus" durations also trade outside regular hours. */
const PLUS = new Set(["DYP", "GCP", "GDP"]);

/** @param {any} o @returns {any[]} */
const legsOf = (o) => (Array.isArray(o?.Legs) ? o.Legs : []);

/**
 * When the order was placed, as ISO; `fallback` when TradeStation sent no readable time.
 * @param {unknown} v @param {number} fallback
 */
function when(v, fallback) {
  const t = parseTime(clean(/** @type {string} */ (v)));
  return new Date(t ?? fallback).toISOString();
}

/**
 * One order of /orders or /historicalorders -> Order[] (one per leg).
 * @param {any} o
 * @param {AccountRef} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function tsOrder(o, account, fetchedAt) {
  const orderId = clean(o?.OrderID);
  if (!orderId) return [];
  const legs = legsOf(o);
  const limit = num(o?.LimitPrice);
  const stop = num(o?.StopPrice);
  const type = tsOrderType(o?.OrderType, limit !== undefined || stop !== undefined);
  const duration = clean(o?.Duration).toUpperCase();
  const closed = !!clean(o?.ClosedDateTime);
  const status = tsOrderStatus(o?.Status, closed);
  const trailPct = num(o?.AdvancedOptions?.TrailingStop?.Percent) ?? num(o?.TrailingStop?.Percent);
  const many = legs.length > 1;
  /** @type {Order[]} */
  const out = [];
  legs.forEach((/** @type {any} */ leg, /** @type {number} */ i) => {
    const qty = num(leg?.QuantityOrdered) ?? num0(leg?.ExecQuantity) + num0(leg?.QuantityRemaining);
    /** @type {Order} */
    const order = {
      id: `tradestation:${account.id}:${orderId}${many ? `:${i}` : ""}`,
      clientId: `tradestation-${orderId}`,
      accountId: account.id,
      brokerId: "tradestation",
      symbol: clean(leg?.Symbol),
      side: side(leg?.BuyOrSell),
      qty,
      type,
      tif: GTC.has(duration) ? "GTC" : "DAY",
      status,
      placedAt: when(o?.OpenedDateTime, fetchedAt),
      brokerRef: orderId,
    };
    const price = type === "STP" ? (stop ?? limit) : (limit ?? stop);
    if (price !== undefined && type !== "MKT" && type !== "TRAIL") order.price = price;
    if (type === "TRAIL" && trailPct !== undefined) order.trailPct = trailPct;
    const filled = num(leg?.ExecQuantity);
    if (filled !== undefined) order.filledQty = filled;
    const avg = num(leg?.ExecutionPrice) ?? (many ? undefined : num(o?.FilledPrice));
    if (avg !== undefined && avg > 0 && (filled ?? 0) > 0) order.avgFill = avg;
    if (duration) order.outsideRth = PLUS.has(duration);
    out.push(order);
  });
  return out;
}

/**
 * The account rows by TradeStation AccountID.
 * @param {AccountRef[]} accounts
 */
export const byExternalId = (accounts) => new Map(accounts.map((a) => [a.external_id, a]));

/**
 * /orders and /historicalorders merged: each order once (the /orders copy first, as it is the
 * newer), only for the accounts the read was given.
 * @param {any[]} current orders of /orders
 * @param {any[]} history orders of /historicalorders
 * @param {AccountRef[]} accounts
 * @returns {any[]} raw orders with an AccountID of `accounts`
 */
export function mergeOrders(current, history, accounts) {
  const known = byExternalId(accounts);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const out = [];
  for (const o of [...(Array.isArray(current) ? current : []), ...(Array.isArray(history) ? history : [])]) {
    const acct = clean(o?.AccountID);
    const id = clean(o?.OrderID);
    if (!id || !known.has(acct)) continue;
    const key = `${acct}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

/**
 * Merged raw orders -> Order[] (one per leg).
 * @param {any[]} merged mergeOrders()
 * @param {AccountRef[]} accounts
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function tsOrders(merged, accounts, fetchedAt) {
  const known = byExternalId(accounts);
  /** @type {Order[]} */
  const out = [];
  for (const o of merged) {
    const account = known.get(clean(o?.AccountID));
    if (account) out.push(...tsOrder(o, account, fetchedAt));
  }
  return out;
}

/** Asset types whose execution moves premium times 100 (equity and index options). */
const OPTION = new Set(["STOCKOPTION", "INDEXOPTION", "OPTION"]);
/** Asset types without a cash notional in the order answer (futures settle daily; no multiplier sent). */
const NO_NOTIONAL = new Set(["FUTURE", "FUTURES", "FUTUREOPTION"]);

/**
 * Executions from merged raw orders: one per leg that executed (ExecQuantity > 0), at that leg's
 * ExecutionPrice (or the order's FilledPrice for a one-leg order).
 * - commission: the order's CommissionFee, split evenly over its executed legs (cents; the first
 *   leg takes the rounding).
 * - tradedAt: ClosedDateTime for a finished order. A partial fill of an order that is still working
 *   has no fill time in the answer: OpenedDateTime is used and the execution is provisional.
 * - net: options count premium times 100. Futures and futures options carry no multiplier in the
 *   answer and settle through daily mark-to-market, so their net is the commission only.
 * @param {any[]} merged mergeOrders()
 * @param {AccountRef[]} accounts
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function tsExecutions(merged, accounts, fetchedAt) {
  const known = byExternalId(accounts);
  /** @type {Execution[]} */
  const out = [];
  for (const o of merged) {
    const account = known.get(clean(o?.AccountID));
    const orderId = clean(o?.OrderID);
    if (!account || !orderId) continue;
    const legs = legsOf(o);
    const many = legs.length > 1;
    const executed = legs
      .map((/** @type {any} */ leg, /** @type {number} */ i) => ({ leg, i, qty: Math.abs(num0(leg?.ExecQuantity)) }))
      .filter((x) => x.qty > 0);
    if (executed.length === 0) continue;
    const fee = Math.abs(num0(o?.CommissionFee));
    const share = cents(Math.floor((fee / executed.length) * 100) / 100);
    const first = cents(fee - share * (executed.length - 1));
    const closed = clean(o?.ClosedDateTime);
    const provisional = !closed;
    const tradedAt = when(closed || o?.OpenedDateTime, fetchedAt);
    executed.forEach(({ leg, i, qty }, n) => {
      const price = num(leg?.ExecutionPrice) ?? (many ? undefined : num(o?.FilledPrice)) ?? 0;
      if (!(price > 0)) return;
      const asset = clean(leg?.AssetType).toUpperCase().replace(/[\s_]/g, "");
      const s = side(leg?.BuyOrSell);
      const commission = n === 0 ? first : share;
      const gross = NO_NOTIONAL.has(asset) ? 0 : qty * price * (OPTION.has(asset) ? 100 : 1);
      /** @type {Execution} */
      const e = {
        id: `tradestation:${account.id}:${orderId}${many ? `:${i}` : ""}`,
        accountId: account.id,
        brokerId: "tradestation",
        symbol: clean(leg?.Symbol),
        side: s,
        qty,
        price,
        commission,
        net: cents(s === "BUY" ? -(gross + commission) : gross - commission),
        tradedAt,
      };
      if (provisional) e.provisional = true;
      out.push(e);
    });
  }
  return out;
}

/**
 * An Errors[] entry as a sentence for the user (TradeStation's own message is not shown: it can
 * carry more than the user needs). The account number is masked.
 * @param {TsError} e
 * @param {string} what "balances", "positions", "orders"
 */
export function errorSentence(e, what) {
  const id = clean(e?.AccountID);
  const code = clean(e?.Error);
  const acct = id ? ` of account ${maskAccountNumber(id)}` : "";
  const why = /^[A-Za-z][A-Za-z ]{0,39}$/.test(code) ? ` (${code})` : "";
  return `TradeStation could not send the ${what}${acct}${why}.`;
}
