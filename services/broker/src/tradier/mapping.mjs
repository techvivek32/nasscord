import { createHash } from "node:crypto";
import { badGateway } from "../errors.mjs";
import { cents, clean, maskAccountNumber, num, num0, reported, side, TYPE_LABEL } from "../mapping.mjs";
import { etToUtc } from "../time.mjs";

/**
 * Tradier Brokerage API answers -> Nasscord shapes (src/mapping.mjs has the shapes). Pure functions.
 *
 * Tradier's JSON is translated from XML, so every collection can arrive three ways: an array, a bare
 * object when it holds one item, and the string "null" (or null) when it is empty. collection()
 * turns all three into an array; nothing below reads a Tradier list without it.
 *
 * - Accounts come from /v1/user/profile (one login, several accounts). external_id is the account
 *   number; closed accounts are left out. The login's identity (external_ref) is the profile id.
 * - Positions carry no price: they are valued from /v1/markets/quotes (last, else the previous
 *   close). A position Tradier sent no price for keeps its quantity and cost, and no market value.
 * - Orders: /orders holds today's session only. One Order per order, or per leg of a multileg,
 *   combo, OCO, OTO or OTOCO order.
 * - Executions: today's fills from those orders (exact time, commission unknown: provisional), and
 *   earlier fills from /history type=trade, which carries a date only (provisional too).
 * A value Tradier did not send is left out, never sent as 0.
 *
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").OrderType} OrderType
 * @typedef {import("../mapping.mjs").OrderStatus} OrderStatus
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../db.mjs").Environment} Environment
 * @typedef {{ price: number | undefined, multiplier: number }} Quote
 */

/** An OCC option symbol ("SPY261218C00600000"), as Tradier writes option positions and legs. */
export const OCC = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;

const unreadable = () => badGateway("Tradier sent a reply Nasscord could not read.", "broker_reply");

/**
 * One Tradier collection as an array: an array stays, one bare object becomes [object], and the
 * empty forms ("null", null, undefined, "") become [].
 * @param {unknown} v
 * @returns {any[]}
 */
export function listOf(v) {
  if (v === undefined || v === null || v === "" || v === "null") return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && x !== "null");
  if (typeof v === "object") return [v];
  return [];
}

/**
 * The items of a wrapped collection: `{ positions: { position: X } }` -> collection(json, "positions", "position").
 * The wrapper itself must be there (an answer without it is not a Tradier answer); inside it, an
 * empty collection is "null" or missing.
 * @param {any} json
 * @param {string} wrapper
 * @param {string} item
 * @returns {any[]}
 */
export function collection(json, wrapper, item) {
  if (!json || typeof json !== "object" || Array.isArray(json) || !(wrapper in json)) throw unreadable();
  const inner = json[wrapper];
  if (inner === null || inner === undefined || inner === "" || inner === "null") return [];
  if (typeof inner !== "object" || Array.isArray(inner)) throw unreadable();
  return listOf(inner[item]);
}

/** @param {unknown} v a number or a string id */
const idText = (v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : clean(/** @type {any} */ (v)));

// ─────────────────────────────────────────────────────────────── accounts

/**
 * The profile object of /v1/user/profile ({ id, name, account }).
 * @param {any} json
 */
export function tradierProfile(json) {
  const p = json?.profile;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw unreadable();
  return p;
}

/** The login's identity: Tradier's profile id ("id-..."), or null. @param {any} profile */
export function tradierProfileId(profile) {
  const id = idText(profile?.id);
  return id && id.length <= 190 ? id : null;
}

/** @param {any} a one profile account */
export const isOpenAccount = (a) => !!idText(a?.account_number) && clean(a?.status).toLowerCase() !== "closed";

/**
 * Sandbox (paper) -> paper; a Roth IRA -> roth; any other IRA -> ira; a margin account -> margin;
 * else individual.
 * @param {any} a one profile account
 * @param {Environment} environment
 * @returns {AccountType}
 */
export function tradierAccountType(a, environment) {
  if (environment === "paper" || environment === "sandbox") return "paper";
  const c = clean(a?.classification).toLowerCase();
  if (c.includes("roth")) return "roth";
  if (/(^|_)ira$|(^|_)ira_|sep|simple/.test(c)) return "ira";
  if (clean(a?.type).toLowerCase() === "margin") return "margin";
  return "individual";
}

/**
 * The open accounts of a profile as broker_accounts rows (without connection and workspace).
 * @param {any} profile tradierProfile()
 * @param {Environment} environment
 */
export function tradierAccountRows(profile, environment) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ broker_id: "tradier", external_id: string, display_number: string, label: string, type: AccountType }>} */
  const out = [];
  for (const a of listOf(profile?.account)) {
    if (!isOpenAccount(a)) continue;
    const number = idText(a.account_number);
    if (!/^[A-Za-z0-9]{1,32}$/.test(number) || seen.has(number)) continue;
    seen.add(number);
    const type = tradierAccountType(a, environment);
    out.push({ broker_id: "tradier", external_id: number, display_number: maskAccountNumber(number), label: `Tradier ${TYPE_LABEL[type]}`, type });
  }
  return out;
}

/**
 * /v1/accounts/{id}/balances -> account summary. Buying power by account type: margin
 * (stock_buying_power), cash (cash_available) or pdt (stock_buying_power). Tradier reports no day
 * P&L in balances, so it is left out.
 * @param {any} json
 * @param {{ id: string }} account
 * @returns {AccountSummary}
 */
export function tradierAccountSummary(json, account) {
  const b = json?.balances;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unreadable();
  const kind = clean(b.account_type).toLowerCase();
  const margin = num(b.margin?.stock_buying_power);
  const cash = num(b.cash?.cash_available);
  const pdt = num(b.pdt?.stock_buying_power);
  const buyingPower = kind === "cash" ? (cash ?? margin ?? pdt) : kind === "pdt" ? (pdt ?? margin ?? cash) : (margin ?? pdt ?? cash);
  return {
    accountId: account.id,
    ...reported({ netLiq: num(b.total_equity), cash: num(b.total_cash), buyingPower }),
    currency: "USD",
  };
}

// ─────────────────────────────────────────────────────────────── positions

/**
 * /v1/markets/quotes items -> symbol -> { price, multiplier }. The price is the last trade, else the
 * previous close (both Tradier's own); a quote with neither has no price.
 * @param {any[]} quotes
 * @returns {Map<string, Quote>}
 */
export function tradierQuoteMap(quotes) {
  /** @type {Map<string, Quote>} */
  const out = new Map();
  for (const q of listOf(quotes)) {
    const symbol = clean(q?.symbol).toUpperCase();
    if (!symbol) continue;
    const price = [num(q.last), num(q.prevclose), num(q.close)].find((v) => v !== undefined && v > 0);
    const size = num(q.contract_size);
    out.set(symbol, { price, multiplier: size && size > 0 ? size : OCC.test(symbol) ? 100 : 1 });
  }
  return out;
}

/** @param {number} n */
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * One item of /positions, valued with its quote. A short position has a negative quantity; its
 * cost basis is the (negative) proceeds, so unrealized P&L is market value minus cost basis for
 * both sides. Without a price the position keeps its quantity and average cost, and no last
 * price, market value or P&L is sent (the read reports the missing price).
 * @param {any} p
 * @param {{ id: string }} account
 * @param {Quote | undefined} quote
 * @returns {Position}
 */
export function tradierPosition(p, account, quote) {
  const symbol = clean(p?.symbol).toUpperCase();
  const qty = num0(p?.quantity);
  const option = OCC.test(symbol);
  const multiplier = quote?.multiplier ?? (option ? 100 : 1);
  const cost = num(p?.cost_basis);
  /** @type {Position} */
  const out = {
    id: `tradier:${account.id}:${idText(p?.id) || symbol}`,
    accountId: account.id,
    brokerId: "tradier",
    symbol,
    qty,
    currency: "USD",
    secType: option ? "OPT" : "STK",
  };
  // A price or cost Tradier did not send is left out, never shown as 0.
  if (cost !== undefined && qty) out.avgCost = round6(Math.abs(cost) / Math.abs(qty) / multiplier);
  if (quote?.price !== undefined) {
    out.last = quote.price;
    const mv = quote.price * qty * multiplier;
    out.marketValue = cents(mv);
    if (cost !== undefined) out.unrealizedPnl = cents(mv - (qty < 0 ? -Math.abs(cost) : Math.abs(cost)));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── orders

/**
 * pending -> submitted; open, partially_filled (and anything still alive) -> working; filled;
 * canceled, expired, pending_cancel -> cancelled; rejected, error -> rejected.
 * @param {unknown} raw
 * @returns {OrderStatus}
 */
export function tradierOrderStatus(raw) {
  const s = clean(/** @type {any} */ (raw)).toLowerCase();
  if (s === "pending") return "submitted";
  if (s === "filled") return "filled";
  if (s === "canceled" || s === "cancelled" || s === "expired" || s === "pending_cancel") return "cancelled";
  if (s === "rejected" || s === "error") return "rejected";
  return "working";
}

/**
 * market -> MKT; limit and the multileg net prices (debit, credit, even) -> LMT; stop and
 * stop_limit -> STP.
 * @param {unknown} raw
 * @param {boolean} hasPrice
 * @returns {OrderType}
 */
export function tradierOrderType(raw, hasPrice) {
  const t = clean(/** @type {any} */ (raw)).toLowerCase();
  if (t === "market") return "MKT";
  if (t === "limit" || t === "debit" || t === "credit" || t === "even") return "LMT";
  if (t === "stop" || t === "stop_limit") return "STP";
  return hasPrice ? "LMT" : "MKT";
}

/** @param {unknown} v @param {number} fallback */
function isoOr(v, fallback) {
  const t = Date.parse(clean(/** @type {any} */ (v)));
  return new Date(Number.isFinite(t) ? t : fallback).toISOString();
}

/** Fields a leg takes from its order when it does not send its own. */
const INHERITED = ["type", "duration", "status", "price", "stop_price", "create_date", "transaction_date", "tag", "quantity"];

/**
 * A leg with its order's fields filled in where the leg has none.
 * @param {any} leg @param {any} order
 */
function legOf(leg, order) {
  /** @type {Record<string, unknown>} */
  const out = { ...leg };
  for (const k of INHERITED) if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = order?.[k];
  return out;
}

/**
 * Every order and leg as { o, part, parentPart }: `part` names it in ids ("<order>" or
 * "<order>:<leg>"). A multileg order is its legs; for OTO and OTOCO the later legs wait on the
 * first, so they point at it.
 * @param {any[]} orders
 */
function orderParts(orders) {
  /** @type {Array<{ o: any, part: string, parentPart?: string }>} */
  const out = [];
  for (const o of listOf(orders)) {
    const id = idText(o?.id);
    if (!id) continue;
    const legs = listOf(o.leg);
    if (legs.length === 0) {
      out.push({ o, part: id });
      continue;
    }
    const cls = clean(o.class).toLowerCase();
    /** @type {string | undefined} */
    let first;
    legs.forEach((leg, i) => {
      const part = `${id}:${idText(leg?.id) || String(i)}`;
      out.push({ o: legOf(leg, o), part, ...((cls === "oto" || cls === "otoco") && first ? { parentPart: first } : {}) });
      first ??= part;
    });
  }
  return out;
}

/** The traded symbol of an order or leg: the OCC symbol for options. @param {any} o */
const symbolOf = (o) => (clean(o?.option_symbol) || clean(o?.symbol)).toUpperCase();

/**
 * One order or leg -> Order.
 * @param {any} o
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @param {string} part
 * @param {string} [parentPart]
 * @returns {Order}
 */
function tradierOrder(o, account, fetchedAt, part, parentPart) {
  const limit = num(o?.price);
  const stop = num(o?.stop_price) ?? num(o?.stop);
  const type = tradierOrderType(o?.type, limit !== undefined || stop !== undefined);
  const duration = clean(o?.duration).toLowerCase();
  const ref = part.split(":")[0];
  /** @type {Order} */
  const out = {
    id: `tradier:${account.id}:${part}`,
    clientId: clean(o?.tag) || `tradier-${part}`,
    accountId: account.id,
    brokerId: "tradier",
    symbol: symbolOf(o),
    side: side(o?.side),
    qty: Math.abs(num0(o?.quantity)),
    type,
    tif: duration.startsWith("gtc") ? "GTC" : "DAY",
    status: tradierOrderStatus(o?.status),
    placedAt: isoOr(o?.create_date, fetchedAt),
    brokerRef: ref,
  };
  const price = type === "LMT" ? limit : type === "STP" ? (stop ?? limit) : undefined;
  if (price !== undefined) out.price = price;
  const filled = num(o?.exec_quantity);
  if (filled !== undefined) out.filledQty = Math.abs(filled);
  const avg = num(o?.avg_fill_price);
  if (avg !== undefined && avg > 0) out.avgFill = avg;
  if (duration) out.outsideRth = duration === "pre" || duration === "post" || duration.endsWith("_pre") || duration.endsWith("_post");
  if (parentPart) out.parentId = `tradier:${account.id}:${parentPart}`;
  return out;
}

/**
 * Today's orders of one account (the items of /orders) -> Order[] (one per order or leg).
 * @param {any[]} orders
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function tradierOrders(orders, account, fetchedAt) {
  return orderParts(orders).map(({ o, part, parentPart }) => tradierOrder(o, account, fetchedAt, part, parentPart));
}

/**
 * Today's fills from today's orders: every order or leg with a filled quantity, at its average
 * fill price and its last update time. /orders sends no commission, so these are provisional with
 * commission 0 until the history (tomorrow) has them.
 * @param {any[]} orders
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function tradierOrderFills(orders, account, fetchedAt) {
  /** @type {Execution[]} */
  const out = [];
  for (const { o, part } of orderParts(orders)) {
    const qty = Math.abs(num0(o.exec_quantity));
    const price = num0(o.avg_fill_price);
    if (!(qty > 0) || !(price > 0)) continue;
    const symbol = symbolOf(o);
    const s = side(o.side);
    const gross = qty * price * (OCC.test(symbol) ? 100 : 1);
    out.push({
      id: `tradier:${account.id}:o:${part}`,
      accountId: account.id,
      brokerId: "tradier",
      symbol,
      side: s,
      qty,
      price,
      commission: 0,
      net: cents(s === "BUY" ? -gross : gross),
      tradedAt: isoOr(o.transaction_date || o.create_date, fetchedAt),
      provisional: true,
    });
  }
  return out;
}

/**
 * The trade date of a history event ("2026-11-12T00:00:00Z" or "2026-11-12") as "2026-11-12", or null.
 * @param {any} e
 */
export function historyDate(e) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean(e?.date));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Earlier fills from /history (type=trade). An event has a date and no time, so tradedAt is the
 * close of that day's session (16:00 New York), which keeps it on the right day; these rows are
 * provisional. The fields sit under `event.trade` (Tradier's answer) or on the event itself.
 * Side: a negative quantity, or cash coming in, is a sale. Net is the event's own amount (cash
 * moved, commission included) when sent. Events Nasscord cannot read as a fill are left out. Ids are
 * stable across reads: a hash of the fields, numbered when two events are identical.
 * @param {any[]} events
 * @param {{ id: string }} account
 * @param {{ before?: string | null }} [o] leave out events on or after this date ("YYYY-MM-DD")
 * @returns {Execution[]}
 */
export function tradierHistoryFills(events, account, o = {}) {
  /** @type {Execution[]} */
  const out = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const e of listOf(events)) {
    if (clean(e?.type).toLowerCase() !== "trade") continue;
    const d = e.trade && typeof e.trade === "object" && !Array.isArray(e.trade) ? { ...e, ...e.trade } : e;
    const date = historyDate(e);
    const symbol = clean(d.symbol).toUpperCase();
    const rawQty = num(d.quantity);
    const price = num(d.price);
    if (!date || !symbol || !rawQty || !(price !== undefined && price > 0)) continue;
    if (o.before && date >= o.before) continue;
    const amount = num(e.amount);
    const s = rawQty < 0 || (amount !== undefined && amount > 0) ? "SELL" : "BUY";
    const qty = Math.abs(rawQty);
    const commission = Math.abs(num0(d.commission));
    const option = OCC.test(symbol) || clean(d.trade_type).toLowerCase() === "option";
    const gross = qty * price * (option ? 100 : 1);
    const key = createHash("sha256").update([account.id, date, symbol, rawQty, price, amount ?? "", commission].join("|")).digest("hex").slice(0, 20);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const [y, m, day] = date.split("-").map(Number);
    out.push({
      id: `tradier:${account.id}:h:${key}${n > 1 ? `:${n}` : ""}`,
      accountId: account.id,
      brokerId: "tradier",
      symbol,
      side: s,
      qty,
      price,
      commission: cents(commission),
      net: cents(amount !== undefined ? amount : s === "BUY" ? -(gross + commission) : gross - commission),
      tradedAt: new Date(etToUtc(y, m, day, 16, 0)).toISOString(),
      provisional: true,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────── token endpoint errors

/**
 * Tradier's token errors (an OAuth `error` string, or an Apigee fault) -> what the engine acts on.
 * A refused code or refresh token is the user's own login (invalid_grant: it never pauses the
 * platform client); a refused client is invalid_client.
 * @param {number} status
 * @param {any} json
 * @returns {"invalid_grant" | "invalid_client" | "other"}
 */
export function tradierTokenError(status, json) {
  const parts = [
    typeof json?.error === "string" ? json.error : "",
    typeof json?.error?.code === "string" ? json.error.code : "",
    typeof json?.error?.description === "string" ? json.error.description : "",
    typeof json?.fault?.faultstring === "string" ? json.fault.faultstring : "",
    typeof json?.fault?.detail?.errorcode === "string" ? json.fault.detail.errorcode : "",
  ]
    .join(" ")
    .toLowerCase();
  if (/invalid_client|unauthorized_client|invalidclient|client ?id|client_?secret|invalid api key/.test(parts)) return "invalid_client";
  if (/invalid_grant|invalid_request|refresh|auth(orization)?_?code|invalid code|expired|revoked/.test(parts)) return "invalid_grant";
  if (status === 401) return "invalid_client";
  if (status === 400) return "invalid_grant";
  return "other";
}

/**
 * When Tradier's "Quota Violation" ends, in epoch ms: the X-Ratelimit-Expiry header, else the body
 * ("Quota Violation: Expires 1731780000000"). Null when neither says.
 * @param {string} text
 * @param {Headers} headers
 */
export function quotaExpiry(text, headers) {
  const h = Number(headers.get("x-ratelimit-expiry"));
  if (Number.isFinite(h) && h > 1e12) return h;
  const m = /expires\D{0,5}(\d{10,13})/i.exec(String(text ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 1e12 ? n : n * 1000;
}
