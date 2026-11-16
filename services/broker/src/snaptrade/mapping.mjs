import { cents, clean, maskAccountNumber, num, num0, reported, side, TYPE_LABEL } from "../mapping.mjs";
import { BROKER_NAMES } from "../registry.mjs";
import { etDateKey, etToUtc, parseTime } from "../time.mjs";

/**
 * SnapTrade answers -> Nasscord shapes (src/lib/types.ts, contract section 4). Pure functions only.
 * `accountId` is always broker_accounts.id; `brokerId` is the brokerage the user connected
 * (fidelity, robinhood, ...), never "snaptrade". Values SnapTrade did not report are left out.
 *
 * @typedef {import("../mapping.mjs").BrokerId} BrokerId
 * @typedef {import("../mapping.mjs").AccountType} AccountType
 * @typedef {import("../mapping.mjs").Position} Position
 * @typedef {import("../mapping.mjs").Order} Order
 * @typedef {import("../mapping.mjs").OrderStatus} OrderStatus
 * @typedef {import("../mapping.mjs").OrderType} OrderType
 * @typedef {import("../mapping.mjs").Execution} Execution
 * @typedef {import("../mapping.mjs").AccountSummary} AccountSummary
 * @typedef {{ id: string, external_id: string }} AccountRef
 */

/**
 * The SnapTrade brokerage slug the portal opens for each broker (`portal`, always sent: the user
 * can never pick another brokerage), and the slugs a finished connection may carry (`accept`).
 * Only US live brokerages. Confirm each slug against SnapTrade's brokerage list on the Build keys.
 * @type {Readonly<Record<string, { portal: string, accept: readonly string[] }>>}
 */
export const SNAPTRADE_SLUGS = Object.freeze({
  fidelity: Object.freeze({ portal: "FIDELITY", accept: Object.freeze(["FIDELITY"]) }),
  robinhood: Object.freeze({ portal: "ROBINHOOD", accept: Object.freeze(["ROBINHOOD"]) }),
  public: Object.freeze({ portal: "PUBLIC", accept: Object.freeze(["PUBLIC"]) }),
  moomoo: Object.freeze({ portal: "MOOMOO", accept: Object.freeze(["MOOMOO"]) }),
  webull: Object.freeze({ portal: "WEBULL", accept: Object.freeze(["WEBULL"]) }),
  schwab: Object.freeze({ portal: "SCHWAB", accept: Object.freeze(["SCHWAB"]) }),
  tastytrade: Object.freeze({ portal: "TASTYTRADE", accept: Object.freeze(["TASTYTRADE", "TASTYWORKS"]) }),
});

/** Sample-data brokerages: SnapTrade's test-key sandbox and demo institutions. */
const SAMPLE = /SANDBOX|DEMO|TEST|FAKE|MOCK/i;
/** Paper brokerages: practice money, not the user's live accounts. */
const PAPER = /PAPER|PRACTICE|SIMULAT/i;

/** @param {string} brokerId */
export const brokerName = (brokerId) => BROKER_NAMES[brokerId] ?? brokerId;

/**
 * What a brokerage is when it is not a live one: "sample" (a sandbox or demo institution with sample
 * data, or no brokerage at all), "paper" (practice accounts), else null.
 * @param {any} brokerage the authorization's `brokerage` object
 * @returns {"sample" | "paper" | null}
 */
export function nonLiveKind(brokerage) {
  if (!brokerage || typeof brokerage !== "object") return "sample";
  const names = [brokerage.slug, brokerage.name, brokerage.display_name].filter((v) => typeof v === "string");
  if (names.some((v) => SAMPLE.test(v))) return "sample";
  if (brokerage.is_paper === true || brokerage.paper === true || names.some((v) => PAPER.test(v))) return "paper";
  return null;
}

/**
 * True for a brokerage that is not live (sample data or paper), whatever slug it has.
 * @param {any} brokerage the authorization's `brokerage` object
 */
export const isSampleBrokerage = (brokerage) => nonLiveKind(brokerage) !== null;

/**
 * True when a finished connection is at the brokerage the user chose (and not a sample one).
 * @param {string} brokerId
 * @param {any} brokerage
 */
export function brokerageMatches(brokerId, brokerage) {
  const want = SNAPTRADE_SLUGS[brokerId];
  if (!want || isSampleBrokerage(brokerage)) return false;
  return want.accept.includes(clean(brokerage?.slug).toUpperCase());
}

/**
 * SnapTrade times: ISO strings, or "2026-11-16 14:03:12.123456+00:00" (space, microseconds).
 * @param {unknown} v
 * @returns {number | null}
 */
export function parseSnapTime(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  let s = v.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2");
  s = s.replace(/(\.\d{3})\d+/, "$1");
  return parseTime(s);
}

/** "2026-11-14" from a date or a datetime string, or null. @param {unknown} v */
export function snapDate(v) {
  const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(v.trim()) : null;
  return m ? m[1] : null;
}

/**
 * When a transaction happened. SnapTrade passes on what the brokerage sends: a date only (as the
 * bare date or midnight UTC, "2026-11-14T00:00:00Z"), or an exact time with its zone. A date only is
 * that day with no time (`at` null); an exact time is its instant and the New York day it falls on,
 * so an evening fill (after 20:00 Eastern, the next day in UTC) keeps its own day. A time without a
 * zone is read as a date only: its zone is unknown.
 * @param {unknown} v
 * @returns {{ day: string | null, at: number | null }}
 */
export function activityTime(v) {
  const s = typeof v === "string" ? v.trim() : "";
  const date = snapDate(s);
  if (!date) return { day: null, at: null };
  const rest = s.slice(10);
  if (!rest || /^[T ]00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/i.test(rest) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(rest)) return { day: date, at: null };
  const at = parseSnapTime(s);
  return at === null ? { day: date, at: null } : { day: etDateKey(at), at };
}

/** The connection (authorization) id an account belongs to. @param {any} a */
export const authorizationOf = (a) => clean(typeof a?.brokerage_authorization === "object" ? a?.brokerage_authorization?.id : a?.brokerage_authorization);

/** True for a paper (simulated) account. @param {any} a */
export const isPaperAccount = (a) => a?.is_paper === true;

/**
 * The live accounts of one connection: SnapTrade's /accounts lists every account of the user.
 * Paper accounts (sample data) and closed or archived ones are left out.
 * @param {any[]} all
 * @param {string | null | undefined} authorizationId
 */
export function accountsOfAuthorization(all, authorizationId) {
  if (!authorizationId) return [];
  return all.filter((a) => {
    if (!a || authorizationOf(a) !== authorizationId || !clean(a.id) || isPaperAccount(a)) return false;
    const status = clean(a.status).toLowerCase();
    return status !== "closed" && status !== "archived";
  });
}

/**
 * When SnapTrade last synced the holdings of these accounts: the oldest of their last syncs, so
 * "updated N min ago" never claims more than the stalest account. Null before the first sync.
 * @param {any[]} accounts
 * @returns {string | null}
 */
export function dataAsOfOf(accounts) {
  /** @type {number | null} */
  let oldest = null;
  for (const a of accounts) {
    const t = parseSnapTime(a?.sync_status?.holdings?.last_successful_sync);
    if (t !== null && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest === null ? null : new Date(oldest).toISOString();
}

/**
 * The last day whose transactions SnapTrade has fully synced ("2026-11-14"), or null.
 * @param {any} account
 */
export function transactionsSyncedThrough(account) {
  const tx = account?.sync_status?.transactions;
  if (!tx || tx.initial_sync_completed === false) return null;
  return snapDate(tx.last_successful_sync);
}

/** @param {any} a @returns {AccountType} */
export function snaptradeAccountType(a) {
  const t = `${clean(a?.raw_type)} ${clean(a?.name)}`.toUpperCase();
  if (t.includes("ROTH")) return "roth";
  if (/\bIRA\b|401\s?\(?K\)?|403\s?\(?B\)?|\bSEP\b|\bSIMPLE\b|ROLLOVER|RETIREMENT/.test(t)) return "ira";
  if (t.includes("MARGIN")) return "margin";
  return "individual";
}

/**
 * The number as the app shows it. SnapTrade passes on what the brokerage sends, which is sometimes
 * already masked ("****1234"): then only its last two characters are kept.
 * @param {any} a
 */
export function snaptradeDisplayNumber(a) {
  const n = clean(a?.number);
  if (!n) return `•••${clean(a?.id).slice(-2)}`;
  if (/[*•xX#]{2,}/.test(n)) return `•••${n.replace(/[^A-Za-z0-9]/g, "").slice(-2)}`;
  return maskAccountNumber(n);
}

/**
 * One SnapTrade account as a broker_accounts row (without connection and workspace). Long digit
 * runs in the brokerage's own name for the account (some include the number) are masked.
 * @param {any} a
 * @param {BrokerId} brokerId
 */
export function snaptradeAccountRow(a, brokerId) {
  const type = snaptradeAccountType(a);
  const named = clean(a?.name).replace(/[A-Za-z]?\d{5,}/g, (m) => maskAccountNumber(m));
  const label = named || `${brokerName(brokerId)} ${TYPE_LABEL[type]}`;
  return {
    broker_id: brokerId,
    external_id: clean(a?.id),
    display_number: snaptradeDisplayNumber(a),
    label: label.slice(0, 80),
    type,
  };
}

/** The ISO-4217 code of a SnapTrade currency (a string or { code }). @param {unknown} c */
const currencyOf = (c) => clean(typeof c === "object" && c ? /** @type {any} */ (c).code : /** @type {any} */ (c)).toUpperCase();

/**
 * One account's balances: net liquidation from /accounts (balance.total), cash and buying power
 * from /balances (the USD row, else the account's own currency). SnapTrade reports no day P&L.
 * @param {any} account the /accounts entry
 * @param {any[] | null} balances the /balances answer
 * @param {AccountRef} ref
 * @returns {AccountSummary}
 */
export function snaptradeAccountSummary(account, balances, ref) {
  const total = account?.balance?.total ?? {};
  const own = currencyOf(total.currency) || "USD";
  const rows = Array.isArray(balances) ? balances : [];
  const row = rows.find((b) => currencyOf(b?.currency) === "USD") ?? rows.find((b) => currencyOf(b?.currency) === own) ?? null;
  const currency = row ? currencyOf(row.currency) || own : own;
  return {
    accountId: ref.id,
    ...reported({
      netLiq: currency === own ? num(total.amount) : undefined,
      cash: num(row?.cash),
      buyingPower: num(row?.buying_power),
    }),
    currency,
  };
}

/** SnapTrade security type codes -> secType. @param {unknown} code */
export function snaptradeSecType(code) {
  const c = clean(/** @type {any} */ (code)).toLowerCase();
  if (c === "crypto") return "CRYPTO";
  if (c === "oef" || c === "mf") return "FUND";
  if (c === "bnd" || c === "bond") return "BOND";
  return "STK";
}

/** "AAPL  251219C00150000" -> "AAPL 251219C00150000" (OCC padding collapsed). @param {unknown} t */
const occ = (t) => clean(/** @type {any} */ (t)).replace(/\s+/g, " ");

/** The universal symbol inside a position (PositionSymbol.symbol, or the symbol itself). @param {any} p */
function universalOf(p) {
  const s = p?.symbol;
  if (s && typeof s === "object" && s.symbol && typeof s.symbol === "object") return s.symbol;
  return s && typeof s === "object" ? s : null;
}

/**
 * One stock, ETF, fund or crypto position (/accounts/{id}/positions).
 * @param {any} p
 * @param {AccountRef} ref
 * @param {BrokerId} brokerId
 * @returns {Position}
 */
export function snaptradePosition(p, ref, brokerId) {
  const u = universalOf(p);
  const symbol = clean(u?.symbol) || clean(u?.raw_symbol) || (typeof p?.symbol?.symbol === "string" ? clean(p.symbol.symbol) : "") || clean(p?.symbol?.description);
  const qty = num0(p?.units ?? p?.fractional_units);
  const last = num(p?.price);
  const avg = num(p?.average_purchase_price);
  /** @type {Position} */
  const out = {
    id: `${brokerId}:${ref.id}:${clean(u?.id) || symbol}`,
    accountId: ref.id,
    brokerId,
    symbol,
    qty,
    currency: currencyOf(p?.currency) || currencyOf(u?.currency) || "USD",
    secType: snaptradeSecType(u?.type?.code),
  };
  // A price or cost SnapTrade did not send is left out, and so is what would follow from it.
  if (avg !== undefined) out.avgCost = avg;
  if (last !== undefined) {
    out.last = last;
    out.marketValue = cents(qty * last);
  }
  const pnl = num(p?.open_pnl);
  if (pnl !== undefined) out.unrealizedPnl = cents(pnl);
  else if (avg !== undefined && last !== undefined) out.unrealizedPnl = cents((last - avg) * qty);
  return out;
}

/**
 * One option holding (/accounts/{id}/options). SnapTrade's `price` is per share and its
 * `average_purchase_price` per contract, so the cost is divided by the multiplier (100, or 10 for a
 * mini option) to give the per-share cost the other brokers report.
 * @param {any} p
 * @param {AccountRef} ref
 * @param {BrokerId} brokerId
 * @returns {Position}
 */
export function snaptradeOptionPosition(p, ref, brokerId) {
  const o = p?.symbol?.option_symbol ?? {};
  const symbol = occ(o.ticker) || clean(p?.symbol?.description);
  const multiplier = o.is_mini_option === true ? 10 : 100;
  const qty = num0(p?.units);
  const last = num(p?.price);
  const perContract = num(p?.average_purchase_price);
  const avg = perContract === undefined ? undefined : perContract / multiplier;
  /** @type {Position} */
  const out = {
    id: `${brokerId}:${ref.id}:${clean(o.id) || clean(p?.symbol?.id) || symbol}`,
    accountId: ref.id,
    brokerId,
    symbol,
    qty,
    currency: currencyOf(p?.currency) || "USD",
    secType: "OPT",
  };
  // A price or cost SnapTrade did not send is left out, and so is what would follow from it.
  if (avg !== undefined) out.avgCost = Math.round(avg * 10_000) / 10_000;
  if (last !== undefined) {
    out.last = last;
    out.marketValue = cents(qty * last * multiplier);
    if (avg !== undefined) out.unrealizedPnl = cents((last - avg) * qty * multiplier);
  }
  return out;
}

/** @param {unknown} raw @returns {OrderStatus} */
export function snaptradeOrderStatus(raw) {
  const s = clean(/** @type {any} */ (raw)).toUpperCase();
  if (s === "EXECUTED") return "filled";
  if (s === "CANCELED" || s === "CANCELLED" || s === "EXPIRED" || s === "PARTIAL_CANCELED" || s === "REPLACED") return "cancelled";
  if (s === "REJECTED" || s === "FAILED") return "rejected";
  if (s === "QUEUED" || s === "PENDING_RISK_REVIEW") return "submitted";
  return "working";
}

/** @param {unknown} raw @param {boolean} hasPrice @returns {OrderType} */
export function snaptradeOrderType(raw, hasPrice) {
  const t = clean(/** @type {any} */ (raw)).toUpperCase().replace(/[\s_-]/g, "");
  if (t === "MARKET") return "MKT";
  if (t === "LIMIT") return "LMT";
  if (t === "STOP" || t === "STOPLOSS" || t === "STOPLIMIT" || t === "STOPMARKET") return "STP";
  if (t.startsWith("TRAIL")) return "TRAIL";
  return hasPrice ? "LMT" : "MKT";
}

/** The ticker of an order or activity: the option's OCC ticker, else the universal symbol. @param {any} x */
function tickerOf(x) {
  const o = x?.option_symbol;
  if (o && typeof o === "object" && clean(o.ticker)) return occ(o.ticker);
  const u = x?.universal_symbol ?? (x?.symbol && typeof x.symbol === "object" ? x.symbol : null);
  return clean(u?.symbol) || clean(u?.raw_symbol) || (typeof x?.symbol === "string" ? clean(x.symbol) : "");
}

/** @param {any} x */
const isOption = (x) => !!(x?.option_symbol && typeof x.option_symbol === "object" && clean(x.option_symbol.ticker));
/** @param {any} x */
const multiplierOf = (x) => (isOption(x) ? (x.option_symbol.is_mini_option === true ? 10 : 100) : 1);

/** @param {unknown} v @param {number} fallback */
const isoOr = (v, fallback) => new Date(parseSnapTime(v) ?? fallback).toISOString();

/**
 * Orders of one account (open and recent, possibly listed twice) -> Order[], newest first.
 * @param {any[]} list
 * @param {AccountRef} ref
 * @param {BrokerId} brokerId
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function snaptradeOrders(list, ref, brokerId, fetchedAt) {
  /** @type {Map<string, Order>} */
  const out = new Map();
  for (const o of list) {
    const id = clean(o?.brokerage_order_id);
    if (!id || out.has(id)) continue;
    const limit = num(o.limit_price);
    const stop = num(o.stop_price);
    const type = snaptradeOrderType(o.order_type, limit !== undefined || stop !== undefined);
    const filled = num(o.filled_quantity);
    const qty = num(o.total_quantity) ?? num0(o.filled_quantity) + num0(o.open_quantity) + num0(o.canceled_quantity);
    /** @type {Order} */
    const order = {
      id: `${brokerId}:${ref.id}:${id}`,
      clientId: `${brokerId}-${id}`,
      accountId: ref.id,
      brokerId,
      symbol: tickerOf(o),
      side: side(o.action),
      qty,
      type,
      tif: clean(o.time_in_force).toUpperCase() === "GTC" ? "GTC" : "DAY",
      status: snaptradeOrderStatus(o.status),
      placedAt: isoOr(o.time_placed, fetchedAt),
      brokerRef: id,
    };
    const price = type === "STP" ? stop ?? limit : limit ?? stop;
    if (price !== undefined && type !== "MKT" && type !== "TRAIL") order.price = price;
    if (filled !== undefined) order.filledQty = filled;
    const avg = num(o.execution_price);
    if (avg !== undefined && avg > 0) order.avgFill = avg;
    out.set(id, order);
  }
  return [...out.values()].sort((a, b) => (a.placedAt < b.placedAt ? 1 : a.placedAt > b.placedAt ? -1 : 0));
}

/**
 * Fills of one account. SnapTrade's transactions (activities) arrive a day late but carry the fees,
 * so:
 * - BUY and SELL activities up to `syncedThrough` (the last fully synced day) are the fills, with
 *   their fees as commission and their amount as net;
 * - orders with a filled quantity executed after that day (Eastern dates) are added as provisional
 *   fills without commission, until their transactions arrive.
 * An activity's day is its New York day (activityTime). Its time is the one the brokerage sent;
 * when it sent a date only, the time of the order it matches (same day, symbol, side and quantity),
 * else midnight Eastern of its day.
 * @param {{ orders: any[], activities: any[], syncedThrough: string | null }} src
 * @param {AccountRef} ref
 * @param {BrokerId} brokerId
 * @returns {Execution[]}
 */
export function snaptradeExecutions(src, ref, brokerId) {
  /** @type {Execution[]} */
  const out = [];
  /** Executed orders with their Eastern day, for the activities' times and the provisional fills. */
  const fills = [];
  /** @type {Set<string>} */
  const seenOrders = new Set();
  for (const o of src.orders) {
    const id = clean(o?.brokerage_order_id);
    if (!id || seenOrders.has(id)) continue;
    seenOrders.add(id);
    const qty = Math.abs(num0(o.filled_quantity));
    const price = Math.abs(num0(o.execution_price));
    if (!(qty > 0) || !(price > 0)) continue;
    const at = parseSnapTime(o.time_executed) ?? parseSnapTime(o.time_updated) ?? parseSnapTime(o.time_placed);
    if (at === null) continue;
    fills.push({ o, id, qty, price, at, day: etDateKey(at), symbol: tickerOf(o), side: side(o.action) });
  }

  /** @type {Set<string>} orders already used for an activity's time */
  const matched = new Set();
  const through = src.syncedThrough;
  if (through) {
    /** @type {Set<string>} */
    const seen = new Set();
    for (const a of src.activities) {
      const type = clean(a?.type).toUpperCase();
      if (type !== "BUY" && type !== "SELL") continue;
      const id = clean(a.id);
      const { day, at } = activityTime(a.trade_date);
      if (!id || seen.has(id) || !day || day > through) continue;
      seen.add(id);
      const qty = Math.abs(num0(a.units));
      const price = Math.abs(num0(a.price));
      if (!(qty > 0)) continue;
      const s = type === "BUY" ? "BUY" : "SELL";
      const symbol = tickerOf(a);
      const commission = Math.abs(num0(a.fee));
      const gross = qty * price * multiplierOf(a);
      const amount = num(a.amount);
      const match = fills.find((f) => !matched.has(f.id) && f.day === day && f.symbol === symbol && f.side === s && Math.abs(f.qty - qty) < 1e-9);
      if (match) matched.add(match.id);
      const [y, m, d] = day.split("-").map(Number);
      out.push({
        id: `${brokerId}:${ref.id}:a:${id}`,
        accountId: ref.id,
        brokerId,
        symbol,
        side: s,
        qty,
        price,
        commission: cents(commission),
        net: cents(amount ?? (s === "BUY" ? -(gross + commission) : gross - commission)),
        tradedAt: new Date(at ?? (match ? match.at : etToUtc(y, m, d, 0, 0))).toISOString(),
      });
    }
  }

  for (const f of fills) {
    if (through && f.day <= through) continue;
    const gross = f.qty * f.price * multiplierOf(f.o);
    out.push({
      id: `${brokerId}:${ref.id}:o:${f.id}`,
      accountId: ref.id,
      brokerId,
      symbol: f.symbol,
      side: f.side,
      qty: f.qty,
      price: f.price,
      commission: 0,
      net: cents(f.side === "BUY" ? -gross : gross),
      tradedAt: new Date(f.at).toISOString(),
      provisional: true,
    });
  }
  return out.sort((a, b) => (a.tradedAt < b.tradedAt ? 1 : a.tradedAt > b.tradedAt ? -1 : 0));
}
