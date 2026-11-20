import { HttpError, ReadOnlyViolation } from "../errors.mjs";
import { clean, num, num0 } from "../mapping.mjs";
import { CLIENT_ORDER_ID_RE, formatPrice, OrderNotSentError, saferPosition } from "../order-contract.mjs";
import { ALPACA_RATE_PER_SEC, createAlpacaTradeClient } from "./client.mjs";
import { alpacaOrderType, alpacaPosition, legRoleOf } from "./mapping.mjs";

/**
 * Alpaca order entry (the trading part of method alpaca_key, docs/real-backend.md section 13). Only the
 * order core (src/orders.mjs) calls it, inside the lock "order:<connectionId>", after the workspace switch.
 *
 * - Clients (client.mjs createAlpacaTradeClient): `trade` for the reads and the cancel of one order
 *   (ALPACA_TRADE_ALLOW, the connection's bucket), `send` for POST /v2/orders only (ALPACA_SEND_ALLOW, no
 *   bucket: the token is taken here before the POST, so a limiter refusal is "not sent"), and `data` for
 *   the IEX quote on the market data host. Every call is `raw: true`: Alpaca answers business refusals
 *   with 403 and 422 and their bodies are read. Nothing here ever expires the connection (the read path
 *   does that); a 403 from the data host only means the plan has no such feed.
 * - Alpaca has no order preview: the preview reads the account, the asset, the position, the working
 *   orders, the quote and the clock, and sends nothing.
 * - A place is one POST with Nasscord's client_order_id, never repeated. A timeout, a socket error, a 5xx,
 *   Alpaca's own 429 or an answer this file does not list is "unknown", and reconcileOrder looks the order
 *   up by its client order id (a 404 there never means it was not placed).
 * - The account is ctx.account, checked against GET /v2/account; the key is the connection's stored key,
 *   bound to its host. Logs ids, statuses, Alpaca codes and x-request-id only.
 */

/** @typedef {import("../order-contract.mjs").Ticket} Ticket */
/** @typedef {import("../order-contract.mjs").OrderCtx} OrderCtx */
/** @typedef {import("../order-contract.mjs").PositionState} PositionState */
/** @typedef {import("../order-contract.mjs").OrderWarning} OrderWarning */
/** @typedef {import("../order-contract.mjs").Quote} Quote */
/** @typedef {import("../order-contract.mjs").Instrument} Instrument */
/** @typedef {import("../order-contract.mjs").BrokerOrderRef} BrokerOrderRef */
/** @typedef {import("../order-contract.mjs").PlaceOutcome} PlaceOutcome */
/** @typedef {import("../order-contract.mjs").ReconcileOutcome} ReconcileOutcome */
/** @typedef {import("../order-contract.mjs").TradingAdapter} TradingAdapter */
/** @typedef {import("../order-contract.mjs").TradingCapabilities} TradingCapabilities */
/** @typedef {import("../db.mjs").ConnectionRow} ConnectionRow */
/** @typedef {import("../http.mjs").RawResponse} RawResponse */
/** @typedef {import("./client.mjs").AlpacaTradeClient} AlpacaTradeClient */
/** @typedef {{ keyId: string, secretKey: string, host: "live" | "paper" }} AlpacaSecret */

/** Nasscord's ticket types as Alpaca's order types. */
export const ALPACA_TYPE = Object.freeze({ MKT: "market", LMT: "limit", STP: "stop", STP_LMT: "stop_limit" });

/** Each read of a preview, at most (also capped by the deadline). */
const READ_MS = 6_000;
/** A quote read, at most. */
const DATA_MS = 5_000;
/** The order POST, at most (also capped by the deadline). */
const SEND_MS = 10_000;
/** A cancel call, at most. */
const CANCEL_MS = 10_000;
/** A place needs at least this much of the deadline left before the POST. */
const MIN_SEND_MS = 3_000;
/** Open orders read for one symbol; a full page means the list may be incomplete. */
const OPEN_PAGE = 500;
/** A bracket exit this close to the quote (as a share of it) gets a warning. */
const EXIT_NEAR = 0.005;
/** Prices in Alpaca's answer count as equal within this. */
const PRICE_EPSILON = 0.00005;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Alpaca order statuses after which nothing can be cancelled. */
const FINAL = /** @type {Record<string, string>} */ ({ filled: "filled", canceled: "cancelled", cancelled: "cancelled", expired: "expired", rejected: "rejected", replaced: "replaced" });

/** Sentences of this adapter (docs/real-backend.md section 13). */
const S = Object.freeze({
  notConnected: "Alpaca is not connected right now. Reconnect it in Brokers, then try again.",
  paperKeyOnLive: "This Alpaca key belongs to a paper account, but the connection is saved as Live. Nothing was sent. Reconnect Alpaca.",
  liveKeyOnPaper: "This Alpaca key belongs to a live account, but the connection is saved as Paper. Nothing was sent. Reconnect Alpaca.",
  keyRefused: "Alpaca did not accept the key of this connection. Reconnect Alpaca.",
  otherAccount: "Alpaca answered for another account than this connection. Nothing was sent. Reconnect Alpaca.",
  blocked: "Alpaca blocks trading on this account right now.",
  suspendedByUser: "Trading is switched off in your Alpaca account settings.",
  previewDown: "Alpaca did not answer the preview. Nothing was placed. Try again.",
  placeDown: "Alpaca did not answer before the order could be sent. Nothing was placed. Try again.",
  tooLong: "Alpaca took too long before the order could be sent. Nothing was placed.",
  placeLimited: "Alpaca is limiting requests right now. Nothing was placed. Try again in a few seconds.",
  stoppedHere: "Nasscord stopped this order before it went to Alpaca. Nothing was placed.",
  workingUnreadable:
    "Alpaca did not list your working orders, so Nasscord cannot check them against this order. Nothing was placed. Try again in a few seconds.",
  unknown: "Nasscord could not confirm whether Alpaca received this order. Check Orders before you place it again.",
  duplicateId: "Alpaca says this order id was already used, so an earlier attempt may have reached it. Check Orders before you place it again.",
  placeAuth: "Alpaca did not accept the key of this connection, so it did not take the order. Nothing was placed.",
  echoMismatch: "Alpaca's confirmation shows different details than you entered. Check it in Orders now.",
  gtcExpiry: "Alpaca cancels GTC orders 90 days after they are placed.",
  exitNear: "Alpaca may refuse a stop-loss or take-profit this close to the current price.",
  checkLater: "Alpaca could not be asked right now. Nasscord checks again in a few seconds.",
  cancelNotOpen: "This order is not open at Alpaca any more.",
  cancelAlready: "Alpaca is already cancelling this order.",
  cancelReplacing: "Alpaca is replacing this order right now. Try the cancel again in a moment.",
  cancelRequested: "Alpaca received the cancel. The order shows as cancelled once Alpaca confirms it, and it can still fill until then.",
  cancelRefused: "Alpaca says this order can no longer be cancelled.",
  cancelLimited: "Alpaca is limiting requests right now. Nothing was cancelled. Try again in a few seconds.",
  cancelNoAnswer: "Alpaca did not answer about this order. Nothing was cancelled. Try the cancel again in a few seconds.",
  cancelUnknown: "Nasscord could not confirm the cancel with Alpaca. Check Orders: the order may still be working.",
});

/** @param {string} sym */
const positionUnreadable = (sym) => `Nasscord could not read your ${sym} position at Alpaca. Nothing was placed.`;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} s @returns {s is AlpacaSecret} */
const isKey = (s) => isObj(s) && typeof s.keyId === "string" && typeof s.secretKey === "string" && !!s.keyId && !!s.secretKey;
/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;
/** @param {number} n */
const round4 = (n) => Math.round(n * 10_000) / 10_000;
/** A broker string shown to a user: no control characters, at most `max` characters. @param {unknown} v @param {number} max */
const plain = (v, max) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
/** "$1,234.50" @param {number} n */
const money = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** @param {number | undefined} a @param {number | null | undefined} b */
const samePrice = (a, b) => (b === null || b === undefined ? a === undefined : a !== undefined && Math.abs(a - b) < PRICE_EPSILON);
/** @param {string} msg */
const nothingPlaced = (msg) => (/Nothing was (placed|sent)/.test(msg) ? msg : `${msg} Nothing was placed.`);

/** @param {RawResponse} r */
const brokerCodeOf = (r) => (isObj(r.json) && (typeof r.json.code === "number" || typeof r.json.code === "string") ? String(r.json.code).slice(0, 20) : null);
/** @param {RawResponse} r */
const messageOf = (r) => (isObj(r.json) ? plain(r.json.message, 300) : "");
/** @param {RawResponse} r */
const xRequestIdOf = (r) => {
  const v = r.headers?.get?.("x-request-id") ?? "";
  return REQUEST_ID_RE.test(v) ? v : null;
};

/**
 * The bracket roles of an Alpaca order answer: the order itself (the entry) and each leg, by its
 * group_role, else by its type.
 * @param {any} o
 * @returns {BrokerOrderRef[]}
 */
export function alpacaOrderRefs(o) {
  /** @type {BrokerOrderRef[]} */
  const refs = [{ id: clean(o?.id), role: "entry" }];
  for (const leg of Array.isArray(o?.legs) ? o.legs : []) {
    const id = clean(leg?.id);
    if (!id || id.length > 64) continue;
    const role = legRoleOf(leg, alpacaOrderType(leg?.type ?? leg?.order_type), true);
    refs.push(role ? { id, role } : { id });
  }
  return refs;
}

/**
 * The exact POST /v2/orders body of a ticket. position_intent, notional, legs and advanced_instructions are
 * never sent. A bracket is always "gtc" (D18: the core refuses any other term for it).
 * @param {Ticket} ticket
 * @param {string} clientOrderId
 */
export function alpacaOrderBody(ticket, clientOrderId) {
  /** @type {Record<string, any>} */
  const body = {
    symbol: ticket.symbol,
    qty: String(ticket.quantity),
    side: ticket.side === "BUY" ? "buy" : "sell",
    type: ALPACA_TYPE[ticket.type],
    time_in_force: ticket.tif === "GTC" ? "gtc" : "day",
    client_order_id: clientOrderId,
    extended_hours: false,
  };
  if (ticket.limitPrice !== null && ticket.limitPrice !== undefined) body.limit_price = formatPrice(ticket.limitPrice);
  if (ticket.stopPrice !== null && ticket.stopPrice !== undefined) body.stop_price = formatPrice(ticket.stopPrice);
  if (ticket.bracket) {
    body.order_class = "bracket";
    body.take_profit = { limit_price: formatPrice(ticket.bracket.takeProfit.limitPrice) };
    body.stop_loss = { stop_price: formatPrice(ticket.bracket.stopLoss.stopPrice) };
    if (ticket.bracket.stopLoss.limitPrice !== null && ticket.bracket.stopLoss.limitPrice !== undefined) {
      body.stop_loss.limit_price = formatPrice(ticket.bracket.stopLoss.limitPrice);
    }
  }
  return body;
}

/**
 * The sentence for an order Alpaca refused (400, 403, 404 or 422 with a message).
 * @param {string} message Alpaca's message
 * @param {any} json Alpaca's whole error body (buying_power, available)
 * @param {number} [status]
 */
export function alpacaSentence(message, json, status) {
  const m = String(message ?? "").toLowerCase();
  if (m.includes("insufficient buying power")) {
    const bp = num(json?.buying_power);
    return bp !== undefined && bp >= 0 ? `Alpaca: not enough buying power for this order (${money(bp)} available).` : "Alpaca: not enough buying power for this order.";
  }
  if (m.includes("insufficient qty available")) {
    const fromBody = num(json?.available);
    const fromText = /available:\s*([0-9.]+)/i.exec(String(message));
    const available = fromBody ?? (fromText ? num(fromText[1]) : undefined);
    return available !== undefined
      ? `Alpaca: only ${available} shares are free to sell; working orders reserve the rest.`
      : "Alpaca: fewer shares are free to sell than this order; working orders reserve the rest.";
  }
  if (m.includes("wash trade")) return "Alpaca blocks this order because it could trade against your own working order. Cancel that order, or use a bracket.";
  if (m.includes("not allowed to short")) return "This Alpaca account cannot sell short.";
  if (m.includes("not authorized to trade")) return "Alpaca says this account cannot trade right now. Check the account in Alpaca.";
  if (m.includes("liquidation only")) return "Alpaca allows only closing trades on this account right now.";
  if (m.includes("pattern day trading")) return "Alpaca refused the order under its day-trading protection.";
  if (m.includes("sub-penny")) return "Alpaca: the price has too many decimals.";
  if (m.includes("base_price")) return "Alpaca: the stop-loss or take-profit is too close to the current price.";
  const text = plain(message, 200);
  if (text) return `Alpaca: ${text}`;
  return `Alpaca refused the order (${status ?? "no status"}).`;
}

/**
 * @param {{
 *   deps: import("../adapter-types.mjs").AdapterDeps,
 *   hosts: { live: string, paper: string, data: string },
 *   log: import("../log.mjs").Logger,
 *   now: () => number,
 * }} o
 * @returns {TradingAdapter}
 */
export function createAlpacaOrders({ deps, hosts, log, now }) {
  /** Connections already logged for a paper account number without "PA" (once each). */
  const paperWithoutPa = new Set();

  /** @param {ConnectionRow} conn */
  const bucketKeyOf = (conn) => `alpaca:${conn.id}`;

  /**
   * The order clients of the connection's stored key. The key must be active and bound to the
   * connection's host. A 401 or 403 later never expires the connection here.
   * @param {ConnectionRow} conn
   * @returns {Promise<AlpacaTradeClient>}
   */
  async function tradeClient(conn) {
    if (conn.status !== "active") throw new HttpError(409, S.notConnected, { code: "connection_not_live" });
    const secret = await deps.oauth2.loadSecret(conn.id);
    if (!isKey(secret)) throw new HttpError(409, S.notConnected, { code: "connection_not_live" });
    const host = conn.environment === "paper" ? "paper" : "live";
    if (secret.host !== host) throw new HttpError(409, secret.host === "paper" ? S.paperKeyOnLive : S.liveKeyOnPaper, { code: "environment_mismatch" });
    return createAlpacaTradeClient({
      http: deps.http,
      base: hosts[host],
      dataBase: hosts.data,
      keyId: secret.keyId,
      secretKey: secret.secretKey,
      bucketKey: bucketKeyOf(conn),
    });
  }

  /**
   * Milliseconds a call may take: at most `capMs` and what is left of the deadline.
   * @param {OrderCtx} ctx @param {number} capMs
   */
  function budget(ctx, capMs) {
    const left = ctx.deadline - now();
    if (left <= 0) throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
    return Math.min(capMs, left);
  }

  /**
   * GET /v2/account, checked against the connection and the account (preview and place).
   * @param {AlpacaTradeClient} c @param {OrderCtx} ctx
   */
  async function checkAccount(c, ctx) {
    const r = await c.trade.request("GET", "/v2/account", { raw: true, timeoutMs: budget(ctx, READ_MS) });
    if (r.status === 401 || r.status === 403) throw new HttpError(409, S.keyRefused, { code: "connection_not_live" });
    if (r.status !== 200 || !isObj(r.json) || !clean(r.json.id)) throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
    const a = r.json;
    const id = clean(a.id);
    if (!ctx.connection.external_ref || id !== ctx.connection.external_ref || id !== ctx.account.external_id) {
      throw new HttpError(409, S.otherAccount, { code: "account_mismatch" });
    }
    const paperNumber = clean(a.account_number).toUpperCase().startsWith("PA");
    if (ctx.connection.environment === "production" && paperNumber) throw new HttpError(409, S.paperKeyOnLive, { code: "environment_mismatch" });
    if (ctx.connection.environment === "paper" && !paperNumber && !paperWithoutPa.has(ctx.connection.id)) {
      paperWithoutPa.add(ctx.connection.id);
      log.info("alpaca paper account number without PA", { connectionId: ctx.connection.id });
    }
    const status = clean(a.status).toUpperCase();
    if (status !== "ACTIVE") {
      const shown = status.replace(/[^A-Z0-9_]/g, "").slice(0, 40) || "no status";
      throw new HttpError(409, `Alpaca says this account cannot trade right now (${shown}).`, { code: "not_tradable" });
    }
    if (a.trading_blocked === true || a.account_blocked === true) throw new HttpError(409, S.blocked, { code: "not_tradable" });
    if (a.trade_suspended_by_user === true) throw new HttpError(409, S.suspendedByUser, { code: "not_tradable" });
    return a;
  }

  /**
   * GET /v2/assets/{SYM}: a tradable, active US stock or ETF that is not OTC (preview).
   * @param {AlpacaTradeClient} c @param {OrderCtx} ctx @param {Ticket} ticket
   * @returns {Promise<{ assetId: string, instrument: Instrument | null }>}
   */
  async function checkAsset(c, ctx, ticket) {
    const sym = ticket.symbol;
    const r = await c.trade.request("GET", `/v2/assets/${sym}`, { raw: true, timeoutMs: budget(ctx, READ_MS) });
    if (r.status === 404) throw new HttpError(400, `Alpaca does not list ${sym}.`, { code: "not_tradable" });
    if (r.status === 401 || r.status === 403) throw new HttpError(409, S.keyRefused, { code: "connection_not_live" });
    if (r.status !== 200 || !isObj(r.json)) throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
    const a = r.json;
    const assetId = clean(a.id).toLowerCase();
    const listed = clean(a.symbol).toUpperCase();
    if (
      a.class !== "us_equity" ||
      a.tradable !== true ||
      a.status !== "active" ||
      clean(a.exchange).toUpperCase() === "OTC" ||
      !UUID_RE.test(assetId) ||
      (listed && listed !== sym)
    ) {
      throw new HttpError(400, `Alpaca does not trade ${sym} as a US stock or ETF.`, { code: "not_tradable" });
    }
    if (Array.isArray(a.attributes) && a.attributes.includes("ipo") && ticket.type !== "LMT") {
      throw new HttpError(400, `${sym} has not started trading yet. Alpaca takes only Limit orders for it.`, { code: "not_tradable" });
    }
    /** @type {Instrument} */
    const instrument = {};
    const name = plain(a.name, 120);
    const exchange = plain(a.exchange, 20);
    if (name) instrument.name = name;
    if (exchange) instrument.exchange = exchange;
    return { assetId, instrument: name || exchange ? instrument : null };
  }

  /**
   * The open orders of one symbol, read flat (each bracket leg on its own). Anything but a complete list
   * throws working_orders_unreadable.
   * @param {AlpacaTradeClient} c @param {OrderCtx} ctx @param {string} sym
   * @returns {Promise<any[]>}
   */
  async function openOrders(c, ctx, sym) {
    const unreadable = () => new OrderNotSentError(409, S.workingUnreadable, "working_orders_unreadable");
    /** @type {RawResponse} */
    let r;
    try {
      r = await c.trade.request("GET", "/v2/orders", { query: { status: "open", symbols: sym, limit: OPEN_PAGE, nested: "false" }, raw: true, timeoutMs: budget(ctx, READ_MS) });
    } catch {
      throw unreadable();
    }
    if (r.status !== 200 || !Array.isArray(r.json) || r.json.length >= OPEN_PAGE) throw unreadable();
    return r.json.filter((o) => clean(o?.symbol).toUpperCase() === sym);
  }

  /**
   * Shares still to fill in working orders, per side. An order Nasscord cannot count (a notional order,
   * an unknown side) makes the list unreadable rather than counted as 0.
   * @param {any[]} list
   */
  function workingOf(list) {
    let workingSell = 0;
    let workingBuy = 0;
    for (const o of list) {
      const qty = num(o?.qty);
      const s = clean(o?.side).toLowerCase();
      if (qty === undefined || qty < 0 || (s !== "buy" && s !== "sell")) {
        throw new OrderNotSentError(409, S.workingUnreadable, "working_orders_unreadable");
      }
      const remaining = Math.max(0, qty - num0(o?.filled_qty));
      if (s === "sell") workingSell += remaining;
      else workingBuy += remaining;
    }
    return { workingSell, workingBuy };
  }

  /**
   * The signed position of the ticket's symbol (GET /v2/positions/{assetId}) and, when the ticket needs
   * them, the working orders.
   * @param {AlpacaTradeClient} c @param {OrderCtx} ctx @param {Ticket} ticket @param {string} assetId
   * @returns {Promise<{ position: PositionState, open: any[] | null }>}
   */
  async function readPositionState(c, ctx, ticket, assetId) {
    const sym = ticket.symbol;
    const unreadable = () => new OrderNotSentError(502, positionUnreadable(sym), "position_unreadable");
    if (typeof assetId !== "string" || !UUID_RE.test(assetId)) throw unreadable();
    const readQty = async () => {
      /** @type {RawResponse} */
      let r;
      try {
        r = await c.trade.request("GET", `/v2/positions/${assetId}`, { raw: true, timeoutMs: budget(ctx, READ_MS) });
      } catch {
        throw unreadable();
      }
      if (r.status === 404) return 0;
      if (r.status !== 200) throw unreadable();
      const listed = isObj(r.json) ? clean(r.json.symbol).toUpperCase() : "";
      if (!isObj(r.json) || num(r.json.qty) === undefined || (listed && listed !== sym)) throw unreadable();
      return alpacaPosition(r.json, ctx.account).qty;
    };
    const first = await readQty();
    if (ticket.side === "SELL" || ticket.intent === "close" || first < 0) {
      const open = await openOrders(c, ctx, sym);
      // The position again, after the open orders: a sell that filled meanwhile has left the open list
      // but is then in the position, and the smaller of the two reads is used.
      const qty = saferPosition(first, await readQty());
      return { position: { qty, ...workingOf(open), working: true }, open };
    }
    return { position: { qty: first, workingSell: 0, workingBuy: 0, working: false }, open: null };
  }

  /**
   * The IEX quote (best effort): the reference price is the midpoint, else the ask for a buy or the bid
   * for a sell. Any failure, a 403 for the plan included, is "no quote" and never touches the connection.
   * @param {AlpacaTradeClient} c @param {OrderCtx} ctx @param {Ticket} ticket
   * @returns {Promise<{ quote: Quote | null, referencePrice: number | null }>}
   */
  async function readQuote(c, ctx, ticket) {
    try {
      const r = await c.data.request("GET", `/v2/stocks/${ticket.symbol}/quotes/latest`, { query: { feed: "iex" }, raw: true, timeoutMs: budget(ctx, DATA_MS) });
      if (r.status !== 200 || !isObj(r.json) || !isObj(r.json.quote)) return { quote: null, referencePrice: null };
      const q = r.json.quote;
      const bp = num(q.bp);
      const ap = num(q.ap);
      const bid = bp !== undefined && bp > 0 ? bp : undefined;
      const ask = ap !== undefined && ap > 0 ? ap : undefined;
      if (bid === undefined && ask === undefined) return { quote: null, referencePrice: null };
      /** @type {Quote} */
      const quote = { source: "IEX bid and ask (one exchange, not the whole market)" };
      if (bid !== undefined) quote.bid = bid;
      if (ask !== undefined) quote.ask = ask;
      const at = Date.parse(clean(q.t));
      if (Number.isFinite(at)) quote.at = new Date(at).toISOString();
      /** @type {number | null} */
      let referencePrice = null;
      if (bid !== undefined && ask !== undefined) referencePrice = round4((bid + ask) / 2);
      else if (ticket.side === "BUY" && ask !== undefined) referencePrice = ask;
      else if (ticket.side === "SELL" && bid !== undefined) referencePrice = bid;
      return { quote, referencePrice };
    } catch {
      return { quote: null, referencePrice: null };
    }
  }

  /**
   * Alpaca's clock (best effort): without it the core uses its NYSE calendar.
   * @param {AlpacaTradeClient} c @param {OrderCtx} ctx
   * @returns {Promise<{ marketOpen?: boolean, nextOpen?: string }>}
   */
  async function readClock(c, ctx) {
    try {
      const r = await c.trade.request("GET", "/v2/clock", { raw: true, timeoutMs: budget(ctx, READ_MS) });
      if (r.status !== 200 || !isObj(r.json) || typeof r.json.is_open !== "boolean") return {};
      /** @type {{ marketOpen?: boolean, nextOpen?: string }} */
      const out = { marketOpen: r.json.is_open };
      const next = Date.parse(clean(r.json.next_open));
      if (Number.isFinite(next)) out.nextOpen = new Date(next).toISOString();
      return out;
    } catch {
      return {};
    }
  }

  /**
   * A working order on the other side that Alpaca's wash trade check could set against this one.
   * @param {Ticket} ticket @param {any[]} open
   * @returns {OrderWarning | null}
   */
  function washWarning(ticket, open) {
    const other = ticket.side === "BUY" ? "sell" : "buy";
    const hit = open.some((o) => clean(o?.side).toLowerCase() === other && ["market", "stop", "stop_limit"].includes(clean(o?.type ?? o?.order_type).toLowerCase()));
    if (!hit) return null;
    return {
      code: "wash_trade_risk",
      text: `Alpaca may refuse this order because a working ${other} order on ${ticket.symbol} could trade against it. Cancel that order first, or use a bracket.`,
      source: "broker",
    };
  }

  /**
   * Turns any failure before the POST into "not sent".
   * @param {unknown} e
   * @returns {OrderNotSentError}
   */
  function notSent(e) {
    if (e instanceof OrderNotSentError) return e;
    if (e instanceof HttpError) {
      if (e.status === 429) return new OrderNotSentError(429, S.placeLimited, "rate_limited");
      if (e.status >= 500) return new OrderNotSentError(502, S.placeDown, "broker_unavailable");
      return new OrderNotSentError(e.status, nothingPlaced(e.message), e.code);
    }
    return new OrderNotSentError(502, S.stoppedHere, "order_not_sent");
  }

  /**
   * Echo check of the POST answer against the body that was sent.
   * @param {any} j @param {Record<string, any>} body @param {Ticket} ticket
   */
  function echoDiffers(j, body, ticket) {
    if (clean(j.client_order_id) !== body.client_order_id) return true;
    if (clean(j.symbol).toUpperCase() !== body.symbol) return true;
    if (clean(j.side).toLowerCase() !== body.side) return true;
    if (num(j.qty) !== ticket.quantity) return true;
    if (clean(j.type ?? j.order_type).toLowerCase() !== body.type) return true;
    if (!samePrice(num(j.limit_price), ticket.limitPrice)) return true;
    if (!samePrice(num(j.stop_price), ticket.stopPrice)) return true;
    if (ticket.bracket && (!Array.isArray(j.legs) || j.legs.length !== 2)) return true;
    return false;
  }

  /**
   * One status line per send: ids, statuses, Alpaca's code and request id only.
   * @param {OrderCtx} ctx @param {string} clientOrderId @param {string} outcome @param {RawResponse | null} r @param {unknown} [error]
   */
  function logSend(ctx, clientOrderId, outcome, r, error) {
    const meta = {
      requestId: ctx.requestId,
      connectionId: ctx.connection.id,
      clientOrderId,
      outcome,
      status: r ? r.status : null,
      brokerCode: r ? brokerCodeOf(r) : null,
      xRequestId: r ? xRequestIdOf(r) : null,
    };
    if (outcome === "unknown") log.warn("alpaca order outcome unknown", error === undefined ? meta : { ...meta, error });
    else log.info("alpaca order sent", meta);
  }

  /** @type {TradingAdapter} */
  const trading = {
    capabilities(connection) {
      if (connection.environment !== "production" && connection.environment !== "paper") return null;
      /** @type {TradingCapabilities} */
      const caps = {
        types: ["MKT", "LMT", "STP", "STP_LMT"],
        tif: ["DAY", "GTC"],
        marketGtc: true,
        bracket: { entryTypes: ["MKT", "LMT"], stopTypes: ["STP", "STP_LMT"] },
        notes: ["Alpaca checks prices against the whole market; the quote Nasscord shows is IEX, one exchange.", "Cancelling any order of an Alpaca bracket cancels the whole bracket."],
      };
      return caps;
    },

    async previewOrder(ctx, ticket) {
      try {
        const c = await tradeClient(ctx.connection);
        const account = await checkAccount(c, ctx);
        const { assetId, instrument } = await checkAsset(c, ctx, ticket);
        const { position, open } = await readPositionState(c, ctx, ticket, assetId);
        const [{ quote, referencePrice }, clock] = await Promise.all([readQuote(c, ctx, ticket), readClock(c, ctx)]);

        /** @type {OrderWarning[]} */
        const warnings = [];
        if (!quote) warnings.push({ code: "no_quote", text: `Alpaca's free IEX quote for ${ticket.symbol} is not available right now.`, source: "nasscord" });
        let others = open;
        if (!others) {
          try {
            others = await openOrders(c, ctx, ticket.symbol);
          } catch {
            others = null;
          }
        }
        const wash = others ? washWarning(ticket, others) : null;
        if (wash) warnings.push(wash);
        if (ticket.tif === "GTC") warnings.push({ code: "gtc_expiry", text: S.gtcExpiry, source: "broker" });
        if (ticket.bracket && referencePrice !== null) {
          const near = [ticket.bracket.takeProfit.limitPrice, ticket.bracket.stopLoss.stopPrice].some((p) => Math.abs(p / referencePrice - 1) <= EXIT_NEAR);
          if (near) warnings.push({ code: "exit_near_price", text: S.exitNear, source: "broker" });
        }

        /** @type {import("../order-contract.mjs").Estimate} */
        let estimate;
        if (ticket.type === "LMT" || ticket.type === "STP_LMT") {
          estimate = { notional: round2(ticket.quantity * /** @type {number} */ (ticket.limitPrice)), source: "Nasscord, from your limit price" };
        } else if (ticket.type === "STP") {
          estimate = { notional: round2(ticket.quantity * /** @type {number} */ (ticket.stopPrice)), source: "Nasscord, from your stop price" };
        } else {
          estimate = referencePrice !== null ? { notional: round2(ticket.quantity * referencePrice), source: "Nasscord, from the IEX quote" } : { source: "Nasscord, from the IEX quote" };
        }

        const buyingPower = num(account.buying_power);
        return {
          position,
          referencePrice,
          quote,
          instrument,
          estimate,
          ...(buyingPower !== undefined ? { buyingPower } : {}),
          ...(clock.marketOpen !== undefined ? { marketOpen: clock.marketOpen } : {}),
          ...(clock.nextOpen !== undefined ? { nextOpen: clock.nextOpen } : {}),
          warnings,
          notices: [],
          brokerState: { assetId },
        };
      } catch (e) {
        if (e instanceof OrderNotSentError) throw e;
        if (e instanceof HttpError && e.status >= 500) throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
        throw e;
      }
    },

    async positionState(ctx, ticket, brokerState) {
      try {
        const c = await tradeClient(ctx.connection);
        const { position } = await readPositionState(c, ctx, ticket, typeof brokerState?.assetId === "string" ? brokerState.assetId : "");
        return position;
      } catch (e) {
        if (e instanceof OrderNotSentError) throw e;
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw notSent(e);
        throw new OrderNotSentError(502, positionUnreadable(ticket.symbol), "position_unreadable");
      }
    },

    async placeOrder(ctx, input) {
      const { ticket } = input;
      /** @type {AlpacaTradeClient} */
      let c;
      /** @type {Record<string, any>} */
      let body;
      try {
        if (!CLIENT_ORDER_ID_RE.test(input.clientOrderId)) throw new OrderNotSentError(500, S.stoppedHere, "order_not_sent");
        c = await tradeClient(ctx.connection);
        await checkAccount(c, ctx);
        if (ctx.deadline - now() < MIN_SEND_MS) throw new OrderNotSentError(504, S.tooLong, "broker_timeout");
        try {
          await deps.limiter.take(bucketKeyOf(ctx.connection), ALPACA_RATE_PER_SEC, "Alpaca");
        } catch {
          throw new OrderNotSentError(429, S.placeLimited, "rate_limited");
        }
        if (ctx.deadline - now() < MIN_SEND_MS) throw new OrderNotSentError(504, S.tooLong, "broker_timeout");
        body = alpacaOrderBody(ticket, input.clientOrderId);
      } catch (e) {
        throw notSent(e);
      }

      // The send: from here on nothing throws, and any answer this file does not list is "unknown".
      /** @type {RawResponse} */
      let r;
      try {
        r = await c.send.request("POST", "/v2/orders", { json: body, raw: true, timeoutMs: Math.max(1, Math.min(SEND_MS, ctx.deadline - now())) });
      } catch (e) {
        if (e instanceof ReadOnlyViolation) throw new OrderNotSentError(500, S.stoppedHere, "order_not_sent");
        // Alpaca's own 429 (the send client has no bucket), a timeout or a socket error after the
        // request started: it may have reached Alpaca.
        logSend(ctx, input.clientOrderId, "unknown", null, e);
        return { status: "unknown", error: S.unknown };
      }

      const j = r.json;
      const message = messageOf(r);
      if (r.status === 200 || r.status === 201) {
        const id = isObj(j) ? clean(j.id) : "";
        if (!id || id.length > 64) {
          logSend(ctx, input.clientOrderId, "unknown", r);
          return { status: "unknown", error: S.unknown };
        }
        logSend(ctx, input.clientOrderId, "placed", r);
        /** @type {PlaceOutcome} */
        const out = { status: "placed", brokerOrderId: id, brokerOrderIds: alpacaOrderRefs(j) };
        if (echoDiffers(j, body, ticket)) out.warnings = [{ code: "alpaca_echo_mismatch", text: S.echoMismatch, source: "nasscord" }];
        return out;
      }
      if (r.status === 422 && /client_order_id must be unique/i.test(message)) {
        logSend(ctx, input.clientOrderId, "unknown", r);
        return { status: "unknown", error: S.duplicateId };
      }
      if (r.status === 401) {
        logSend(ctx, input.clientOrderId, "rejected", r);
        return { status: "rejected", error: S.placeAuth, code: "alpaca_auth" };
      }
      if ((r.status === 400 || r.status === 403 || r.status === 404 || r.status === 422) && message) {
        logSend(ctx, input.clientOrderId, "rejected", r);
        return { status: "rejected", error: alpacaSentence(message, j, r.status), code: "alpaca_refused" };
      }
      logSend(ctx, input.clientOrderId, "unknown", r);
      return { status: "unknown", error: S.unknown };
    },

    async reconcileOrder(ctx, input) {
      const later = /** @type {ReconcileOutcome} */ ({ found: null, reason: S.checkLater });
      /** @type {AlpacaTradeClient} */
      let c;
      try {
        c = await tradeClient(ctx.connection);
      } catch {
        return later;
      }
      for (const id of input.clientOrderIds) {
        if (typeof id !== "string" || !CLIENT_ORDER_ID_RE.test(id)) continue;
        if (ctx.deadline - now() <= 0) return later;
        /** @type {RawResponse} */
        let r;
        try {
          r = await c.trade.request("GET", "/v2/orders:by_client_order_id", { query: { client_order_id: id }, raw: true, timeoutMs: Math.min(READ_MS, ctx.deadline - now()) });
        } catch {
          return later;
        }
        if (r.status === 404) continue;
        const j = r.json;
        const orderId = isObj(j) ? clean(j.id) : "";
        if (r.status !== 200 || !orderId || orderId.length > 64 || clean(j?.client_order_id) !== id) return later;
        log.info("alpaca order found", { requestId: ctx.requestId, connectionId: ctx.connection.id, clientOrderId: id, status: clean(j.status).slice(0, 30) });
        return {
          found: true,
          brokerOrderId: orderId,
          brokerOrderIds: alpacaOrderRefs(j),
          ...(clean(j.status).toLowerCase() === "rejected" ? { rejected: true } : {}),
        };
      }
      return { found: false };
    },

    async cancelOrder(ctx, brokerOrderId) {
      const id = String(brokerOrderId ?? "");
      if (!UUID_RE.test(id)) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });
      const c = await tradeClient(ctx.connection);
      const limited = () => new HttpError(429, S.cancelLimited, { code: "rate_limited", retryAfterSec: 5 });

      /** @type {RawResponse} */
      let r;
      try {
        r = await c.trade.request("GET", `/v2/orders/${id}`, { raw: true, timeoutMs: Math.max(1, Math.min(CANCEL_MS, ctx.deadline - now())) });
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) throw limited();
        throw new HttpError(409, S.cancelNoAnswer, { code: "busy" });
      }
      if (r.status === 404) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });
      if (r.status === 401 || r.status === 403) throw new HttpError(409, S.keyRefused, { code: "connection_not_live" });
      if (r.status !== 200 || !isObj(r.json) || clean(r.json.id).toLowerCase() !== id) throw new HttpError(409, S.cancelNoAnswer, { code: "busy" });
      const status = clean(r.json.status).toLowerCase();
      if (FINAL[status]) throw new HttpError(409, `This order is already ${FINAL[status]} at Alpaca.`, { code: "not_cancellable" });
      if (status === "pending_cancel") return { status: "cancel_requested", message: S.cancelAlready };
      if (status === "pending_replace") throw new HttpError(409, S.cancelReplacing, { code: "not_cancellable" });

      /** @type {RawResponse} */
      let d;
      try {
        d = await c.trade.request("DELETE", `/v2/orders/${id}`, { raw: true, timeoutMs: Math.max(1, Math.min(CANCEL_MS, ctx.deadline - now())) });
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) throw limited();
        log.warn("alpaca cancel outcome unknown", { connectionId: ctx.connection.id, error: e });
        throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
      }
      log.info("alpaca cancel sent", { connectionId: ctx.connection.id, status: d.status, brokerCode: brokerCodeOf(d), xRequestId: xRequestIdOf(d) });
      if (d.status === 204 || d.status === 200) return { status: "cancel_requested", message: S.cancelRequested };
      if (d.status === 422) throw new HttpError(409, S.cancelRefused, { code: "not_cancellable" });
      if (d.status === 404) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });
      if (d.status === 401) throw new HttpError(409, S.keyRefused, { code: "connection_not_live" });
      const message = messageOf(d);
      if (d.status >= 400 && d.status < 500 && message) throw new HttpError(409, `Alpaca: ${plain(message, 200)}`, { code: "not_cancellable" });
      throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
    },
  };
  return trading;
}
