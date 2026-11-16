import { cents, clean, maskAccountNumber, num, num0, reported, side } from "../mapping.mjs";
import { sha256Hex } from "../oauth2.mjs";

/**
 * tastytrade answers -> Nasscord shapes (src/mapping.mjs lists the shapes). Pure functions only.
 *
 * tastytrade keys are kebab-case, decimals arrive as strings ("150.25"), and amounts that move
 * money come unsigned with an "-effect" of Credit, Debit or None. Lists come inside
 * { data: { items } }. `accountId` is always broker_accounts.id, never the account number.
 *
 * Personal data: GET /customers/me also answers names, the masked tax number and the birth date.
 * Only `external-id` (tastytrade's customer reference, the login's external_ref) is read from it.
 */

/**
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").OrderType} OrderType
 * @typedef {import("../mapping.mjs").OrderStatus} OrderStatus
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {{ id: string }} AccountRef
 * @typedef {{ broker_id: "tastytrade", external_id: string, display_number: string, label: string, type: AccountType }} TastytradeAccountRow
 */

/** The items of a { data: { items } } list answer, or []. @param {any} json @returns {any[]} */
export function itemsOf(json) {
  const items = json?.data?.items;
  return Array.isArray(items) ? items : [];
}

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/** OCC option symbols come padded ("SPY   261218C00600000"): one space between the parts. @param {unknown} v */
export const tastytradeSymbol = (v) => str(v).replace(/\s+/g, " ");

/**
 * An amount with its -effect: Credit is money in (+), Debit money out (-), None nothing.
 * Undefined when the amount is missing.
 * @param {unknown} value
 * @param {unknown} effect
 * @returns {number | undefined}
 */
export function signed(value, effect) {
  const n = num(value);
  if (n === undefined) return undefined;
  const e = str(effect).toLowerCase();
  if (e === "none") return 0;
  if (e === "debit") return -Math.abs(n);
  if (e === "credit") return Math.abs(n);
  return n;
}

/**
 * A fee with its -effect as a cost: Debit (charged) is +, Credit (a rebate) is -, None is 0.
 * @param {unknown} value
 * @param {unknown} effect
 */
function cost(value, effect) {
  const s = signed(value, effect);
  return s === undefined || s === 0 ? 0 : -s;
}

/** ISO time from a tastytrade timestamp, or the fallback instant. @param {unknown} v @param {number} fallback */
function time(v, fallback) {
  const t = Date.parse(str(v));
  return new Date(Number.isFinite(t) ? t : fallback).toISOString();
}

// ─────────────────────────────────────────────────────────────── login and accounts

/**
 * The login's external_ref from GET /customers/me: tastytrade's customer reference (`external-id`).
 * The API answers "me" as the customer's `id`, so that is never used. Null when it is missing.
 * @param {any} customer
 * @returns {string | null}
 */
export function tastytradeCustomerRef(customer) {
  const ref = str(customer?.["external-id"]);
  if (!ref || ref.length > 120 || /[\s\x00-\x1f]/.test(ref)) return null;
  return `cust:${ref}`;
}

/**
 * The fallback external_ref when tastytrade sent no customer reference: a hash of the sorted
 * account numbers (never the numbers themselves).
 * @param {string[]} numbers
 */
export function tastytradeAccountsRef(numbers) {
  const sorted = [...new Set(numbers.filter(Boolean))].sort();
  return sorted.length ? `h:${sha256Hex(["tastytrade", ...sorted].join("|"))}` : null;
}

/**
 * account-type-name and margin-or-cash -> Nasscord's account type. Roth before IRA ("Roth IRA").
 * @param {any} account
 * @returns {AccountType}
 */
export function tastytradeAccountType(account) {
  const name = str(account?.["account-type-name"]).toLowerCase();
  if (name.includes("roth")) return "roth";
  if (/\bira\b/.test(name)) return "ira";
  if (str(account?.["margin-or-cash"]).toLowerCase() === "margin") return "margin";
  return "individual";
}

/**
 * GET /customers/me/accounts items -> broker_accounts rows. Closed accounts are left out; accounts
 * the login only has read-only or trade-only authority over are listed as they are (they are
 * still the user's to see). Duplicates (never seen) keep the first.
 * @param {unknown} items
 * @returns {TastytradeAccountRow[]}
 */
export function tastytradeAccountRows(items) {
  /** @type {TastytradeAccountRow[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const a = item?.account ?? item;
    const number = str(a?.["account-number"]);
    if (!number || seen.has(number)) continue;
    if (a?.["is-closed"] === true || str(a?.["is-closed"]).toLowerCase() === "true") continue;
    seen.add(number);
    const typeName = str(a?.["account-type-name"]);
    out.push({
      broker_id: "tastytrade",
      external_id: number,
      display_number: maskAccountNumber(number),
      label: (str(a?.nickname) || typeName || "tastytrade account").slice(0, 80),
      type: tastytradeAccountType(a),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── balances and positions

/**
 * GET /accounts/{n}/balances data -> AccountSummary. Net liquidating value, cash balance and equity
 * buying power; the day's P&L is left out (the balances answer has none).
 * @param {any} b
 * @param {AccountRef} account
 * @returns {AccountSummary}
 */
export function tastytradeAccountSummary(b, account) {
  return {
    accountId: account.id,
    ...reported({
      netLiq: num(b?.["net-liquidating-value"]),
      buyingPower: num(b?.["equity-buying-power"]),
      cash: num(b?.["cash-balance"]),
    }),
    currency: str(b?.currency).toUpperCase() || "USD",
  };
}

/**
 * instrument-type -> secType. Equity -> STK, Equity Option -> OPT, Future -> FUT, Future Option
 * -> FOP, Cryptocurrency -> CRYPTO, Bond -> BOND; anything else keeps tastytrade's word.
 * @param {unknown} raw
 */
export function tastytradeSecType(raw) {
  const t = str(raw).toUpperCase().replace(/[\s_-]/g, "");
  if (t === "EQUITY" || t === "EQUITYOFFERING") return "STK";
  if (t === "EQUITYOPTION" || t === "INDEXOPTION") return "OPT";
  if (t === "FUTURE") return "FUT";
  if (t === "FUTUREOPTION") return "FOP";
  if (t === "CRYPTOCURRENCY") return "CRYPTO";
  if (t === "BOND") return "BOND";
  return t || "STK";
}

/** @param {number} n */
const price4 = (n) => Math.round(n * 10_000) / 10_000;

/**
 * The current mark of a position (include-marks=true), or undefined.
 * @param {any} p
 */
export const markOf = (p) => num(p?.["mark-price"]) ?? num(p?.mark);

/**
 * One positions item -> Position. qty is signed by quantity-direction; last is the mark, or
 * yesterday's close when tastytrade sent no mark (the caller names those symbols). Values use the
 * contract multiplier: unrealizedPnl = (last - average-open-price) x qty x multiplier, and dayPnl =
 * (mark - average-daily-market-close-price) x qty x multiplier, only with a real mark.
 * @param {any} p
 * @param {AccountRef} account
 * @returns {Position}
 */
export function tastytradePosition(p, account) {
  const short = str(p?.["quantity-direction"]).toLowerCase() === "short";
  const qty = Math.abs(num0(p?.quantity)) * (short ? -1 : 1);
  const symbol = tastytradeSymbol(p?.symbol);
  const multiplier = num(p?.multiplier) || 1;
  const mark = markOf(p);
  const close = num(p?.["close-price"]);
  const avgOpen = num(p?.["average-open-price"]);
  const last = mark ?? close;
  /** @type {Position} */
  const out = {
    id: `tastytrade:${account.id}:${symbol}`,
    accountId: account.id,
    brokerId: "tastytrade",
    symbol,
    qty,
    currency: "USD",
    secType: tastytradeSecType(p?.["instrument-type"]),
  };
  // A price or cost tastytrade did not send is left out, never shown as 0.
  if (avgOpen !== undefined) out.avgCost = avgOpen;
  if (last !== undefined) {
    out.last = price4(last);
    out.marketValue = cents(last * qty * multiplier);
    if (avgOpen !== undefined) out.unrealizedPnl = cents((last - avgOpen) * qty * multiplier);
  }
  const dayBase = num(p?.["average-daily-market-close-price"]) ?? close;
  if (mark !== undefined && dayBase !== undefined) out.dayPnl = cents((mark - dayBase) * qty * multiplier);
  return out;
}

// ─────────────────────────────────────────────────────────────── orders

/**
 * order-type -> OrderType. Limit, Marketable Limit and Liquidity Allocation -> LMT; Market and
 * Notional Market -> MKT; Stop and Stop Limit -> STP.
 * @param {unknown} raw
 * @param {boolean} hasPrice
 * @returns {OrderType}
 */
export function tastytradeOrderType(raw, hasPrice) {
  const t = str(raw).toUpperCase().replace(/[\s_-]/g, "");
  if (t === "MARKET" || t === "NOTIONALMARKET") return "MKT";
  if (t === "STOP" || t === "STOPLIMIT") return "STP";
  if (t === "LIMIT" || t === "MARKETABLELIMIT" || t === "LIQUIDITYALLOCATION") return "LMT";
  return hasPrice ? "LMT" : "MKT";
}

/**
 * status -> OrderStatus. Received, Routed, In Flight, Live, Contingent and the pending
 * cancel/replace states are still working; Filled; Cancelled, Expired and (Partially) Removed are
 * over; Rejected.
 * @param {unknown} raw
 * @returns {OrderStatus}
 */
export function tastytradeOrderStatus(raw) {
  const s = str(raw).toLowerCase().replace(/[\s_-]/g, "");
  if (s === "filled") return "filled";
  if (s === "cancelled" || s === "canceled" || s === "expired" || s === "removed" || s === "partiallyremoved") return "cancelled";
  if (s === "rejected") return "rejected";
  return "working";
}

/** @param {unknown} raw */
const tifOf = (raw) => (/^GT[CD]/.test(str(raw).toUpperCase()) ? "GTC" : "DAY");

/**
 * Merges order lists (/orders/live and the 30-day search) by id. When an order is in more than
 * one, the copy with the later updated-at wins (the first on a tie).
 * @param {...unknown} lists
 * @returns {any[]}
 */
export function mergeOrders(...lists) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const list of lists) {
    for (const o of Array.isArray(list) ? list : []) {
      const id = str(o?.id);
      if (!id) continue;
      const have = byId.get(id);
      if (!have || (Date.parse(str(o?.["updated-at"])) || 0) > (Date.parse(str(have?.["updated-at"])) || 0)) byId.set(id, o);
    }
  }
  return [...byId.values()];
}

/**
 * Orders -> Order[] (one per leg; a multi-leg order's legs get ":<leg>" on the id). The order's
 * price (a limit, or the stop trigger for stops) is on every leg, as tastytrade states it for the
 * whole order. filledQty and avgFill come from the leg's fills; tastytrade can show Filled before
 * every fill is processed, and the next read picks the rest up.
 * @param {unknown} list
 * @param {AccountRef} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function tastytradeOrders(list, account, fetchedAt) {
  /** @type {Order[]} */
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    const orderId = str(o?.id);
    const legs = Array.isArray(o?.legs) ? o.legs.filter((/** @type {any} */ l) => l && typeof l === "object") : [];
    if (!orderId || legs.length === 0) continue;
    const limit = num(o?.price);
    const stop = num(o?.["stop-trigger"]);
    const type = tastytradeOrderType(o?.["order-type"], limit !== undefined || stop !== undefined);
    const status = tastytradeOrderStatus(o?.status);
    const tifRaw = str(o?.["time-in-force"]).toUpperCase();
    const many = legs.length > 1;
    legs.forEach((/** @type {any} */ leg, /** @type {number} */ i) => {
      const qty = Math.abs(num(leg?.quantity) ?? (many ? 0 : num0(o?.size)));
      let filledQty = 0;
      let filledValue = 0;
      for (const f of Array.isArray(leg?.fills) ? leg.fills : []) {
        const fq = Math.abs(num0(f?.quantity));
        const fp = num(f?.["fill-price"]);
        if (fq <= 0 || fp === undefined) continue;
        filledQty += fq;
        filledValue += fq * fp;
      }
      /** @type {Order} */
      const order = {
        id: `tastytrade:${account.id}:${orderId}${many ? `:${i}` : ""}`,
        clientId: str(o?.["external-identifier"]) || `tastytrade-${orderId}`,
        accountId: account.id,
        brokerId: "tastytrade",
        symbol: tastytradeSymbol(leg?.symbol) || tastytradeSymbol(o?.["underlying-symbol"]),
        side: side(str(leg?.action)),
        qty,
        type,
        tif: tifOf(tifRaw),
        status,
        placedAt: time(o?.["received-at"] ?? o?.["updated-at"], fetchedAt),
        brokerRef: orderId,
      };
      const price = type === "STP" ? (stop ?? limit) : limit;
      if (price !== undefined && type !== "MKT") order.price = price;
      if (filledQty > 0) {
        order.filledQty = filledQty;
        order.avgFill = price4(filledValue / filledQty);
      } else {
        const remaining = num(leg?.["remaining-quantity"]);
        if (remaining !== undefined && qty >= Math.abs(remaining)) order.filledQty = qty - Math.abs(remaining);
      }
      if (tifRaw) order.outsideRth = tifRaw.includes("EXT");
      out.push(order);
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── executions

/**
 * Trade transactions -> Execution[]. Side from action ("Buy to Open" -> BUY), falling back to the
 * sub-type and then to value-effect (Debit = bought). commission = commission + clearing fees +
 * regulatory fees + proprietary index option fees + other charges + currency conversion fees, each
 * by its -effect (a rebate lowers it). net =
 * net-value by its effect (money in +, out -), or the value less the fees when it is missing.
 * Estimated fees mark the fill provisional.
 * @param {unknown} list
 * @param {AccountRef} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function tastytradeExecutions(list, account, fetchedAt) {
  /** @type {Execution[]} */
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    if (str(t?.["transaction-type"]).toLowerCase() !== "trade") continue;
    const id = str(t?.id);
    const qty = Math.abs(num0(t?.quantity));
    if (!id || qty === 0) continue;
    const word = str(t?.action) || str(t?.["transaction-sub-type"]);
    const s = word ? side(word) : str(t?.["value-effect"]).toLowerCase() === "debit" ? "BUY" : "SELL";
    const commission =
      cost(t?.commission, t?.["commission-effect"]) +
      cost(t?.["clearing-fees"], t?.["clearing-fees-effect"]) +
      cost(t?.["regulatory-fees"], t?.["regulatory-fees-effect"]) +
      cost(t?.["proprietary-index-option-fees"], t?.["proprietary-index-option-fees-effect"]) +
      cost(t?.["other-charge"], t?.["other-charge-effect"]) +
      cost(t?.["currency-conversion-fees"], t?.["currency-conversion-fees-effect"]);
    const value = signed(t?.value, t?.["value-effect"]);
    const net = signed(t?.["net-value"], t?.["net-value-effect"]) ?? (value !== undefined ? value - commission : undefined);
    /** @type {Execution} */
    const e = {
      id: `tastytrade:${account.id}:t:${id}`,
      accountId: account.id,
      brokerId: "tastytrade",
      symbol: tastytradeSymbol(t?.symbol) || tastytradeSymbol(t?.["underlying-symbol"]),
      side: s,
      qty,
      price: num0(t?.price),
      commission: cents(commission),
      net: cents(net ?? 0),
      tradedAt: time(t?.["executed-at"] ?? t?.["transaction-date"], fetchedAt),
    };
    if (t?.["is-estimated-fee"] === true) e.provisional = true;
    out.push(e);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── token errors

/**
 * tastytrade's token endpoint errors -> what the OAuth engine acts on. Errors come as
 * { error: { code, message } } (or a plain OAuth { error: "<code>" }).
 * - A code naming the client -> invalid_client; one naming the grant, code or token -> invalid_grant.
 * - Any other 401 counts as invalid_client: the engine expires the connection either way, and a
 *   401 that is really the client or a missing User-Agent must trip the circuit breaker before
 *   repeated failed logins get the service IP blocked (about 8 hours at tastytrade). A deleted grant
 *   is one such 401 per connection, and the connection then stops calling.
 * - Any other 4xx -> invalid_grant: the connection ends after one try and never loops on the
 *   token endpoint.
 * - 5xx and the rest -> other (the engine counts 5xx).
 * @param {number} status
 * @param {any} json
 * @returns {"invalid_grant" | "invalid_client" | "other"}
 */
export function tastytradeTokenError(status, json) {
  const raw = typeof json?.error === "string" ? json.error : typeof json?.error?.code === "string" ? json.error.code : "";
  const code = raw.toLowerCase();
  if (/client/.test(code)) return "invalid_client";
  if (/grant|code|token|revoked|expired/.test(code)) return "invalid_grant";
  if (status === 401) return "invalid_client";
  if (status >= 400 && status < 500 && status !== 429) return "invalid_grant";
  return "other";
}
