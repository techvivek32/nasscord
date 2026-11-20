import { cents, clean, maskAccountNumber, num, num0, reported, side, TYPE_LABEL } from "../mapping.mjs";

/**
 * Alpaca Trading API v2 answers -> Nasscord shapes (src/mapping.mjs has the shapes). Pure functions.
 *
 * Alpaca sends every money and quantity field as a JSON string ("10234.56"); num() parses them. A
 * value Alpaca did not send is left out, never sent as 0. One key is one account, so every
 * connection has exactly one account: external_ref and external_id are both /v2/account `id`.
 *
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").OrderType} OrderType
 * @typedef {import("../mapping.mjs").OrderStatus} OrderStatus
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../db.mjs").Environment} Environment
 */

/** An OCC option symbol ("AAPL240119C00190000"): Alpaca's us_option symbols. */
const OCC = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;

/** True when Alpaca says the account is closed (it can no longer be read or connected). @param {any} a */
export const isAccountClosed = (a) => clean(a?.status).toUpperCase() === "ACCOUNT_CLOSED";

/**
 * Paper host or a Paper Only account -> paper; a multiplier above 1 -> margin; else individual.
 * @param {any} a /v2/account
 * @param {Environment} environment
 * @returns {AccountType}
 */
export function alpacaAccountType(a, environment) {
  if (environment === "paper" || clean(a?.status).toUpperCase() === "PAPER_ONLY") return "paper";
  return (num(a?.multiplier) ?? 1) > 1 ? "margin" : "individual";
}

/**
 * /v2/account -> the connection's one broker_accounts row (without connection and workspace).
 * @param {any} a
 * @param {Environment} environment
 */
export function alpacaAccountRow(a, environment) {
  const id = clean(a?.id);
  const type = alpacaAccountType(a, environment);
  return {
    broker_id: /** @type {const} */ ("alpaca"),
    external_id: id,
    display_number: maskAccountNumber(clean(a?.account_number) || id),
    label: `Alpaca ${TYPE_LABEL[type]}`,
    type,
  };
}

/**
 * /v2/account -> account summary. Day P&L is Alpaca's own equity minus last_equity (the equity at
 * the previous close), sent only when Alpaca reported both.
 * @param {any} a
 * @param {{ id: string }} account
 * @returns {AccountSummary}
 */
export function alpacaAccountSummary(a, account) {
  const equity = num(a?.equity);
  const lastEquity = num(a?.last_equity);
  return {
    accountId: account.id,
    ...reported({
      netLiq: equity ?? num(a?.portfolio_value),
      buyingPower: num(a?.buying_power),
      cash: num(a?.cash),
      dayPnl: equity !== undefined && lastEquity !== undefined ? equity - lastEquity : undefined,
    }),
    currency: clean(a?.currency).toUpperCase() || "USD",
  };
}

/**
 * Alpaca asset_class -> secType. us_equity -> STK, us_option -> OPT, crypto -> CRYPTO.
 * @param {unknown} assetClass
 * @param {unknown} [symbol] used when asset_class is missing
 */
export function alpacaSecType(assetClass, symbol) {
  const c = clean(/** @type {any} */ (assetClass)).toLowerCase();
  if (c === "us_equity") return "STK";
  if (c === "us_option") return "OPT";
  if (c === "crypto") return "CRYPTO";
  if (c) return c.toUpperCase();
  const s = clean(/** @type {any} */ (symbol)).toUpperCase();
  if (OCC.test(s)) return "OPT";
  if (s.includes("/")) return "CRYPTO";
  return "STK";
}

/**
 * One item of /v2/positions. A short position has a negative quantity.
 * @param {any} p
 * @param {{ id: string }} account
 * @returns {Position}
 */
export function alpacaPosition(p, account) {
  const symbol = clean(p?.symbol);
  const raw = num0(p?.qty);
  const dir = clean(p?.side).toLowerCase();
  const qty = dir === "short" ? -Math.abs(raw) : dir === "long" ? Math.abs(raw) : raw;
  const mv = num(p?.market_value);
  /** @type {Position} */
  const out = {
    id: `alpaca:${account.id}:${clean(p?.asset_id) || symbol}`,
    accountId: account.id,
    brokerId: "alpaca",
    symbol,
    qty,
    currency: "USD",
    secType: alpacaSecType(p?.asset_class, symbol),
  };
  // A price or cost Alpaca did not send is left out, never shown as 0.
  const avg = num(p?.avg_entry_price);
  if (avg !== undefined) out.avgCost = avg;
  const last = num(p?.current_price) ?? (qty && mv !== undefined ? mv / qty : undefined);
  if (last !== undefined) out.last = last;
  if (mv !== undefined) out.marketValue = cents(mv);
  const upl = num(p?.unrealized_pl);
  if (upl !== undefined) out.unrealizedPnl = cents(upl);
  const day = num(p?.unrealized_intraday_pl);
  if (day !== undefined) out.dayPnl = cents(day);
  return out;
}

/**
 * @param {unknown} raw Alpaca `type` / `order_type`
 * @returns {OrderType}
 */
export function alpacaOrderType(raw) {
  const t = clean(/** @type {any} */ (raw)).toLowerCase();
  if (t === "limit") return "LMT";
  if (t === "stop") return "STP";
  if (t === "stop_limit") return "STP_LMT";
  if (t === "trailing_stop") return "TRAIL";
  return "MKT";
}

/**
 * @param {unknown} raw Alpaca order status
 * @returns {OrderStatus}
 */
export function alpacaOrderStatus(raw) {
  const s = clean(/** @type {any} */ (raw)).toLowerCase();
  if (s === "new" || s === "accepted" || s === "pending_new") return "submitted";
  if (s === "filled") return "filled";
  if (s === "canceled" || s === "cancelled" || s === "expired" || s === "replaced") return "cancelled";
  // A cancel Alpaca has not confirmed yet: the order can still fill.
  if (s === "pending_cancel") return "cancel_requested";
  if (s === "rejected") return "rejected";
  // partially_filled, held (a bracket leg waiting), accepted_for_bidding, pending_replace,
  // calculated, stopped, suspended, and done_for_day (done for today, it works again next session)
  return "working";
}

/** The roles of the orders of a bracket (Alpaca's group_role). */
const LEG_ROLES = new Set(["entry", "take_profit", "stop_loss"]);

/**
 * The role of an order in a bracket: Alpaca's group_role when it names one, else for a leg under its
 * parent the type (the take-profit is a limit, the stop-loss a stop or stop limit).
 * @param {any} o
 * @param {OrderType} type
 * @param {boolean} isLeg
 * @returns {"entry" | "take_profit" | "stop_loss" | undefined}
 */
export function legRoleOf(o, type, isLeg) {
  const role = clean(o?.group_role).toLowerCase();
  if (LEG_ROLES.has(role)) return /** @type {"entry" | "take_profit" | "stop_loss"} */ (role);
  if (!isLeg) return undefined;
  if (type === "LMT") return "take_profit";
  if (type === "STP" || type === "STP_LMT") return "stop_loss";
  return undefined;
}

/** @param {unknown} v @param {number} fallback */
function isoOr(v, fallback) {
  const t = Date.parse(clean(/** @type {any} */ (v)));
  return new Date(Number.isFinite(t) ? t : fallback).toISOString();
}

/**
 * One Alpaca order (or one leg of a multi-leg order, with its parent's Nasscord id).
 * @param {any} o
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @param {string} [parentId]
 * @returns {Order}
 */
export function alpacaOrder(o, account, fetchedAt, parentId) {
  const brokerId = clean(o?.id);
  const type = alpacaOrderType(o?.type ?? o?.order_type);
  /** @type {Order} */
  const out = {
    id: `alpaca:${account.id}:${brokerId}`,
    clientId: clean(o?.client_order_id) || `alpaca-${brokerId}`,
    accountId: account.id,
    brokerId: "alpaca",
    symbol: clean(o?.symbol),
    side: side(o?.side),
    // A notional (dollar amount) order has no qty until it fills.
    qty: num(o?.qty) ?? num(o?.filled_qty) ?? 0,
    type,
    tif: clean(o?.time_in_force).toLowerCase() === "gtc" ? "GTC" : "DAY",
    status: alpacaOrderStatus(o?.status),
    placedAt: isoOr(o?.submitted_at || o?.created_at, fetchedAt),
    brokerRef: brokerId,
  };
  const limit = num(o?.limit_price);
  const stop = num(o?.stop_price);
  // price: the limit of LMT and STP_LMT orders, the stop of STP orders; stopPrice: the stop trigger.
  const price = type === "LMT" || type === "STP_LMT" ? limit : type === "STP" ? stop : undefined;
  if (price !== undefined) out.price = price;
  if ((type === "STP" || type === "STP_LMT") && stop !== undefined) out.stopPrice = stop;
  if (type === "TRAIL") {
    const pct = num(o?.trail_percent);
    if (pct !== undefined) out.trailPct = pct;
  }
  const filled = num(o?.filled_qty);
  if (filled !== undefined) out.filledQty = filled;
  const avg = num(o?.filled_avg_price);
  if (avg !== undefined && avg > 0) out.avgFill = avg;
  if (parentId) out.parentId = parentId;
  const role = legRoleOf(o, type, !!parentId);
  if (role) out.legRole = role;
  const expires = Date.parse(clean(o?.expires_at));
  if (Number.isFinite(expires)) out.expiresAt = new Date(expires).toISOString();
  if (typeof o?.extended_hours === "boolean") out.outsideRth = o.extended_hours;
  return out;
}

/**
 * Orders (with nested legs) -> one Order per order and per leg. The same order can arrive twice
 * (the open orders and the recent ones, or a leg on its own and under its parent); it is kept
 * once, and the copy that knows its parent wins.
 * @param {any[]} list
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function alpacaOrders(list, account, fetchedAt) {
  /** @type {Map<string, Order>} */
  const byId = new Map();
  /** @param {Order} o */
  const put = (o) => {
    const had = byId.get(o.id);
    if (!had || (!had.parentId && o.parentId)) byId.set(o.id, o);
  };
  for (const o of Array.isArray(list) ? list : []) {
    if (!clean(o?.id)) continue;
    const parent = alpacaOrder(o, account, fetchedAt);
    put(parent);
    for (const leg of Array.isArray(o.legs) ? o.legs : []) {
      if (clean(leg?.id)) put(alpacaOrder(leg, account, fetchedAt, parent.id));
    }
  }
  return [...byId.values()];
}

/**
 * One FILL activity (type "fill" or "partial_fill": each is its own execution with the quantity
 * of that fill). Alpaca charges no commission on API stock and option trades, but its regulatory
 * fees arrive later as separate FEE activities that are not matched to fills: commission is 0 and
 * the fill is provisional, so its net is never shown as final. Anything that is not a usable fill
 * is null (Alpaca adds activity types from time to time).
 * @param {any} a
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution | null}
 */
export function alpacaExecution(a, account, fetchedAt) {
  if (clean(a?.activity_type).toUpperCase() !== "FILL") return null;
  const id = clean(a?.id);
  const qty = Math.abs(num0(a?.qty));
  const price = num0(a?.price);
  if (!id || !(qty > 0) || !(price > 0)) return null;
  const symbol = clean(a?.symbol);
  const s = side(a?.side);
  const gross = qty * price * (OCC.test(symbol.toUpperCase()) ? 100 : 1);
  return {
    id: `alpaca:${account.id}:${id}`,
    accountId: account.id,
    brokerId: "alpaca",
    symbol,
    side: s,
    qty,
    price,
    commission: 0,
    net: cents(s === "BUY" ? -gross : gross),
    tradedAt: isoOr(a?.transaction_time, fetchedAt),
    provisional: true,
  };
}

/**
 * @param {any[]} list
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function alpacaExecutions(list, account, fetchedAt) {
  /** @type {Execution[]} */
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const e = alpacaExecution(a, account, fetchedAt);
    if (e) out.push(e);
  }
  return out;
}
