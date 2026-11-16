import { cents, clean, maskAccountNumber, num, num0, reported, side, TYPE_LABEL } from "../mapping.mjs";
import { etDateKey } from "../time.mjs";

/**
 * Webull Connect answers -> Nasscord shapes (src/mapping.mjs has the shapes). Pure functions.
 *
 * - Every product has its own account_id (stock, IRA, futures, crypto, event contracts). external_id
 *   is that id; the brokerage account number is kept only masked (display_number).
 * - Webull sends numbers as strings, and "" for a value it has not got (event-contract cash): such
 *   a value is left out, never sent as 0.
 * - Orders arrive in groups ({ combo_type, orders[] }); every order of a group is one Order. In a
 *   bracket, OTO or OTOCO group the orders after the master point at it (parentId).
 * - Executions: Webull's retail and Connect APIs have no fills endpoint. A fill is an order with a
 *   filled quantity, at its average fill price and last fill time. Its commission comes from the
 *   TRADE cash activity of the same symbol, side and trade date when exactly that can be matched;
 *   otherwise the fill is provisional with commission 0.
 */

/**
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").OrderType} OrderType
 * @typedef {import("../mapping.mjs").OrderStatus} OrderStatus
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {{ id: string, external_id: string }} AccountRef
 */

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
/** @param {unknown} v */
const upper = (v) => str(v).toUpperCase();
/** @param {unknown} v @returns {any[]} */
const list = (v) => (Array.isArray(v) ? v : []);

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * account_class (ROTH_IRA, TRADITIONAL_IRA, INDIVIDUAL_MARGIN, ...) and account_type (CASH, MARGIN).
 * @param {any} a
 * @returns {AccountType}
 */
export function webullAccountType(a) {
  const cls = upper(a?.account_class);
  const label = upper(a?.account_label);
  if (cls.includes("ROTH") || label.includes("ROTH")) return "roth";
  if (cls.endsWith("_IRA") || /\bIRA\b/.test(label)) return "ira";
  if (cls === "INDIVIDUAL_MARGIN" || upper(a?.account_type) === "MARGIN") return "margin";
  return "individual";
}

/**
 * GET /trading/accounts/list -> broker_accounts rows (without connection and workspace).
 * @param {unknown} body
 */
export function webullAccountRows(body) {
  /** @type {Map<string, { broker_id: "webull", external_id: string, display_number: string, label: string, type: AccountType }>} */
  const out = new Map();
  for (const a of list(Array.isArray(body) ? body : /** @type {any} */ (body)?.data)) {
    const id = str(a?.account_id);
    if (!ACCOUNT_ID.test(id) || out.has(id)) continue;
    const type = webullAccountType(a);
    const label = clean(a?.account_label) || `Webull ${TYPE_LABEL[type]}`;
    out.set(id, {
      broker_id: "webull",
      external_id: id,
      display_number: maskAccountNumber(str(a?.account_number) || id),
      label: label.slice(0, 80),
      type,
    });
  }
  return [...out.values()];
}

/**
 * GET /trading/assets/balances/get -> account summary. Buying power is the USD row's.
 * @param {any} b
 * @param {AccountRef} account
 * @returns {AccountSummary}
 */
export function webullAccountSummary(b, account) {
  const rows = list(b?.account_currency_assets);
  const usd = rows.find((r) => upper(r?.currency) === "USD") ?? rows[0] ?? null;
  return {
    accountId: account.id,
    ...reported({
      netLiq: num(b?.total_net_liquidation_value) ?? num(usd?.net_liquidation_value),
      buyingPower: num(usd?.buying_power),
      cash: num(b?.total_cash_balance) ?? num(usd?.cash_balance),
      dayPnl: num(b?.total_day_profit_loss) ?? num(usd?.day_profit_loss),
    }),
    currency: str(b?.total_asset_currency) || str(usd?.currency) || "USD",
  };
}

/** @type {Record<string, string>} */
const SEC_TYPE = { EQUITY: "STK", STOCK: "STK", OPTION: "OPT", FUTURES: "FUT", CRYPTO: "CRYPTO", EVENT: "EVENT" };

/** "IRON_CONDOR" -> "Iron Condor". @param {string} s */
const words = (s) =>
  s
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/**
 * An option leg as an OCC-style symbol ("AAPL 251121C00190000"), or "" when the leg lacks a part.
 * @param {string} underlying
 * @param {any} leg
 */
export function occSymbol(underlying, leg) {
  const root = upper(underlying).split(/\s+/)[0];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(leg?.option_expire_date));
  const type = upper(leg?.option_type);
  const strike = num(leg?.strike_price) ?? num(leg?.option_exercise_price);
  if (!root || !m || (type !== "CALL" && type !== "PUT") || strike === undefined) return "";
  return `${root} ${m[1].slice(2)}${m[2]}${m[3]}${type[0]}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/**
 * What a position or order is called: the ticker, an OCC symbol for a single option, the strategy
 * for a multi-leg one ("AAPL Vertical"), the outcome for an event contract ("FEDRATE Yes").
 * @param {any} x a position or an order
 * @returns {{ symbol: string, secType: string, multiplier: number | null }}
 */
export function webullInstrument(x) {
  const kind = upper(x?.instrument_type);
  const secType = SEC_TYPE[kind] ?? (kind || "STK");
  const symbol = upper(x?.symbol);
  const legs = list(x?.legs);
  if (secType === "OPT") {
    const strategy = upper(x?.option_strategy);
    const options = legs.filter((l) => upper(l?.option_type) === "CALL" || upper(l?.option_type) === "PUT");
    if (options.length === 1 && legs.length === 1 && (!strategy || strategy === "SINGLE")) {
      const occ = occSymbol(symbol || str(options[0]?.symbol), options[0]);
      if (occ) return { symbol: occ, secType, multiplier: num(options[0]?.option_contract_multiplier) ?? 100 };
    }
    const name = strategy && strategy !== "SINGLE" ? words(strategy) : "Option";
    return { symbol: `${symbol || upper(legs[0]?.symbol)} ${name}`.trim(), secType, multiplier: null };
  }
  if (secType === "EVENT") {
    const outcome = str(x?.event_outcome).toLowerCase();
    return { symbol: outcome ? `${symbol} ${outcome === "yes" ? "Yes" : "No"}` : symbol, secType, multiplier: null };
  }
  return { symbol, secType, multiplier: 1 };
}

/**
 * One item of GET /trading/assets/positions/list. Market value is quantity x last x multiplier for
 * stock, single options, futures and crypto; a multi-leg strategy or an event contract has none.
 * @param {any} p
 * @param {AccountRef} account
 * @returns {Position}
 */
export function webullPosition(p, account) {
  const { symbol, secType, multiplier } = webullInstrument(p);
  const qty = num0(p?.quantity);
  const last = num(p?.last_price);
  /** @type {Position} */
  const out = {
    id: `webull:${account.id}:${str(p?.position_id) || symbol}`,
    accountId: account.id,
    brokerId: "webull",
    symbol,
    qty,
    currency: str(p?.currency) || "USD",
    secType,
  };
  // A price or cost Webull did not send is left out, never shown as 0.
  const avg = num(p?.cost_price);
  if (avg !== undefined) out.avgCost = avg;
  if (last !== undefined) out.last = last;
  const unrealized = num(p?.unrealized_profit_loss);
  if (unrealized !== undefined) out.unrealizedPnl = cents(unrealized);
  if (multiplier !== null && last !== undefined) out.marketValue = cents(qty * last * multiplier);
  return out;
}

/** @param {unknown} body */
export function webullPositions(body, /** @type {AccountRef} */ account) {
  return list(Array.isArray(body) ? body : /** @type {any} */ (body)?.data)
    .map((p) => webullPosition(p, account))
    .filter((p) => p.symbol && p.qty !== 0);
}

/**
 * @param {unknown} raw
 * @returns {OrderStatus}
 */
export function webullOrderStatus(raw) {
  const s = upper(raw);
  if (s === "FILLED") return "filled";
  if (s === "CANCELLED" || s === "CANCELED" || s === "EXPIRED") return "cancelled";
  if (s === "FAILED" || s === "REJECTED") return "rejected";
  if (s === "PENDING") return "submitted";
  return "working";
}

/**
 * @param {unknown} raw
 * @param {boolean} hasLimit
 * @returns {OrderType}
 */
export function webullOrderType(raw, hasLimit) {
  const t = upper(raw);
  if (t.startsWith("TRAILING")) return "TRAIL";
  if (t.startsWith("STOP")) return "STP";
  if (t.startsWith("MARKET")) return "MKT";
  if (t.startsWith("LIMIT")) return "LMT";
  return hasLimit ? "LMT" : "MKT";
}

/**
 * Epoch milliseconds from an ISO field or a milliseconds field, or null.
 * @param {unknown} at ISO 8601 ("2025-11-11T05:44:35.385Z")
 * @param {unknown} ms
 */
function timeOf(at, ms) {
  const t = Date.parse(str(at).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isFinite(t)) return t;
  const n = num(ms);
  return n && n > 0 ? n : null;
}

/** @param {any} o @param {AccountRef} account */
const orderKey = (o, account) => `webull:${account.id}:${str(o?.order_id) || str(o?.client_order_id)}`;

/**
 * One order of a group.
 * @param {any} o
 * @param {AccountRef} account
 * @param {number} fetchedAt
 * @returns {Order}
 */
export function webullOrder(o, account, fetchedAt) {
  const limit = num(o?.limit_price);
  const stop = num(o?.stop_price);
  const type = webullOrderType(o?.order_type, limit !== undefined);
  const filled = num(o?.filled_quantity);
  const session = upper(o?.support_trading_session);
  /** @type {Order} */
  const out = {
    id: orderKey(o, account),
    clientId: str(o?.client_order_id) || `webull-${str(o?.order_id)}`,
    accountId: account.id,
    brokerId: "webull",
    symbol: webullInstrument(o).symbol,
    side: side(o?.side),
    qty: num(o?.total_quantity) ?? filled ?? 0,
    type,
    tif: upper(o?.time_in_force) === "GTC" ? "GTC" : "DAY",
    status: webullOrderStatus(o?.status),
    placedAt: new Date(timeOf(o?.place_time_at, o?.place_time) ?? fetchedAt).toISOString(),
  };
  const ref = str(o?.order_id);
  if (ref) out.brokerRef = ref;
  const price = type === "STP" ? (stop ?? limit) : type === "LMT" ? (limit ?? stop) : undefined;
  if (price !== undefined) out.price = price;
  if (type === "TRAIL" && upper(o?.trailing_type) === "PERCENTAGE" && num(o?.trailing_stop_step) !== undefined) out.trailPct = num0(o?.trailing_stop_step);
  if (filled !== undefined) out.filledQty = filled;
  const avg = num(o?.filled_price);
  if (avg !== undefined && avg > 0) out.avgFill = avg;
  if (session) out.outsideRth = session === "ALL" || session === "NIGHT";
  return out;
}

/**
 * Open and historical order groups of one account, merged (the open list wins: it is the fresher
 * one), each order once.
 * @param {any[]} open
 * @param {any[]} history
 * @returns {Array<{ order: any, group: any }>}
 */
export function mergeOrderGroups(open, history) {
  /** @type {Map<string, { order: any, group: any }>} */
  const byId = new Map();
  for (const group of [...list(open), ...list(history)]) {
    const orders = list(group?.orders);
    for (const order of orders.length ? orders : group && (group.order_id || group.client_order_id) ? [group] : []) {
      const key = str(order?.order_id) || str(order?.client_order_id);
      if (key && !byId.has(key)) byId.set(key, { order, group });
    }
  }
  return [...byId.values()];
}

/**
 * The master of a group, for parentId: an order marked MASTER, else the first order of a bracket,
 * OTO or OTOCO group. OCO and plain groups have none.
 * @param {any} group
 */
function masterOf(group) {
  const orders = list(group?.orders);
  if (orders.length < 2) return null;
  const marked = orders.find((o) => upper(o?.combo_type) === "MASTER");
  if (marked) return marked;
  return ["MASTER", "OTO", "OTOCO"].includes(upper(group?.combo_type)) ? orders[0] : null;
}

/**
 * Merged order entries -> Order[] (newest first).
 * @param {Array<{ order: any, group: any }>} entries
 * @param {AccountRef} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function webullOrders(entries, account, fetchedAt) {
  return entries
    .map(({ order, group }) => {
      const out = webullOrder(order, account, fetchedAt);
      const master = masterOf(group);
      if (master && master !== order) out.parentId = orderKey(master, account);
      return out;
    })
    .filter((o) => o.symbol)
    .sort((a, b) => b.placedAt.localeCompare(a.placedAt));
}

/**
 * Fills from merged order entries plus the account's TRADE cash activities.
 * @param {Array<{ order: any, group: any }>} entries
 * @param {any[] | null} activities null when the activities could not be read
 * @param {AccountRef} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function webullExecutions(entries, activities, account, fetchedAt) {
  /** @type {Array<{ act: any, used: boolean }>} */
  const pool = list(activities)
    .filter((a) => upper(a?.activity_type) === "TRADE" && num(a?.net_amount) !== undefined)
    .map((act) => ({ act, used: false }));
  /** @type {Execution[]} */
  const out = [];
  for (const { order } of entries) {
    const qty = num0(order?.filled_quantity);
    const price = num0(order?.filled_price);
    if (!(qty > 0) || !(price > 0)) continue;
    const { symbol, multiplier } = webullInstrument(order);
    if (!symbol) continue;
    const s = side(order?.side);
    const at = timeOf(order?.filled_time_at, order?.filled_time) ?? timeOf(order?.place_time_at, order?.place_time) ?? fetchedAt;
    const gross = qty * price * (multiplier ?? (upper(order?.instrument_type) === "OPTION" ? 100 : 1));
    const match = matchActivity(pool, { side: s, symbols: [symbol, upper(order?.symbol)], date: etDateKey(at), gross });
    const commission = match ? match.commission : 0;
    out.push({
      id: orderKey(order, account),
      accountId: account.id,
      brokerId: "webull",
      symbol,
      side: s,
      qty,
      price,
      commission: cents(commission),
      net: match ? cents(match.net) : cents(s === "BUY" ? -gross : gross),
      tradedAt: new Date(at).toISOString(),
      ...(match ? {} : { provisional: true }),
    });
  }
  return out.sort((a, b) => b.tradedAt.localeCompare(a.tradedAt));
}

/**
 * The unused TRADE activity of the same side, symbol and trade date whose amount implies the most
 * plausible commission (0 up to 5 % of the fill, at least 50 USD of room), or null.
 * @param {Array<{ act: any, used: boolean }>} pool
 * @param {{ side: "BUY" | "SELL", symbols: string[], date: string, gross: number }} fill
 */
function matchActivity(pool, fill) {
  let best = null;
  for (const entry of pool) {
    if (entry.used) continue;
    const a = entry.act;
    const sub = upper(a?.activity_sub_type);
    if (sub !== fill.side) continue;
    if (!fill.symbols.includes(upper(a?.symbol))) continue;
    if (str(a?.trade_date) !== fill.date) continue;
    const net = num0(a?.net_amount);
    const commission = fill.side === "BUY" ? -net - fill.gross : fill.gross - net;
    if (commission < -0.01 || commission > Math.max(fill.gross * 0.05, 50)) continue;
    if (!best || Math.abs(commission) < Math.abs(best.commission)) best = { entry, net, commission: Math.max(0, commission) };
  }
  if (!best) return null;
  best.entry.used = true;
  return { net: best.net, commission: best.commission };
}
