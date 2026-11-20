import { HttpError, rateLimited, SessionExpiredError } from "../errors.mjs";
import { clean, etradePosition, maskAccountNumber, num, num0 } from "../mapping.mjs";
import { formatPrice, normalizeSymbol, OrderNotSentError } from "../order-contract.mjs";
import { etParts, iso, parseTime } from "../time.mjs";
import { EtradeAuthError } from "./client.mjs";

/**
 * E*TRADE order entry (the trading part of method etrade_oauth1, docs/real-backend.md section 13). Only
 * the order core (src/orders.mjs) calls it, inside the lock "order:<connectionId>", after the workspace
 * switch.
 *
 * Reads (withSession, which may renew a token and read again): the portfolio, the orders list of one
 * symbol and the quote. Order calls (withWriteSession and the client's signedSend, ETRADE_WRITE_ALLOW):
 * POST .../orders/preview.json, POST .../orders/place.json and PUT .../orders/cancel.json. A place is
 * sent once: never through withSession's renew-and-rerun, never retried, never cached.
 *
 * E*TRADE production only (no paper exists, sandbox serves sample data), no brackets (its API has none),
 * Market orders are Day only. E*TRADE never returns the client order id, so an unconfirmed order is found
 * again by its fields (reconcileOrder).
 *
 * The account in every path is ctx.account.external_id (E*TRADE's accountIdKey), never the request.
 * Logs ids, outcomes and E*TRADE codes only.
 */

/** @typedef {import("../order-contract.mjs").Ticket} Ticket */
/** @typedef {import("../order-contract.mjs").OrderCtx} OrderCtx */
/** @typedef {import("../order-contract.mjs").PositionState} PositionState */
/** @typedef {import("../order-contract.mjs").OrderWarning} OrderWarning */
/** @typedef {import("../order-contract.mjs").Quote} Quote */
/** @typedef {import("../order-contract.mjs").PlaceOutcome} PlaceOutcome */
/** @typedef {import("../order-contract.mjs").ReconcileOutcome} ReconcileOutcome */
/** @typedef {import("../order-contract.mjs").TradingAdapter} TradingAdapter */
/** @typedef {import("../db.mjs").ConnectionRow} ConnectionRow */
/** @typedef {import("./client.mjs").EtradeClient} EtradeClient */
/** @typedef {import("./client.mjs").SendResult} SendResult */
/** @typedef {{ token: string, secret: string }} Tokens */
/** @typedef {"BUY" | "SELL" | "BUY_TO_COVER"} OrderAction */

export const ETRADE_PRICE_TYPE = Object.freeze({ MKT: "MARKET", LMT: "LIMIT", STP: "STOP", STP_LMT: "STOP_LIMIT" });

/** The preview call, at most. */
const PREVIEW_CALL_MS = 15_000;
/** The place call, at most (also capped by the deadline). */
const PLACE_CALL_MS = 20_000;
/** The cancel call, at most. */
const CANCEL_CALL_MS = 15_000;
/** A place needs at least this much of the deadline left before it is sent. */
const MIN_SEND_MS = 5_000;
/** Portfolio pages read for a position, at most (50 positions a page). */
const MAX_PAGES = 10;

/**
 * Whether an AccountPortfolio group says another page follows: a next page number past this one,
 * bounded by the page total when E*TRADE sends one (totalPages in its sample, totalNoOfPages in its
 * field reference). A missing total does not end the paging.
 * @param {any} g
 * @param {number} page
 */
export function portfolioHasMore(g, page) {
  const next = Number(g?.nextPageNo);
  if (!Number.isFinite(next) || next <= page) return false;
  const total = Number(g?.totalPages ?? g?.totalNoOfPages);
  if (Number.isFinite(total) && total > 0 && total <= page) return false;
  return true;
}

/** List Orders pages read for the working orders of a symbol, at most, and their size (E*TRADE's maximum). */
const ORDER_PAGES = 5;
const ORDER_PAGE_SIZE = 100;
/** Prices E*TRADE lists for an order count as equal within this. */
const PRICE_EPSILON = 0.00005;
/** An order E*TRADE lists counts for reconcile when it was placed at most this long before the preview. */
const PLACED_SLACK_MS = 60_000;

const ORDER_ID_RE = /^[1-9][0-9]{0,18}$/;
const WORKING = new Set(["OPEN", "PARTIAL", "INDIVIDUAL_FILLS", "CANCEL_REQUESTED"]);
const DONE = /** @type {Record<string, string>} */ ({ EXECUTED: "executed", CANCELLED: "cancelled", EXPIRED: "expired", REJECTED: "rejected" });

/** Sentences of this adapter (docs/real-backend.md section 13). */
const S = Object.freeze({
  previewLimited: "E*TRADE is limiting requests right now. Try again in a few seconds.",
  previewDown: "E*TRADE did not answer the preview. Nothing was placed. Try again.",
  previewUnreadable: "E*TRADE sent a preview Nasscord could not read. Nothing was placed.",
  previewOtherAccount: "E*TRADE answered for another account than the one you picked. Nothing was placed.",
  previewNoAccountEcho: "E*TRADE did not confirm the account number in its preview.",
  previewEchoMismatch: "E*TRADE's preview did not match the order Nasscord sent, so it was stopped. Nothing was placed.",
  workingUnreadable:
    "E*TRADE did not list your working orders, so Nasscord cannot check them against this order. Nothing was placed. Try again in a few seconds.",
  incomplete: "The preview of this order is incomplete. Preview it again.",
  noLongerMatches: "The previewed order no longer matches. Preview it again.",
  snapshotFailed: "Nasscord could not read your E*TRADE orders before sending. Nothing was placed. Try again.",
  tooLongToSend: "E*TRADE took too long before the order could be sent. Nothing was placed.",
  stoppedHere: "Nasscord stopped this order before it went to E*TRADE. Nothing was placed.",
  unknown: "Nasscord could not confirm whether E*TRADE received this order. Check Orders before you place it again.",
  noOrderNumber: "E*TRADE answered without an order number. Check Orders before you place it again.",
  echoMismatch: "E*TRADE's confirmation shows different details than you entered. Check it in Orders now.",
  duplicate: "E*TRADE says this is a duplicate order, so an earlier attempt may have reached it. Check Orders before you place it again.",
  previewExpired: "E*TRADE: the preview expired. Preview the order again.",
  placeLimited: "E*TRADE was limiting requests, so it did not take the order. Nothing was placed. Preview it again in a few seconds.",
  placeAuth: "E*TRADE asked Nasscord to sign in again, so it did not take the order. Nothing was placed. Preview the order again.",
  checkLater: "E*TRADE could not be asked right now. Nasscord checks again in a few seconds.",
  cancelNotOpen: "This order is not open at E*TRADE any more.",
  cancelNotFound: "Nasscord could not find this open order at E*TRADE. Cancel it on etrade.com.",
  cancelAlready: "E*TRADE is already cancelling this order.",
  cancelRequested: "E*TRADE is cancelling the order. It shows as cancelled once E*TRADE confirms it, and it can still fill until then.",
  cancelledBefore: "E*TRADE had already cancelled this order.",
  cancelAuth: "E*TRADE asked Nasscord to sign in again. Reconnect E*TRADE, then cancel again.",
  cancelLimited: "E*TRADE is limiting requests right now. Nothing was cancelled. Try again in a few seconds.",
  cancelUnknown: "Nasscord could not confirm the cancel with E*TRADE. Check Orders: the order may still be working.",
});

/** @param {string} sym */
const positionUnreadable = (sym) => `Nasscord could not read your ${sym} position at E*TRADE. Nothing was placed.`;

/** @param {unknown} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
/** @param {unknown} v */
const upper = (v) => (typeof v === "string" || typeof v === "number" ? String(v).trim().toUpperCase() : "");
/** @param {unknown} v */
const symbolOf = (v) => (typeof v === "string" ? normalizeSymbol(v) : "");
/** @param {number | undefined} a @param {number} b */
const near = (a, b) => a !== undefined && Math.abs(a - b) < PRICE_EPSILON;
/** @param {number} n */
const round4 = (n) => Math.round(n * 10_000) / 10_000;
/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;
/** @param {unknown} v */
const present = (v) => v !== null && v !== undefined && v !== "";
/** @param {{ external_id: string }} account */
const keyOf = (account) => encodeURIComponent(account.external_id);
/** @param {Ticket} ticket */
const termOf = (ticket) => (ticket.tif === "GTC" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY");

/** "MMDDYYYY" of an instant in New York (E*TRADE's fromDate and toDate). @param {number} ms */
function mmddyyyy(ms) {
  const p = etParts(ms);
  return `${String(p.month).padStart(2, "0")}${String(p.day).padStart(2, "0")}${p.year}`;
}

/** A positive safe integer, or null. @param {unknown} v */
function positiveId(v) {
  const n = num(v);
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** JSON with sorted keys, so two orders compare equal whatever their key order. @param {unknown} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The orders of an OrdersResponse (null for E*TRADE's 204). @param {any} json @returns {any[]} */
const orderList = (json) => arr(json?.OrdersResponse?.Order);

/**
 * BUY against a short is BUY_TO_COVER (E*TRADE's behaviour for a plain BUY there is not documented). A
 * SELL is always SELL: the core never lets a sell go past the long position, so SELL_SHORT is never sent.
 * @param {"BUY" | "SELL"} side @param {number} pos
 * @returns {OrderAction}
 */
export function orderAction(side, pos) {
  if (side === "BUY") return pos < 0 ? "BUY_TO_COVER" : "BUY";
  return "SELL";
}

/**
 * E*TRADE's Order object for a ticket. Price fields the type does not use are left out. Built once at
 * preview, stored, and rebuilt at place, where the two must be equal.
 * @param {Ticket} ticket
 * @param {OrderAction} action
 * @returns {Record<string, unknown>}
 */
export function buildOrder(ticket, action) {
  /** @type {Record<string, unknown>} */
  const o = {
    allOrNone: "false",
    priceType: ETRADE_PRICE_TYPE[ticket.type],
    orderTerm: ticket.tif === "GTC" ? "GOOD_UNTIL_CANCEL" : "GOOD_FOR_DAY",
    marketSession: "REGULAR",
  };
  if (ticket.type === "LMT" || ticket.type === "STP_LMT") o.limitPrice = formatPrice(/** @type {number} */ (ticket.limitPrice));
  if (ticket.type === "STP" || ticket.type === "STP_LMT") o.stopPrice = formatPrice(/** @type {number} */ (ticket.stopPrice));
  o.Instrument = [{ Product: { securityType: "EQ", symbol: ticket.symbol }, orderAction: action, quantityType: "QUANTITY", quantity: String(ticket.quantity) }];
  return o;
}

/**
 * The sentence for an E*TRADE error code (docs/real-backend.md section 13).
 * @param {number | null | undefined} code
 * @param {string | null | undefined} message
 */
export function etradeSentence(code, message) {
  /** @param {number[]} list */
  const is = (list) => code !== null && code !== undefined && list.includes(code);
  if (is([1021, 3010, 4171, 1299])) return "E*TRADE: not enough buying power for this order.";
  if (is([4113, 4144, 10015])) return "E*TRADE: not enough cleared funds for this buy.";
  if (is([4124, 10016, 1038, 1039])) return "E*TRADE: you do not hold enough shares for this sell.";
  if (is([1037])) return "E*TRADE: the shares are not available, or a working order already reserves them. Check your open orders on this symbol.";
  if (is([1040])) return "E*TRADE says this account does not hold that position.";
  if (is([1035])) return "E*TRADE takes Market orders as Day orders only.";
  if (is([1056, 1068])) return "E*TRADE: the market is closed for this order.";
  if (is([1001, 1002, 1003, 1004, 1005, 1006])) return "E*TRADE does not recognize this symbol as a stock.";
  if (is([1011, 1014])) return "E*TRADE: the price is too far from the market.";
  if (is([1017, 1018, 1084])) return "E*TRADE: the price is not valid for this symbol.";
  if (is([1019, 1509, 1510, 2061, 2062])) return "E*TRADE: the stop price is on the wrong side of the market.";
  if (is([1000])) return "E*TRADE: this account is not approved for trading.";
  if (is([1036])) return "E*TRADE: this account may place closing orders only.";
  if (is([1041, 1044, 33])) return "E*TRADE: this account cannot sell this security short.";
  if (is([1043])) return "E*TRADE: trading in this security is halted.";
  if (is([1046])) return "E*TRADE: this security is on E*TRADE's restricted list.";
  if (is([1049, 630000])) return "E*TRADE is still working on an earlier request. Nothing was placed. Wait a moment and preview again.";
  if (is([100, 102])) return "E*TRADE does not recognize this account for your login. Reconnect E*TRADE.";
  const text = typeof message === "string" ? message.trim().slice(0, 200).trim() : "";
  if (text) return `E*TRADE: ${text}`;
  return `E*TRADE refused the order (code ${code ?? "unknown"}).`;
}

/**
 * The messages of an Order echo (preview or place): text without E*TRADE's "200|" prefix.
 * @param {any} eo
 * @returns {Array<{ code: number | undefined, type: string, text: string }>}
 */
function messagesOf(eo) {
  const raw = eo?.messages?.Message ?? eo?.Messages?.Message ?? eo?.messages?.message ?? eo?.Messages?.message;
  return arr(raw)
    .map((m) => ({
      code: num(m?.code),
      type: upper(m?.type),
      text: String(m?.description ?? "")
        .trim()
        .replace(/^\d+\|/, "")
        .trim()
        .slice(0, 200),
    }))
    .filter((m) => m.text);
}

/**
 * Whether E*TRADE's echo of an order differs from what Nasscord sent. Missing action, quantity or
 * symbol counts as different; priceType, orderTerm and the prices that were sent are compared when
 * E*TRADE shows them.
 * @param {any} eo the Order echo
 * @param {Ticket} ticket
 * @param {Record<string, any>} order what was sent
 */
function echoDiffers(eo, ticket, order) {
  if (!eo || typeof eo !== "object") return true;
  const ei = arr(eo.Instrument ?? eo.instrument)[0];
  const sent = order.Instrument[0];
  if (!ei || typeof ei !== "object") return true;
  if (upper(ei.orderAction) !== sent.orderAction) return true;
  if (num(ei.quantity ?? ei.orderedQuantity) !== ticket.quantity) return true;
  if (symbolOf(ei.Product?.symbol ?? ei.product?.symbol) !== ticket.symbol) return true;
  if (present(eo.priceType) && upper(eo.priceType) !== order.priceType) return true;
  if (present(eo.orderTerm) && upper(eo.orderTerm) !== order.orderTerm) return true;
  if ("limitPrice" in order && present(eo.limitPrice) && !near(num(eo.limitPrice), Number(order.limitPrice))) return true;
  if ("stopPrice" in order && present(eo.stopPrice) && !near(num(eo.stopPrice), Number(order.stopPrice))) return true;
  return false;
}

/**
 * What E*TRADE's answer to a place means (docs/real-backend.md section 13).
 * @param {SendResult} result
 * @param {Ticket} ticket
 * @param {Record<string, any>} order what was sent
 * @param {string} displayNumber the masked account number of ctx.account
 * @returns {PlaceOutcome}
 */
function placeOutcome(result, ticket, order, displayNumber) {
  if (result.kind === "ok") {
    const pr = result.json?.PlaceOrderResponse;
    const orderId = positiveId(arr(pr?.OrderIds ?? pr?.orderIds)[0]?.orderId);
    if (orderId === null) return { status: "unknown", error: S.noOrderNumber };
    const eo = arr(pr.Order ?? pr.order)[0];
    const otherAccount = present(pr.accountId) && maskAccountNumber(String(pr.accountId)) !== displayNumber;
    const messages = messagesOf(eo).map((m) => ({ id: String(m.code ?? "message"), text: m.text }));
    /** @type {PlaceOutcome} */
    const out = { status: "placed", brokerOrderId: String(orderId) };
    if (messages.length) out.messages = messages;
    if (otherAccount || echoDiffers(eo, ticket, order)) out.warnings = [{ code: "etrade_echo_mismatch", text: S.echoMismatch, source: "broker" }];
    return out;
  }
  if (result.kind === "rejected") {
    // A duplicate means an earlier attempt may have reached E*TRADE: never "not placed".
    if (result.code === 1028 || result.code === 99990) return { status: "unknown", error: S.duplicate };
    if (result.code === 900 || result.code === 1033 || result.code === 20215) return { status: "rejected", error: S.previewExpired, code: `etrade_${result.code}` };
    return { status: "rejected", error: etradeSentence(result.code, result.message), code: `etrade_${result.code}` };
  }
  // E*TRADE does not process a rate-limited request, and a 401 is refused before the order is read.
  if (result.kind === "rate_limited") return { status: "rejected", error: S.placeLimited, code: "rate_limited" };
  if (result.kind === "auth") return { status: "rejected", error: S.placeAuth, code: "etrade_auth" };
  return { status: "unknown", error: S.unknown };
}

/** @param {unknown} e */
const codeOf = (e) => (e instanceof HttpError ? e.code : e instanceof Error ? e.name : "error");

/**
 * @param {{
 *   withSession: <T>(connection: ConnectionRow, fn: (client: EtradeClient, tokens: Tokens) => Promise<T>) => Promise<T>,
 *   withWriteSession: <T>(connection: ConnectionRow, fn: (client: EtradeClient, tokens: Tokens) => Promise<T>) => Promise<T>,
 *   log: import("../log.mjs").Logger,
 *   now?: () => number,
 * }} deps
 *   withSession: reads (a 401 gets a renew and one more read). withWriteSession: runs fn exactly once
 *   (an "auth" answer renews the token afterwards, but nothing is sent again).
 * @returns {TradingAdapter}
 */
export function createEtradeOrders({ withSession, withWriteSession, log, now = Date.now }) {
  /**
   * A read of the orders list of the account (204 is an empty list).
   * @param {OrderCtx} ctx
   * @param {Record<string, string | number>} query
   */
  const readOrders = (ctx, query) =>
    withSession(ctx.connection, (client, tokens) => client.getJson(`/v1/accounts/${keyOf(ctx.account)}/orders`, tokens, query));

  /**
   * The signed position in shares of the ticket's symbol, plus the working orders when they matter.
   * @param {OrderCtx} ctx
   * @param {Ticket} ticket
   * @returns {Promise<PositionState>}
   */
  async function positionState(ctx, ticket) {
    const { account } = ctx;
    const key = keyOf(account);
    let qty = 0;
    try {
      qty = await withSession(ctx.connection, async (client, tokens) => {
        let sum = 0;
        let page = 1;
        for (;;) {
          /** @type {Record<string, string | number>} */
          const query = { count: 50, view: "QUICK" };
          if (page > 1) query.pageNumber = page;
          const resp = await client.getJson(`/v1/accounts/${key}/portfolio`, tokens, query);
          const pr = resp?.PortfolioResponse;
          if (!pr) {
            // Page 1 without a portfolio is an account with no positions; a later page that was
            // announced and does not come is a cut list.
            if (page > 1) throw new Error("portfolio page missing");
            break;
          }
          let more = false;
          let seen = 0;
          for (const g of arr(pr.AccountPortfolio)) {
            for (const p of arr(g?.Position)) {
              seen += 1;
              if (!p || typeof p !== "object") continue;
              if (upper(p.Product?.securityType) !== "EQ" || symbolOf(p.Product?.symbol) !== ticket.symbol) continue;
              const q = etradePosition(p, account).qty;
              if (!Number.isFinite(q)) throw new Error("position quantity unreadable");
              sum += q;
            }
            if (portfolioHasMore(g, page)) more = true;
          }
          if (!more || seen === 0) break;
          // A position on a page Nasscord did not read would make the sum wrong: refused, not guessed.
          if (page >= MAX_PAGES) throw new Error("portfolio longer than the pages read");
          page += 1;
        }
        return sum;
      });
    } catch (e) {
      log.warn("etrade position unreadable", { connectionId: ctx.connection.id, requestId: ctx.requestId, error: e });
      if (e instanceof SessionExpiredError) throw new OrderNotSentError(409, `${e.message} Nothing was placed.`, "connection_not_live");
      throw new OrderNotSentError(502, positionUnreadable(ticket.symbol), "position_unreadable");
    }

    if (ticket.side !== "SELL" && ticket.intent !== "close" && qty >= 0) return { qty, workingSell: 0, workingBuy: 0, working: false };

    let workingSell = 0;
    let workingBuy = 0;
    try {
      // D5: the working orders count only when the list is known to be complete. E*TRADE pages List
      // Orders with a marker; it is followed for ORDER_PAGES pages at most. A list still marked as
      // longer, a next link without a marker, or a full page without a marker (Nasscord cannot tell it
      // from a cut list) is incomplete: nothing is sent.
      let marker = null;
      let complete = false;
      /** @type {Set<string>} */
      const seen = new Set();
      for (let page = 0; page < ORDER_PAGES && !complete; page++) {
        /** @type {Record<string, string | number>} */
        const query = { symbol: ticket.symbol, count: ORDER_PAGE_SIZE };
        if (marker !== null) query.marker = marker;
        const json = await readOrders(ctx, query);
        const list = orderList(json);
        for (const o of list) {
          const oid = String(o?.orderId ?? "");
          if (oid && seen.has(oid)) continue;
          if (oid) seen.add(oid);
          // Every detail of an order counts on its own, with its own status: conservative.
          for (const d of arr(o?.OrderDetail)) {
            if (!WORKING.has(upper(d?.status))) continue;
            for (const i of arr(d?.Instrument)) {
              if (upper(i?.Product?.securityType) !== "EQ" || symbolOf(i?.Product?.symbol) !== ticket.symbol) continue;
              const ordered = num(i.orderedQuantity);
              if (ordered === undefined) throw new Error("working order quantity unreadable");
              const remaining = Math.max(0, ordered - num0(i.filledQuantity));
              const action = upper(i.orderAction);
              if (action === "SELL" || action === "SELL_SHORT") workingSell += remaining;
              else if (action === "BUY" || action === "BUY_TO_COVER") workingBuy += remaining;
            }
          }
        }
        const resp = json?.OrdersResponse;
        const next = present(resp?.marker) ? String(resp.marker) : null;
        const more = next !== null || present(resp?.next) || resp?.moreOrders === true || upper(resp?.moreOrders) === "TRUE";
        if (!more) {
          if (list.length >= ORDER_PAGE_SIZE) break;
          complete = true;
        } else {
          if (next === null || next === marker) break;
          marker = next;
        }
      }
      if (!complete) throw new Error("working orders list incomplete");
    } catch (e) {
      log.warn("etrade working orders unreadable", { connectionId: ctx.connection.id, requestId: ctx.requestId, error: e });
      throw new OrderNotSentError(409, S.workingUnreadable, "working_orders_unreadable");
    }
    return { qty, workingSell, workingBuy, working: true };
  }

  /**
   * The quote for the reference price, best effort. Any failure is a null quote; a failure here never
   * renews a token or touches the connection (fn catches everything itself).
   * @param {OrderCtx} ctx
   * @param {string} symbol
   * @returns {Promise<{ quote: Quote, reference: number | null, companyName: string } | null>}
   */
  async function readQuote(ctx, symbol) {
    /** @type {{ ok: true, json: any } | { ok: false, error: unknown }} */
    let r;
    try {
      r = await withSession(ctx.connection, async (client, tokens) => {
        try {
          return { ok: /** @type {const} */ (true), json: await client.getJson(`/v1/market/quote/${encodeURIComponent(symbol)}`, tokens, { detailFlag: "ALL" }) };
        } catch (error) {
          return { ok: /** @type {const} */ (false), error };
        }
      });
    } catch (error) {
      r = { ok: false, error };
    }
    if (!r.ok) {
      log.info("etrade quote unavailable", { connectionId: ctx.connection.id, code: codeOf(r.error) });
      return null;
    }
    const q = arr(r.json?.QuoteResponse?.QuoteData)[0];
    if (!q || typeof q !== "object" || symbolOf(q.Product?.symbol) !== symbol) {
      log.info("etrade quote unavailable", { connectionId: ctx.connection.id, code: "no_quote" });
      return null;
    }
    const all = q.All ?? {};
    /** @param {unknown} v */
    const pos = (v) => {
      const n = num(v);
      return n !== undefined && n > 0 ? n : undefined;
    };
    const bid = pos(all.bid);
    const ask = pos(all.ask);
    const last = pos(all.lastTrade);
    if (bid === undefined && ask === undefined && last === undefined) return null;
    /** @type {Quote} */
    const quote = { source: upper(q.quoteStatus) === "REALTIME" ? "E*TRADE quote" : "E*TRADE delayed quote" };
    if (bid !== undefined) quote.bid = bid;
    if (ask !== undefined) quote.ask = ask;
    if (last !== undefined) quote.last = last;
    const at = pos(q.dateTimeUTC);
    if (at !== undefined) quote.at = /** @type {string} */ (iso(at * 1000));
    const reference = bid !== undefined && ask !== undefined ? round4((bid + ask) / 2) : (last ?? null);
    return { quote, reference, companyName: clean(all.companyName) };
  }

  return {
    capabilities(connection) {
      if (connection.environment !== "production") return null;
      return {
        types: ["MKT", "LMT", "STP", "STP_LMT"],
        tif: ["DAY", "GTC"],
        marketGtc: false,
        bracket: null,
        notes: [
          "E*TRADE does not accept bracket orders through its API. Place the entry here, then add a stop or target on etrade.com.",
          "E*TRADE stop and stop limit orders trigger on the bid or ask (Stop on Quote), not on the last trade.",
          "E*TRADE takes Market orders as Day orders only.",
        ],
      };
    },

    positionState: (ctx, ticket) => positionState(ctx, ticket),

    async previewOrder(ctx, ticket, clientOrderId) {
      const { connection, account } = ctx;
      const ps = await positionState(ctx, ticket);
      const action = orderAction(ticket.side, ps.qty);
      const order = buildOrder(ticket, action);
      const q = await readQuote(ctx, ticket.symbol);

      // A preview creates no order, so a renew and a second preview are fine here.
      const r = await withSession(connection, async (client, tokens) => {
        const out = await client.signedSend(
          "POST",
          `/v1/accounts/${keyOf(account)}/orders/preview.json`,
          tokens,
          { root: "PreviewOrderRequest", value: { orderType: "EQ", clientOrderId, Order: [order] } },
          { timeoutMs: Math.min(PREVIEW_CALL_MS, Math.max(1_000, ctx.deadline - now())), timeLeft: () => ctx.deadline - now() },
        );
        if (out.kind === "auth") throw new EtradeAuthError(out.problem);
        return out;
      });
      if (r.kind === "rejected") {
        log.info("etrade preview refused", { connectionId: connection.id, brokerCode: r.code });
        throw new HttpError(422, etradeSentence(r.code, r.message), { code: "broker_refused" });
      }
      if (r.kind === "rate_limited") throw rateLimited(S.previewLimited);
      if (r.kind !== "ok") {
        log.warn("etrade preview unanswered", { connectionId: connection.id, reason: r.reason });
        throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
      }

      const pr = r.json?.PreviewOrderResponse;
      const previewId = positiveId(arr(pr?.PreviewIds ?? pr?.previewIds)[0]?.previewId);
      if (!pr || typeof pr !== "object" || previewId === null) throw new HttpError(502, S.previewUnreadable, { code: "broker_unavailable" });

      /** @type {OrderWarning[]} */
      const warnings = [];
      if (present(pr.accountId)) {
        if (maskAccountNumber(String(pr.accountId)) !== account.display_number) throw new HttpError(409, S.previewOtherAccount, { code: "account_mismatch" });
      } else {
        warnings.push({ code: "etrade_no_account_echo", text: S.previewNoAccountEcho, source: "broker" });
      }

      const eo = arr(pr.Order ?? pr.order)[0];
      if (echoDiffers(eo, ticket, order)) {
        log.warn("etrade preview echo mismatch", { connectionId: connection.id });
        throw new HttpError(409, S.previewEchoMismatch, { code: "etrade_echo_mismatch" });
      }
      const ei = arr(eo.Instrument ?? eo.instrument)[0];

      for (const m of messagesOf(eo)) {
        if (m.type === "ERROR") throw new HttpError(422, `E*TRADE: ${m.text}`, { code: "broker_refused" });
        warnings.push({ code: m.code === 1042 ? "duplicate_risk" : `etrade_${m.code ?? "message"}`, text: m.text, source: "broker" });
      }

      // The estimate, as E*TRADE gave it.
      const totalRaw = num(eo.estimatedTotalAmount ?? pr.estimatedTotalAmount);
      const commissionParts = [num(eo.estimatedCommission), num(eo.estimatedFees)].filter((n) => n !== undefined);
      const commission = commissionParts.length ? round2(commissionParts.reduce((s, n) => s + Math.abs(/** @type {number} */ (n)), 0)) : undefined;
      const total = totalRaw !== undefined ? round2(Math.abs(totalRaw)) : undefined;
      const valueRaw = num(pr.totalOrderValue ?? eo.totalOrderValue);
      const notional =
        valueRaw !== undefined && Math.abs(valueRaw) > 0 ? round2(Math.abs(valueRaw)) : total !== undefined ? round2(total - (commission ?? 0)) : undefined;
      /** @type {import("../order-contract.mjs").Estimate} */
      const estimate = { source: "E*TRADE" };
      if (notional !== undefined) estimate.notional = notional;
      if (commission !== undefined) estimate.commission = commission;
      if (total !== undefined) estimate.total = total;

      // E*TRADE's estimate of a priced order uses that price, so only a Market order may borrow it.
      const referencePrice = q?.reference ?? (ticket.type === "MKT" && notional !== undefined && notional > 0 ? round4(notional / ticket.quantity) : null);
      const name = clean(ei?.symbolDescription) || q?.companyName || "";

      return {
        position: ps,
        referencePrice,
        quote: q?.quote ?? null,
        instrument: name ? { name } : null,
        estimate,
        warnings,
        notices: [],
        brokerState: { previewId, previewTime: positiveId(pr.previewTime) ?? now(), orderAction: action, order },
      };
    },

    async placeOrder(ctx, input) {
      const { connection, account } = ctx;
      const { ticket, brokerState } = input;
      const previewId = positiveId(brokerState?.previewId);
      if (previewId === null || !brokerState.order || typeof brokerState.order !== "object") throw new OrderNotSentError(409, S.incomplete);
      if (orderAction(ticket.side, input.position.qty) !== brokerState.orderAction) {
        throw new OrderNotSentError(409, `Your ${ticket.symbol} position changed since the preview. Preview the order again.`, "position_changed");
      }
      const order = buildOrder(ticket, /** @type {OrderAction} */ (brokerState.orderAction));
      if (canonical(order) !== canonical(brokerState.order)) throw new OrderNotSentError(409, S.noLongerMatches);

      // The order numbers E*TRADE already lists for this symbol, so a reconcile never takes one of them.
      try {
        const json = await readOrders(ctx, { symbol: ticket.symbol, count: 25 });
        const knownOrderIds = orderList(json)
          .map((o) => String(o?.orderId ?? ""))
          .filter((id) => id);
        await ctx.saveBrokerState({ knownOrderIds });
      } catch (e) {
        log.warn("etrade order snapshot failed", { connectionId: connection.id, requestId: ctx.requestId, error: e });
        throw new OrderNotSentError(502, S.snapshotFailed);
      }
      if (ctx.deadline - now() < MIN_SEND_MS) throw new OrderNotSentError(504, S.tooLongToSend);

      /** @type {SendResult} */
      let result;
      try {
        result = await withWriteSession(connection, (client, tokens) =>
          client.signedSend(
            "POST",
            `/v1/accounts/${keyOf(account)}/orders/place.json`,
            tokens,
            { root: "PlaceOrderRequest", value: { orderType: "EQ", clientOrderId: input.clientOrderId, PreviewIds: [{ previewId }], Order: [order] } },
            { timeoutMs: Math.min(PLACE_CALL_MS, ctx.deadline - now()), timeLeft: () => ctx.deadline - now(), minLeftMs: MIN_SEND_MS },
          ),
        );
      } catch (e) {
        // signedSend throws only before the request goes out (allowlist, limiter); withWriteSession only
        // before it runs it. Nothing reached E*TRADE.
        if (e instanceof OrderNotSentError) throw e;
        if (e instanceof HttpError && e.code === "not_sent") throw new OrderNotSentError(504, S.tooLongToSend);
        if (e instanceof HttpError) throw new OrderNotSentError(e.status === 429 ? 429 : 409, e.message, e.status === 429 ? "rate_limited" : e.code);
        log.error("etrade order stopped before sending", { connectionId: connection.id, requestId: ctx.requestId, error: e });
        throw new OrderNotSentError(409, S.stoppedHere);
      }

      // From here on nothing throws: the order may be at E*TRADE.
      /** @type {PlaceOutcome} */
      let out;
      try {
        out = placeOutcome(result, ticket, order, account.display_number);
      } catch (e) {
        log.error("etrade order answer unreadable", { connectionId: connection.id, requestId: ctx.requestId, error: e });
        out = { status: "unknown", error: S.unknown };
      }
      log.info("etrade order outcome", {
        connectionId: connection.id,
        requestId: ctx.requestId,
        outcome: out.status,
        brokerCode: result?.kind === "rejected" ? result.code : result?.kind === "unknown" ? (result.code ?? result.reason) : null,
      });
      return out;
    },

    async reconcileOrder(ctx, input) {
      const { ticket, brokerState } = input;
      const sentMs = parseTime(input.sentAt) ?? positiveId(brokerState?.previewTime) ?? now();
      /** @type {any} */
      let json;
      try {
        json = await readOrders(ctx, { symbol: ticket.symbol, count: 25, fromDate: mmddyyyy(sentMs), toDate: mmddyyyy(now()) });
      } catch (e) {
        log.info("etrade reconcile read failed", { connectionId: ctx.connection.id, requestId: ctx.requestId, code: codeOf(e) });
        return { found: null, reason: S.checkLater };
      }
      const previewTime = positiveId(brokerState?.previewTime);
      const action = upper(brokerState?.orderAction);
      if (previewTime === null || !action) return { found: false };
      const known = new Set(arr(brokerState.knownOrderIds).map(String));
      const priceType = ETRADE_PRICE_TYPE[ticket.type];
      const term = termOf(ticket);
      const ids = orderList(json)
        .filter((o) => {
          const id = String(o?.orderId ?? "");
          if (!ORDER_ID_RE.test(id) || known.has(id)) return false;
          const d = arr(o.OrderDetail)[0];
          const i = arr(d?.Instrument)[0];
          if (!d || !i) return false;
          const placed = num(d.placedTime);
          if (placed === undefined || placed < previewTime - PLACED_SLACK_MS) return false;
          if (upper(i.orderAction) !== action) return false;
          if (num(i.orderedQuantity) !== ticket.quantity) return false;
          if (symbolOf(i.Product?.symbol) !== ticket.symbol) return false;
          if (upper(d.priceType) !== priceType || upper(d.orderTerm) !== term) return false;
          // Only the prices the type uses: E*TRADE lists an unused price as 0.
          if ((ticket.type === "LMT" || ticket.type === "STP_LMT") && !near(num(d.limitPrice), /** @type {number} */ (ticket.limitPrice))) return false;
          if ((ticket.type === "STP" || ticket.type === "STP_LMT") && !near(num(d.stopPrice), /** @type {number} */ (ticket.stopPrice))) return false;
          return true;
        })
        .map((o) => String(o.orderId));
      if (ids.length === 1) return { found: true, brokerOrderId: ids[0] };
      if (ids.length === 0) return { found: false };
      return { found: false, detail: `E*TRADE lists ${ids.length} orders that match this one (numbers ${ids.join(", ")}). Check them before you place it again.` };
    },

    async cancelOrder(ctx, brokerOrderId) {
      const { connection, account } = ctx;
      const id = String(brokerOrderId ?? "");
      if (!ORDER_ID_RE.test(id) || !Number.isSafeInteger(Number(id))) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });

      /** @param {any} json */
      const findIn = (json) => orderList(json).find((o) => String(o?.orderId ?? "") === id);
      let found = findIn(await readOrders(ctx, { status: "OPEN", count: 100 }));
      if (!found) found = findIn(await readOrders(ctx, { count: 100 }));
      if (!found) throw new HttpError(404, S.cancelNotFound, { code: "order_not_open" });
      const status = upper(arr(found.OrderDetail)[0]?.status);
      if (status === "CANCEL_REQUESTED") return { status: "cancel_requested", message: S.cancelAlready };
      if (DONE[status]) throw new HttpError(409, `This order is already ${DONE[status]} at E*TRADE.`, { code: "not_cancellable" });

      /** @type {SendResult} */
      let r;
      try {
        r = await withWriteSession(connection, (client, tokens) =>
          client.signedSend(
            "PUT",
            `/v1/accounts/${keyOf(account)}/orders/cancel.json`,
            tokens,
            { root: "CancelOrderRequest", value: { orderId: Number(id) } },
            { timeoutMs: Math.min(CANCEL_CALL_MS, Math.max(1_000, ctx.deadline - now())), timeLeft: () => ctx.deadline - now() },
          ),
        );
      } catch (e) {
        // Before the request went out: nothing was cancelled.
        if (e instanceof HttpError && e.status === 429) throw rateLimited(S.cancelLimited, e.retryAfterSec);
        throw e;
      }
      log.info("etrade cancel outcome", {
        connectionId: connection.id,
        outcome: r.kind,
        brokerCode: r.kind === "rejected" ? r.code : r.kind === "unknown" ? (r.code ?? r.reason) : null,
      });
      if (r.kind === "ok") return { status: "cancel_requested", message: S.cancelRequested };
      if (r.kind === "rejected") {
        if (r.code === 4148) return { status: "cancelled", message: S.cancelledBefore };
        if (r.code === 670000) throw new HttpError(404, S.cancelNotFound, { code: "order_not_open" });
        throw new HttpError(409, r.message ? `E*TRADE: ${r.message}` : `E*TRADE refused the cancel (code ${r.code}).`, { code: "not_cancellable" });
      }
      if (r.kind === "auth") throw new HttpError(409, S.cancelAuth, { code: "connection_not_live" });
      if (r.kind === "rate_limited") throw rateLimited(S.cancelLimited);
      throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
    },
  };
}
