import { cents, clean, mapOrderType, maskAccountNumber, num, num0, reported, side, TYPE_LABEL } from "../mapping.mjs";

/**
 * Schwab Trader API answers -> Nasscord shapes (src/mapping.mjs has the shapes). Pure functions.
 *
 * - external_id of an account is its plain account number (shown masked); paths use the hashValue,
 *   which lives in the connection's sealed secret, never in the database.
 * - A value Schwab did not send is left out, never sent as 0.
 * - Orders: one Order per orderLegCollection leg; child orders (OCO, brackets) carry parentId.
 * - Executions: one per orderActivityCollection[].executionLegs entry. Commission is the fees of the
 *   order's TRADE transactions spread by quantity over the fills those transactions booked (in
 *   fill-time order); a fill not booked yet (or when the call failed) is provisional with
 *   commission 0. A TRADE transaction whose order gave no fills (a GTC order entered before the
 *   60-day order window) is an execution of its own.
 */

/**
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {{ nickName: string, type: string }} SchwabPref
 */

const HASH_SHAPE = /^[A-Za-z0-9]{1,128}$/;
/** Account numbers as Schwab sends them (digits; letters and dashes tolerated). */
const NUMBER_SHAPE = /^[A-Za-z0-9-]{1,40}$/;

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");

/**
 * /accounts/accountNumbers -> { accountNumber: hashValue }. Malformed entries are left out.
 * @param {unknown} list
 * @returns {Record<string, string>}
 */
export function schwabHashes(list) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const x of Array.isArray(list) ? list : []) {
    const n = str(x?.accountNumber);
    const h = str(x?.hashValue);
    if (NUMBER_SHAPE.test(n) && HASH_SHAPE.test(h)) out[n] = h;
  }
  return out;
}

/**
 * /userPreference -> nickname and type per account number. Everything else in the answer (streamer
 * ids, offers) is ignored and never stored.
 * @param {unknown} pref
 * @returns {Map<string, SchwabPref>}
 */
export function schwabPrefs(pref) {
  const root = /** @type {any} */ (Array.isArray(pref) ? pref[0] : pref);
  /** @type {Map<string, SchwabPref>} */
  const out = new Map();
  for (const a of Array.isArray(root?.accounts) ? root.accounts : []) {
    const n = str(a?.accountNumber);
    if (NUMBER_SHAPE.test(n)) out.set(n, { nickName: clean(a?.nickName).slice(0, 80), type: clean(a?.type) });
  }
  return out;
}

/**
 * MARGIN -> margin, CASH -> individual; a Roth or IRA nickname (or preference type) wins.
 * @param {any} sa securitiesAccount
 * @param {SchwabPref | undefined} pref
 * @returns {AccountType}
 */
export function schwabAccountType(sa, pref) {
  const text = `${pref?.type ?? ""} ${pref?.nickName ?? ""}`.toUpperCase();
  if (text.includes("ROTH")) return "roth";
  if (/\bIRA\b/.test(text)) return "ira";
  return str(sa?.type).toUpperCase() === "MARGIN" ? "margin" : "individual";
}

/**
 * GET /accounts (+ /userPreference) -> broker_accounts rows (without connection and workspace).
 * @param {unknown} accounts
 * @param {Map<string, SchwabPref>} prefs
 */
export function schwabAccountRows(accounts, prefs) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ broker_id: "schwab", external_id: string, display_number: string, label: string, type: AccountType }>} */
  const rows = [];
  for (const item of Array.isArray(accounts) ? accounts : []) {
    const sa = item?.securitiesAccount;
    const n = str(sa?.accountNumber);
    if (!NUMBER_SHAPE.test(n) || seen.has(n)) continue;
    seen.add(n);
    const pref = prefs.get(n);
    const type = schwabAccountType(sa, pref);
    // A nickname that is just the account number again says nothing (and is not masked).
    const nick = pref?.nickName && !pref.nickName.includes(n) ? pref.nickName : "";
    rows.push({
      broker_id: "schwab",
      external_id: n,
      display_number: maskAccountNumber(n),
      label: (nick || `Schwab ${TYPE_LABEL[type]}`).slice(0, 80),
      type,
    });
  }
  return rows;
}

/**
 * One item of GET /accounts?fields=positions -> account summary.
 * netLiq = liquidationValue; cash = cashBalance (or totalCash); buyingPower = buyingPower for a
 * margin account, cashAvailableForTrading for a cash account; dayPnl = the sum of the positions'
 * currentDayProfitLoss when Schwab sends it for at least one position.
 * @param {any} item
 * @param {{ id: string }} account
 * @returns {AccountSummary}
 */
export function schwabAccountSummary(item, account) {
  const sa = item?.securitiesAccount ?? {};
  const b = sa.currentBalances ?? {};
  const margin = str(sa.type).toUpperCase() === "MARGIN";
  /** @type {number | undefined} */
  let day;
  for (const p of Array.isArray(sa.positions) ? sa.positions : []) {
    const d = num(p?.currentDayProfitLoss);
    if (d !== undefined) day = (day ?? 0) + d;
  }
  return {
    accountId: account.id,
    ...reported({
      netLiq: num(b.liquidationValue) ?? num(item?.aggregatedBalance?.liquidationValue) ?? num(item?.aggregatedBalance?.currentLiquidationValue),
      buyingPower: margin ? (num(b.buyingPower) ?? num(b.availableFunds)) : (num(b.cashAvailableForTrading) ?? num(b.buyingPower)),
      cash: num(b.cashBalance) ?? num(b.totalCash),
      dayPnl: day,
    }),
    currency: "USD",
  };
}

/** @type {Record<string, string>} */
const SEC_TYPE = {
  EQUITY: "STK",
  COLLECTIVE_INVESTMENT: "STK",
  ETF: "STK",
  OPTION: "OPT",
  MUTUAL_FUND: "FUND",
  FIXED_INCOME: "BOND",
  CASH_EQUIVALENT: "CASH",
  CURRENCY: "CASH",
  FUTURE: "FUT",
  INDEX: "IND",
};

/** @param {unknown} assetType */
export function schwabSecType(assetType) {
  const t = str(assetType).toUpperCase();
  return SEC_TYPE[t] ?? (t || "STK");
}

/** Contract multiplier: 100 for options, else 1. @param {string} secType */
const multiplierOf = (secType) => (secType === "OPT" ? 100 : 1);

/** The instrument's symbol with OCC padding collapsed ("AAPL  240119C00150000" -> "AAPL 240119C00150000"). @param {any} inst */
function symbolOf(inst) {
  return str(inst?.symbol).replace(/\s+/g, " ") || str(inst?.cusip) || str(inst?.description).slice(0, 40);
}

/** @param {number} n */
const price4 = (n) => Math.round(n * 10_000) / 10_000;

/**
 * One securitiesAccount.positions[] item.
 * qty = longQuantity - shortQuantity; last = |marketValue| / (|qty| x multiplier).
 * @param {any} p
 * @param {{ id: string }} account
 * @returns {Position}
 */
export function schwabPosition(p, account) {
  const inst = p?.instrument ?? {};
  const assetType = str(inst.assetType).toUpperCase();
  const secType = schwabSecType(assetType);
  const qty = num0(p?.longQuantity) - num0(p?.shortQuantity);
  const mv = num(p?.marketValue);
  const symbol = symbolOf(inst);
  /** @type {Position} */
  const out = {
    id: `schwab:${account.id}:${assetType || "X"}:${str(inst.cusip) || symbol}`,
    accountId: account.id,
    brokerId: "schwab",
    symbol,
    qty,
    currency: "USD",
    secType,
  };
  // A price or cost Schwab did not send is left out, never shown as 0.
  const avg = num(p?.averagePrice) ?? num(qty < 0 ? p?.averageShortPrice : p?.averageLongPrice);
  if (avg !== undefined) out.avgCost = avg;
  if (mv !== undefined && qty !== 0) out.last = price4(Math.abs(mv) / (Math.abs(qty) * multiplierOf(secType)));
  if (mv !== undefined) out.marketValue = cents(mv);
  const open = num(qty < 0 ? p?.shortOpenProfitLoss : p?.longOpenProfitLoss);
  if (open !== undefined) out.unrealizedPnl = cents(open);
  const day = num(p?.currentDayProfitLoss);
  if (day !== undefined) out.dayPnl = cents(day);
  return out;
}

/**
 * @param {unknown} raw
 * @returns {import("../mapping.mjs").OrderStatus}
 */
export function schwabOrderStatus(raw) {
  const s = str(raw).toUpperCase();
  if (s === "FILLED") return "filled";
  if (s === "CANCELED" || s === "CANCELLED" || s === "EXPIRED" || s === "REPLACED") return "cancelled";
  if (s === "REJECTED") return "rejected";
  if (s === "NEW") return "submitted";
  // WORKING, QUEUED, ACCEPTED, PENDING_ACTIVATION, AWAITING_*, PENDING_CANCEL, PENDING_REPLACE, ...
  return "working";
}

/**
 * Schwab's "2024-03-28T14:30:15+0000" (or any ISO time) -> ISO; `fallback` (ms) when missing.
 * @param {unknown} raw
 * @param {number} fallback
 */
export function schwabTime(raw, fallback) {
  if (typeof raw === "string" && raw) {
    const t = Date.parse(raw.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const n = num(raw);
  if (n !== undefined && n > 1e11) return new Date(n).toISOString();
  return new Date(fallback).toISOString();
}

/** @param {any} o */
const legsOf = (o) => (Array.isArray(o?.orderLegCollection) ? o.orderLegCollection.filter((/** @type {any} */ l) => l && typeof l === "object") : []);
/** @param {any} leg @param {number} i */
const legKey = (leg, i) => str(leg?.legId) || String(i + 1);

/**
 * Every executionLegs entry of an order, with its activity.
 * @param {any} o
 * @returns {Array<{ activityId: string, legId: string, qty: number, price: number, time: unknown, index: number }>}
 */
function fillsOf(o) {
  /** @type {Array<{ activityId: string, legId: string, qty: number, price: number, time: unknown, index: number }>} */
  const out = [];
  const acts = Array.isArray(o?.orderActivityCollection) ? o.orderActivityCollection : [];
  acts.forEach((/** @type {any} */ act, /** @type {number} */ a) => {
    if (act?.activityType && str(act.activityType).toUpperCase() !== "EXECUTION") return;
    const legs = Array.isArray(act?.executionLegs) ? act.executionLegs : [];
    legs.forEach((/** @type {any} */ ex, /** @type {number} */ j) => {
      const qty = num(ex?.quantity);
      const price = num(ex?.price);
      if (qty === undefined || !(qty > 0) || price === undefined) return;
      out.push({ activityId: str(act?.activityId) || `a${a}`, legId: str(ex?.legId) || "1", qty, price, time: ex?.time, index: j });
    });
  });
  return out;
}

/**
 * Every order and its child orders (OCO, brackets), with the parent's Nasscord id.
 * @param {unknown} list
 * @param {string} accountId
 * @returns {Array<{ o: any, parentId: string | undefined }>}
 */
function flatten(list, accountId) {
  /** @type {Array<{ o: any, parentId: string | undefined }>} */
  const out = [];
  /** @param {any} o @param {string | undefined} parentId @param {number} depth */
  const walk = (o, parentId, depth) => {
    if (!o || typeof o !== "object" || depth > 8) return;
    out.push({ o, parentId });
    const orderId = str(o.orderId);
    const legs = legsOf(o);
    // A child points at the parent's first leg (an Order that exists), or further up when the
    // parent is only a container (OCO) without legs of its own.
    const self = orderId && legs.length ? `schwab:${accountId}:${orderId}${legs.length > 1 ? ":0" : ""}` : parentId;
    for (const child of Array.isArray(o.childOrderStrategies) ? o.childOrderStrategies : []) walk(child, self, depth + 1);
  };
  for (const o of Array.isArray(list) ? list : []) walk(o, undefined, 0);
  return out;
}

/**
 * GET /accounts/{hash}/orders -> Order[] (one per leg; multi-leg orders get ":<leg>" on the id).
 * @param {unknown} list
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function schwabOrders(list, account, fetchedAt) {
  /** @type {Order[]} */
  const out = [];
  for (const { o, parentId } of flatten(list, account.id)) {
    const orderId = str(o.orderId);
    const legs = legsOf(o);
    if (!orderId || legs.length === 0) continue;
    const limit = num(o.price);
    const stop = num(o.stopPrice);
    const type = mapOrderType(str(o.orderType), limit !== undefined || stop !== undefined);
    const status = schwabOrderStatus(o.status);
    const session = str(o.session).toUpperCase();
    /** @type {Map<string, { qty: number, value: number }>} */
    const filled = new Map();
    for (const f of fillsOf(o)) {
      const cur = filled.get(f.legId) ?? { qty: 0, value: 0 };
      cur.qty += f.qty;
      cur.value += f.qty * f.price;
      filled.set(f.legId, cur);
    }
    legs.forEach((/** @type {any} */ leg, /** @type {number} */ i) => {
      const qty = num(leg.quantity) ?? num0(o.quantity);
      /** @type {Order} */
      const order = {
        id: `schwab:${account.id}:${orderId}${legs.length > 1 ? `:${i}` : ""}`,
        clientId: `schwab-${orderId}`,
        accountId: account.id,
        brokerId: "schwab",
        symbol: symbolOf(leg.instrument),
        side: side(str(leg.instruction)),
        qty,
        type,
        tif: str(o.duration).toUpperCase() === "GOOD_TILL_CANCEL" ? "GTC" : "DAY",
        status,
        placedAt: schwabTime(o.enteredTime, fetchedAt),
        brokerRef: orderId,
      };
      const price = type === "STP" ? (stop ?? limit) : (limit ?? stop);
      if (price !== undefined && type !== "MKT" && type !== "TRAIL") order.price = price;
      if (type === "TRAIL" && str(o.stopPriceLinkType).toUpperCase() === "PERCENT" && num(o.stopPriceOffset) !== undefined) {
        order.trailPct = num0(o.stopPriceOffset);
      }
      const f = filled.get(legKey(leg, i));
      const filledQty = legs.length === 1 ? (num(o.filledQuantity) ?? f?.qty) : f?.qty;
      if (filledQty !== undefined) order.filledQty = filledQty;
      if (f && f.qty > 0) order.avgFill = price4(f.value / f.qty);
      if (parentId) order.parentId = parentId;
      if (session) order.outsideRth = session !== "NORMAL";
      out.push(order);
    });
  }
  return out;
}

/** A TRADE transaction (Schwab is asked for TRADE only; an untyped one counts). @param {any} t */
const isTrade = (t) => !!t && typeof t === "object" && (!t.type || str(t.type).toUpperCase() === "TRADE");

/** The fees of one transaction: the |cost| of every transfer item with a feeType. @param {any} t */
function feesOf(t) {
  let fee = 0;
  for (const item of Array.isArray(t?.transferItems) ? t.transferItems : []) {
    if (item?.feeType) fee += Math.abs(num0(item.cost));
  }
  return fee;
}

/**
 * The traded items of one transaction: transfer items with an instrument that is not cash, no
 * feeType and a non-zero amount (shares or contracts).
 * @param {any} t
 * @returns {any[]}
 */
function tradedItemsOf(t) {
  return (Array.isArray(t?.transferItems) ? t.transferItems : []).filter(
    (/** @type {any} */ item) =>
      item &&
      !item.feeType &&
      item.instrument &&
      typeof item.instrument === "object" &&
      str(item.instrument.assetType).toUpperCase() !== "CURRENCY" &&
      num(item.amount) !== undefined &&
      num(item.amount) !== 0,
  );
}

/**
 * What the TRADE transactions booked per order id: the fees (the |cost| of every transfer item with
 * a feeType: commission, SEC fee, TAF, option regulatory fee) and the quantity (the |amount| of the
 * traded items; undefined when no transaction of the order carries a traded item).
 * @param {unknown} transactions
 * @returns {Map<string, { fee: number, qty: number | undefined }>}
 */
export function schwabBookedByOrder(transactions) {
  /** @type {Map<string, { fee: number, qty: number | undefined }>} */
  const out = new Map();
  for (const t of Array.isArray(transactions) ? transactions : []) {
    if (!isTrade(t)) continue;
    const orderId = str(t.orderId);
    if (!orderId) continue;
    const cur = out.get(orderId) ?? { fee: 0, qty: undefined };
    cur.fee += feesOf(t);
    const items = tradedItemsOf(t);
    if (items.length > 0) cur.qty = (cur.qty ?? 0) + items.reduce((n, item) => n + Math.abs(num0(item.amount)), 0);
    out.set(orderId, cur);
  }
  return out;
}

/**
 * Fees per order id from TRADE transactions (schwabBookedByOrder without the quantity).
 * @param {unknown} transactions
 * @returns {Map<string, number>}
 */
export function schwabFeesByOrder(transactions) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [orderId, b] of schwabBookedByOrder(transactions)) out.set(orderId, b.fee);
  return out;
}

/** Epoch ms of a Schwab time, or undefined. @param {unknown} raw */
function timeMs(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  const t = Date.parse(raw.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isFinite(t) ? t : undefined;
}

/** Leaves floating-point dust out of quantity sums. */
const QTY_EPSILON = 1e-6;

/**
 * Orders (+ TRADE transactions) -> Execution[].
 *
 * - One per orderActivityCollection[].executionLegs entry. The order's booked quantity is matched to
 *   its fills in fill-time order: the fills it covers share the booked fees by quantity; a fill not
 *   booked yet (a GTC order that fills again the next day, an execution Schwab has not booked) is
 *   provisional with commission 0, so a fill shown as final never changes its commission. With no
 *   TRADE transaction for the order (or when the call failed) every fill is provisional; fees whose
 *   transactions carry no traded item to count are shared by every fill, all provisional.
 * - One per traded item of a TRADE transaction whose order gave no fills here (a GTC order entered
 *   before the 60-day order window, or an order sent without execution legs): booked, so final.
 * @param {unknown} orders raw orders of one account
 * @param {unknown} transactions raw TRADE transactions of the same account, or null when not available
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function schwabExecutions(orders, transactions, account, fetchedAt) {
  const booked = transactions === null ? new Map() : schwabBookedByOrder(transactions);
  /** @type {Execution[]} */
  const out = [];
  /** @type {Set<string>} orders whose fills came from their execution legs */
  const filledHere = new Set();
  for (const { o } of flatten(orders, account.id)) {
    const orderId = str(o.orderId);
    const legs = legsOf(o);
    const fills = fillsOf(o);
    if (!orderId || fills.length === 0) continue;
    filledHere.add(orderId);
    /** @type {Map<string, any>} */
    const legById = new Map(legs.map((/** @type {any} */ l, /** @type {number} */ i) => [legKey(l, i), l]));
    const b = booked.get(orderId);
    /** @type {Set<number>} the fills the booked quantity covers, earliest first (a fill without a time sorts last) */
    const covered = new Set();
    if (b && b.qty === undefined) {
      // Fees without a traded item to count: all fills share them, and none is known to be booked
      // in full, so every one stays provisional.
      fills.forEach((_, i) => covered.add(i));
    } else if (b) {
      let left = b.qty ?? 0;
      const byTime = fills.map((f, i) => ({ i, t: timeMs(f.time) ?? Number.POSITIVE_INFINITY })).sort((x, y) => x.t - y.t || x.i - y.i);
      for (const { i } of byTime) {
        if (left + QTY_EPSILON < fills[i].qty) break;
        covered.add(i);
        left -= fills[i].qty;
      }
    }
    const coveredQty = fills.reduce((n, f, i) => (covered.has(i) ? n + f.qty : n), 0);
    fills.forEach((f, i) => {
      const leg = legById.get(f.legId) ?? legs[0] ?? {};
      const secType = schwabSecType(leg?.instrument?.assetType);
      const s = side(str(leg?.instruction));
      const share = b !== undefined && covered.has(i) && coveredQty > 0;
      const commission = share ? (b.fee * f.qty) / coveredQty : 0;
      const final = share && b.qty !== undefined;
      const gross = f.qty * f.price * multiplierOf(secType);
      /** @type {Execution} */
      const ex = {
        id: `schwab:${account.id}:${orderId}:${f.activityId}:${f.legId}:${f.index}`,
        accountId: account.id,
        brokerId: "schwab",
        symbol: symbolOf(leg?.instrument),
        side: s,
        qty: f.qty,
        price: f.price,
        commission: cents(commission),
        net: cents(s === "BUY" ? -(gross + commission) : gross - commission),
        tradedAt: schwabTime(f.time ?? o.closeTime ?? o.enteredTime, fetchedAt),
      };
      if (!final) ex.provisional = true;
      out.push(ex);
    });
  }
  if (transactions !== null) out.push(...bookedOnly(transactions, filledHere, account, fetchedAt));
  return out;
}

/**
 * TRADE transactions of orders that gave no fills from their execution legs -> one Execution per
 * traded item; the transaction's fees are shared by its items by quantity. The id names the
 * transaction (activityId), or its place among the order's transactions when Schwab sent none.
 * @param {unknown} transactions
 * @param {Set<string>} skip order ids whose fills are already listed
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
function bookedOnly(transactions, skip, account, fetchedAt) {
  /** @type {Execution[]} */
  const out = [];
  /** @type {Map<string, number>} transactions seen per order id (for ids without an activityId) */
  const seen = new Map();
  for (const t of Array.isArray(transactions) ? transactions : []) {
    if (!isTrade(t)) continue;
    const orderId = str(t.orderId);
    if (orderId && skip.has(orderId)) continue;
    const k = seen.get(orderId) ?? 0;
    seen.set(orderId, k + 1);
    const txId = str(t.activityId);
    // Without an order id or an activityId nothing names the fill the same way on the next read.
    if (!orderId && !txId) continue;
    const items = tradedItemsOf(t);
    const totalQty = items.reduce((n, item) => n + Math.abs(num0(item.amount)), 0);
    const fee = feesOf(t);
    items.forEach((/** @type {any} */ item, /** @type {number} */ i) => {
      const amount = num0(item.amount);
      const qty = Math.abs(amount);
      const secType = schwabSecType(item.instrument.assetType);
      const cost = num(item.cost);
      const price = num(item.price) ?? (cost !== undefined ? price4(Math.abs(cost) / (qty * multiplierOf(secType))) : undefined);
      if (price === undefined) return;
      // Money out is a buy (cost < 0); without a cost, a positive amount is a buy.
      const s = cost !== undefined && cost !== 0 ? (cost < 0 ? "BUY" : "SELL") : amount > 0 ? "BUY" : "SELL";
      const commission = totalQty > 0 ? (fee * qty) / totalQty : 0;
      const gross = qty * price * multiplierOf(secType);
      out.push({
        id: `schwab:${account.id}:${orderId || "-"}:tx${txId || `#${k}`}:${i}`,
        accountId: account.id,
        brokerId: "schwab",
        symbol: symbolOf(item.instrument),
        side: s,
        qty,
        price,
        commission: cents(commission),
        net: cents(s === "BUY" ? -(gross + commission) : gross - commission),
        tradedAt: schwabTime(t.time ?? t.tradeDate, fetchedAt),
      });
    });
  }
  return out;
}
