import { randomBytes } from "node:crypto";
import { HttpError, ReadOnlyViolation } from "../errors.mjs";
import { clean, num } from "../mapping.mjs";
import { formatPrice, messageTextHash, normalizeSymbol, OrderNotSentError, saferPosition } from "../order-contract.mjs";
import { parseTime } from "../time.mjs";
import { GatewayHttpError } from "./gateway-http.mjs";

/**
 * IBKR order entry through the connection's Client Portal Gateway (the trading part of method
 * ibkr_gateway, docs/real-backend.md section 13). Only the order core (src/orders.mjs) calls it, inside
 * the lock "order:<connectionId>", after the workspace switch.
 *
 * Every call goes through the gateway client's order door (gw.trade, gw.pacedGet, IBKR_TRADE_ALLOW).
 * Reads of the order path: auth status, accounts, /trsrv/stocks, contract info and rules, the market data
 * snapshot, /portfolio2 positions, what-if, order status, and the paced live orders and trades lists.
 * Order calls: one POST /iserver/account/{acct}/orders per attempt, its /iserver/reply confirmations,
 * and DELETE /iserver/account/{acct}/order/{id}. Never /iserver/questions/suppress, /iserver/notification,
 * an account switch or an order modify.
 *
 * The account number in every path is ctx.account.external_id, after ready() found it as the only account
 * of GET /iserver/accounts (IBKR order entry is for logins with one account in this release).
 */

const CONID_RE = /^[1-9][0-9]{0,11}$/;
const ORDER_ID_RE = /^[1-9][0-9]{0,18}$/;
const ACCT_RE = /^[A-Z0-9]{2,20}$/;
const REPLY_ID_RE = /^[0-9a-fA-F-]{36}$/;
/** Each read of a preview, at most. */
const PREVIEW_CALL_MS = 15_000;
/** IBKR's documented most orders in one live orders answer. */
const LIVE_ORDERS_CAP = 1_000;
/** The order POST, each reply and the cancel, at most. */
const ORDER_CALL_MS = 20_000;
/** Reply calls in one attempt, at most. */
const MAX_REPLIES = 5;
/** The order POST is sent only with at least this much of the deadline left, also after the limiter's wait. */
const SEND_MIN_MS = 5_000;
/** A reply is sent only with at least this much of the deadline left, also after the limiter's wait. */
const REPLY_MIN_MS = 2_000;

/** IBKR's question ids that Nasscord confirms when the dialog showed the matching notice (1.6). */
const AUTO_MARKET = new Set(["o10151", "o10153"]);
const AUTO_STOP = new Set(["o10152", "o10331"]);
/** IBKR's question ids Nasscord never confirms: the order is refused. */
const REFUSE = new Set(["o382", "o2165", "o10334", "o2136", "p6", "o10082", "o10138", "o10164", "o10223", "o10288", "o10332", "o10333", "o10335"]);

export const IBKR_NOTICES = Object.freeze({
  market: Object.freeze({
    key: "ibkr.market_order",
    text: "A market order fills at the next available price, which can be far from the last price at the open or in a fast market. IBKR may cap the price of a market order.",
  }),
  stop: Object.freeze({
    key: "ibkr.stop_order",
    text: "A stop order becomes a market order (a limit order for stop limit) when the stop price trades, and can fill far from the stop in a fast market.",
  }),
});

const IBKR_ORDER_TYPE = { MKT: "MKT", LMT: "LMT", STP: "STP", STP_LMT: "STOP_LIMIT" };
/** The names of /iserver/contract/rules orderTypes. */
const RULE_TYPE = { MKT: "market", LMT: "limit", STP: "stop", STP_LMT: "stop_limit" };
const RULE_LABEL = { market: "Market", limit: "Limit", stop: "Stop", stop_limit: "Stop limit" };

const S = {
  notLive: "IBKR is not logged in right now. Reconnect IBKR, then try again.",
  competing: "Another session (TWS or the IBKR mobile app) is using this IBKR username, so Nasscord will not send orders through it. Close the other session first.",
  tooLong: "IBKR took too long. Nothing was sent. Try again.",
  previewDown: "IBKR did not answer the preview. Nothing was placed. Try again.",
  previewLimited: "IBKR is limiting requests right now. Try again in a few seconds.",
  incomplete: "The preview of this order is incomplete. Preview it again.",
  earlierUnchecked: "IBKR did not list its orders yet, so Nasscord cannot check the earlier attempt. Nothing was sent. Try again in a few seconds.",
  tooLongToSend: "IBKR took too long before the order could be sent. Nothing was placed.",
  limitedNotSent: "IBKR is limiting requests right now. Nothing was placed. Try again in a few seconds.",
  stoppedHere: "Nasscord stopped this order before it went to IBKR. Nothing was placed.",
  unknown: "Nasscord could not confirm whether IBKR received this order. Check Orders before you place it again.",
  sessionEnded: "IBKR ended the session while the order was being sent. Log in to IBKR again, then check Orders before you place it again.",
  replyInvalid: "IBKR asked for a confirmation Nasscord could not send. Nothing was placed.",
  bracketIncomplete: "IBKR did not confirm the stop-loss and take-profit of this bracket. Check Orders now and add them in IBKR if they are missing.",
  bracketUnverified: "IBKR placed this bracket, but Nasscord could not check its parts. Check Orders now.",
  echoMismatch: "IBKR shows this order with details that differ from what you entered. Check it in Orders now.",
  pendingSubmit: "IBKR still shows this order as Pending submit. If it stays that way, IBKR may be waiting for a decision that only its own app shows: check it in IBKR.",
  checkNotLoggedIn: "IBKR is not logged in, so Nasscord cannot check yet.",
  checkNotListed: "IBKR has not listed its orders yet. Nasscord checks again in a few seconds.",
  fillWithoutNumber: "IBKR lists a fill with this order's reference but no order number. The order was placed: check it in IBKR.",
  cancelNotOpen: "This order is not open at IBKR any more, or this IBKR login does not list it.",
  cancelBusy: "IBKR did not list its orders yet. Try the cancel again in a few seconds.",
  cancelLimited: "IBKR is limiting requests right now. Nothing was cancelled. Try again in a few seconds.",
  cancelUnknown: "Nasscord could not confirm the cancel with IBKR. Check Orders: the order may still be working.",
  cancelling: "IBKR is already cancelling this order.",
  cancelled: "IBKR cancelled the order.",
  cancelRequested: "IBKR received the cancel. The order shows as cancelled once IBKR confirms it, and it can still fill until then.",
};

/** @param {number} n */
const multiAccountSentence = (n) =>
  `Nasscord places IBKR orders only for logins with one account for now. This login has ${n} accounts: place their orders in IBKR.`;

/** @param {string} symbol */
const positionUnreadable = (symbol) => `Nasscord could not read your ${symbol} position at IBKR. Nothing was placed.`;
const WORKING_UNREADABLE =
  "IBKR did not list your working orders, so Nasscord cannot check them against this order. Nothing was placed. Try again in a few seconds.";

/**
 * @typedef {import("../order-contract.mjs").Ticket} Ticket
 * @typedef {import("../order-contract.mjs").OrderCtx} OrderCtx
 * @typedef {import("../order-contract.mjs").PositionState} PositionState
 * @typedef {import("../order-contract.mjs").PlaceInput} PlaceInput
 * @typedef {import("../order-contract.mjs").PlaceOutcome} PlaceOutcome
 * @typedef {import("../order-contract.mjs").ReconcileOutcome} ReconcileOutcome
 * @typedef {import("../order-contract.mjs").BrokerMessage} BrokerMessage
 * @typedef {import("../order-contract.mjs").OrderWarning} OrderWarning
 * @typedef {import("../order-contract.mjs").BrokerOrderRef} BrokerOrderRef
 * @typedef {import("../order-contract.mjs").Quote} Quote
 * @typedef {"preview" | "place" | "cancel" | "reconcile"} Mode
 *   How a failure before anything is sent is thrown: an HttpError (preview, cancel, reconcile) or an
 *   OrderNotSentError (place).
 * @typedef {{ cid: string, port: number, acct: string }} Ready
 */

/**
 * The order bodies of a ticket (what-if and place). Numbers stay JSON numbers. Children never carry
 * cOID; isSingleGroup, secType, listingExchange, cashQty and manualOrderTime are never sent.
 * @param {Ticket} ticket
 * @param {number} conid
 * @param {string} acct
 * @param {string | null} cOID
 */
export function buildTickets(ticket, conid, acct, cOID) {
  const base = { acctId: acct, conid, side: ticket.side, quantity: ticket.quantity, tif: ticket.tif, outsideRTH: false };
  /** @type {Record<string, unknown>} */
  const main = { ...base, orderType: IBKR_ORDER_TYPE[ticket.type] };
  if (ticket.type === "LMT") main.price = ticket.limitPrice;
  if (ticket.type === "STP") main.price = ticket.stopPrice; // a STP order's stop goes in "price" (research IBKR 4.2, UNCONFIRMED: paper check)
  if (ticket.type === "STP_LMT") {
    main.price = ticket.limitPrice;
    main.auxPrice = ticket.stopPrice;
  }
  if (cOID) main.cOID = cOID;
  if (!ticket.bracket) return [main];
  const stopLoss = { ...base, side: "SELL", parentId: cOID, orderType: "STP", price: ticket.bracket.stopLoss.stopPrice };
  const takeProfit = { ...base, side: "SELL", parentId: cOID, orderType: "LMT", price: ticket.bracket.takeProfit.limitPrice };
  return [main, stopLoss, takeProfit];
}

/**
 * The first number of an IBKR display string ("1,855.00 USD (10 Shares)" is 1855).
 * @param {unknown} s
 * @returns {number | undefined}
 */
export function parseIbkrMoney(s) {
  if (typeof s !== "string" && typeof s !== "number") return undefined;
  const m = /-?[0-9][0-9,]*(\.[0-9]+)?/.exec(String(s));
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Working orders of one account and contract in a complete live orders list. Every open order
 * counts at its remaining quantity on its own (the two exits of a bracket count twice).
 * @param {any[]} orders
 * @param {string} acct
 * @param {number} conid
 * @returns {{ workingSell: number, workingBuy: number }}
 */
export function workingOf(orders, acct, conid) {
  let workingSell = 0;
  let workingBuy = 0;
  for (const o of orders) {
    if (!o || typeof o !== "object") continue;
    if (String(o.acct ?? o.account) !== acct || Number(o.conid) !== conid) continue;
    const status = String(o.status ?? "").toLowerCase().replace(/\s+/g, "");
    if (status === "filled" || status === "cancelled" || status === "apicancelled") continue;
    const rem = num(o.remainingQuantity);
    const left = Math.max(0, rem !== undefined ? rem : (num(o.totalSize) ?? 0) - (num(o.filledQuantity) ?? 0));
    const side = String(o.side ?? "").toUpperCase();
    if (side.startsWith("S")) workingSell += left;
    else if (side.startsWith("B")) workingBuy += left;
  }
  return { workingSell, workingBuy };
}

/** @param {unknown} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {string} s */
const clip = (s) => String(s).trim().slice(0, 200);
/** @param {number} n */
const round4 = (n) => Math.round(n * 10_000) / 10_000;

/**
 * A strict number: a finite number, or a numeric string. Empty, null and other values are NaN.
 * @param {unknown} v
 */
function strictNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v.replace(/,/g, "").trim());
  return Number.NaN;
}

/** @param {unknown} v snapshot field: "C185.12" (close) or "H185.12" (halted) carry a leading letter */
function snapshotPrice(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = num(String(v).trim().replace(/^[A-Za-z]/, ""));
  return n !== undefined && n > 0 ? n : undefined;
}

/** @param {unknown} raw order type of an order status answer or a live orders row */
function typeKind(raw) {
  const t = String(raw ?? "").toUpperCase().replace(/[\s_-]/g, "");
  if (t.startsWith("STOP") || t.startsWith("STP")) return "stop";
  if (t === "LIMIT" || t === "LMT") return "limit";
  if (t === "MARKET" || t === "MKT") return "market";
  return "";
}

/** @param {unknown} a @param {unknown} b */
const sameNumber = (a, b) => {
  const x = strictNumber(a);
  const y = strictNumber(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-6;
};

/** @param {unknown} v */
const present = (v) => v !== undefined && v !== null && v !== "";

/**
 * @param {{
 *   gw: import("./gateway-http.mjs").GatewayHttp,
 *   manager: { portFor: (cid: string) => number | null },
 *   sessions: { isAuthenticated: (cid: string) => boolean },
 *   log: import("../log.mjs").Logger,
 *   now: () => number,
 *   stopOrders: "off" | "paper" | "on",
 *   brackets: "off" | "paper" | "on",
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {import("../order-contract.mjs").TradingAdapter}
 */
export function createIbkrOrders({ gw, manager, sessions, log, now, stopOrders, brackets, sleep }) {
  const wait = sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));

  /** @param {Mode} mode @param {number} status @param {string} message @param {string} code */
  const fail = (mode, status, message, code) =>
    mode === "place" ? new OrderNotSentError(status, message, code) : new HttpError(status, message, { code });

  /**
   * A port for a connection whose IBKR session is open.
   * @param {OrderCtx} ctx @param {Mode} mode
   */
  function livePort(ctx, mode) {
    const cid = ctx.connection.id;
    const port = manager.portFor(cid);
    if (ctx.connection.status !== "active" || !port || !sessions.isAuthenticated(cid)) {
      throw fail(mode, 409, S.notLive, "connection_not_live");
    }
    return port;
  }

  /**
   * One read of the order path, capped by the deadline.
   * @param {OrderCtx} ctx @param {Mode} mode @param {number} port
   * @param {"GET" | "POST"} method @param {string} path @param {unknown} [body]
   */
  function readCall(ctx, mode, port, method, path, body) {
    const left = ctx.deadline - now();
    if (left <= 0) throw fail(mode, 504, S.tooLong, "broker_timeout");
    return gw.trade(ctx.connection.id, port, method, path, body, { timeoutMs: Math.min(PREVIEW_CALL_MS, left), notAfter: ctx.deadline });
  }

  /**
   * Before every preview, place, reconcile and cancel: a live session that is not competing, and
   * the account as the only account of the login, on the right side of paper and live.
   * @param {OrderCtx} ctx @param {Mode} mode
   * @returns {Promise<Ready>}
   */
  async function ready(ctx, mode) {
    const cid = ctx.connection.id;
    const port = livePort(ctx, mode);
    const acct = ctx.account.external_id;
    /** @param {Promise<{ status: number, json: any }>} p */
    const answer = async (p) => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof GatewayHttpError && e.code === "not_sent") {
          const limited = mode === "place" ? S.limitedNotSent : mode === "cancel" ? S.cancelLimited : S.previewLimited;
          throw fail(mode, 429, limited, "rate_limited");
        }
        throw fail(mode, 409, S.notLive, "connection_not_live");
      }
    };
    const status = await answer(readCall(ctx, mode, port, "GET", "/iserver/auth/status"));
    if (status.status === 200 && status.json?.competing === true) throw fail(mode, 409, S.competing, "connection_not_live");
    if (status.status !== 200 || status.json?.authenticated !== true) throw fail(mode, 409, S.notLive, "connection_not_live");
    const accounts = await answer(readCall(ctx, mode, port, "GET", "/iserver/accounts"));
    const list = accounts.status === 200 && Array.isArray(accounts.json?.accounts) ? accounts.json.accounts.map(String) : null;
    if (!list) throw fail(mode, 409, S.notLive, "connection_not_live");
    if (!ACCT_RE.test(acct) || !list.includes(acct)) {
      throw fail(mode, 409, `IBKR does not list account ${ctx.account.display_number} in this login. Reconnect IBKR.`, "account_mismatch");
    }
    if (list.length !== 1) throw fail(mode, 409, multiAccountSentence(list.length), "multi_account_login");
    const wantPaper = ctx.connection.environment === "paper";
    const prefixPaper = /^D[UF]/i.test(acct);
    const isPaper = accounts.json.isPaper;
    /** @param {boolean} loginPaper */
    const mismatch = (loginPaper) =>
      fail(
        mode,
        409,
        `This is a ${loginPaper ? "paper" : "live"} IBKR login, but the connection is saved as ${wantPaper ? "Paper" : "Live"}. Nothing was sent. Reconnect IBKR with the right username.`,
        "environment_mismatch",
      );
    if (prefixPaper !== wantPaper) throw mismatch(prefixPaper);
    if (typeof isPaper === "boolean" && isPaper !== wantPaper) throw mismatch(isPaper);
    if (accounts.json.acctProps?.[acct]?.allowCustomerTime === true) {
      throw fail(mode, 409, "This IBKR account needs a manual order time, which Nasscord does not send. Place orders for it in IBKR.", "not_tradable");
    }
    return { cid, port, acct };
  }

  /**
   * A paced list read for order code. Complete only when it is not the session's pre-flight and
   * has the expected shape; an incomplete first read is followed by one more, 5 s later, when the
   * deadline allows.
   * @param {OrderCtx} ctx @param {Ready} g @param {string} path
   * @param {(r: import("./gateway-http.mjs").PacedAnswer) => any[] | null} listOf
   * @param {number} notBefore
   * @returns {Promise<{ complete: true, items: any[] } | { complete: false }>}
   */
  async function pacedList(ctx, g, path, listOf, notBefore) {
    let nb = notBefore;
    for (let attempt = 0; attempt < 2; attempt++) {
      const maxWaitMs = Math.max(0, Math.min(6_000, ctx.deadline - now() - 2_000));
      if (attempt > 0 && maxWaitMs <= 0) break;
      /** @type {import("./gateway-http.mjs").PacedAnswer} */
      let r;
      try {
        r = await gw.pacedGet(g.cid, g.port, path, { notBefore: nb, maxWaitMs });
      } catch (e) {
        if (e instanceof ReadOnlyViolation) throw e;
        return { complete: false };
      }
      const items = r.status === 200 && r.first === false ? listOf(r) : null;
      if (items) return { complete: true, items };
      nb = r.at + 1;
    }
    return { complete: false };
  }

  /** @param {OrderCtx} ctx @param {Ready} g @param {{ notBefore: number }} o */
  const liveOrders = (ctx, g, o) =>
    pacedList(
      ctx,
      g,
      "/iserver/account/orders",
      // IBKR lists at most 1,000 orders (the day's filled and cancelled ones included): a full list may
      // be cut, so it never counts as complete.
      (r) => (Array.isArray(r.json?.orders) && r.json.snapshot !== false && r.json.orders.length < LIVE_ORDERS_CAP ? r.json.orders : null),
      o.notBefore,
    );

  /** @param {OrderCtx} ctx @param {Ready} g @param {{ notBefore: number }} o */
  const tradesFor = (ctx, g, o) => pacedList(ctx, g, "/iserver/account/trades?days=1", (r) => (Array.isArray(r.json) ? r.json : null), o.notBefore);

  /**
   * The position and, when the rules need them, the working orders.
   * @param {OrderCtx} ctx @param {Ticket} ticket @param {number} conid @param {number} port
   * @returns {Promise<PositionState>}
   */
  async function readPosition(ctx, ticket, conid, port) {
    const cid = ctx.connection.id;
    const acct = ctx.account.external_id;
    const unreadable = () => new OrderNotSentError(502, positionUnreadable(ticket.symbol), "position_unreadable");
    const readQty = async () => {
      const left = ctx.deadline - now();
      if (left <= 0) throw new OrderNotSentError(504, S.tooLong, "broker_timeout");
      /** @type {{ status: number, json: any }} */
      let res;
      try {
        res = await gw.trade(cid, port, "GET", `/portfolio2/${acct}/positions`, undefined, { timeoutMs: Math.min(PREVIEW_CALL_MS, left), notAfter: ctx.deadline });
      } catch {
        throw unreadable();
      }
      if (res.status !== 200 || !Array.isArray(res.json)) throw unreadable();
      let qty = 0;
      for (const item of res.json) {
        if (!item || typeof item !== "object" || Number(item.conid) !== conid) continue;
        const p = strictNumber(item.position);
        if (!Number.isFinite(p)) throw unreadable();
        qty += p;
      }
      return qty;
    };
    const first = await readQty();
    if (ticket.side === "SELL" || ticket.intent === "close" || first < 0) {
      const lo = await liveOrders(ctx, { cid, port, acct }, { notBefore: 0 });
      if (!lo.complete) throw new OrderNotSentError(409, WORKING_UNREADABLE, "working_orders_unreadable");
      // The position again, after the working orders (the paced list can wait seconds): a sell that
      // filled meanwhile is then in the position, and the smaller of the two reads is used.
      const qty = saferPosition(first, await readQty());
      return { qty, ...workingOf(lo.items, acct, conid), working: true };
    }
    return { qty: first, workingSell: 0, workingBuy: 0, working: false };
  }

  /**
   * The conid of the ticket and the broker's name for it, checked against IBKR's contract record
   * and trading rules for this account.
   * @param {OrderCtx} ctx @param {Ready} g @param {Ticket} ticket
   */
  async function contract(ctx, g, ticket) {
    const sym = ticket.symbol;
    /** @param {Promise<{ status: number, json: any }>} p */
    const answer = async (p) => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof HttpError || e instanceof ReadOnlyViolation) throw e;
        if (e instanceof GatewayHttpError && e.code === "not_sent") throw new HttpError(429, S.previewLimited, { code: "rate_limited", retryAfterSec: 5 });
        throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
      }
    };
    const notTradable = () => new HttpError(400, `IBKR's record for ${sym} is not a US stock or ETF in dollars.`, { code: "not_tradable" });

    /** @type {number | null} */
    let conid = null;
    const prefix = `ibkr:${ctx.account.id}:`;
    if (typeof ticket.positionId === "string" && ticket.positionId.startsWith(prefix)) {
      const rest = ticket.positionId.slice(prefix.length);
      if (CONID_RE.test(rest)) conid = Number(rest);
    }
    if (conid === null) {
      if (!/^[A-Z]{1,5}$/.test(sym)) {
        throw new HttpError(
          400,
          `IBKR orders for ${sym} are not available by symbol in Nasscord yet. Trade class shares such as BRK.B from their row in Positions, or in IBKR.`,
          { code: "not_tradable" },
        );
      }
      const res = await answer(readCall(ctx, "preview", g.port, "GET", `/trsrv/stocks?symbols=${sym}`));
      if (res.status === 401) throw new HttpError(409, S.notLive, { code: "connection_not_live" });
      if (res.status !== 200 || !res.json || typeof res.json !== "object") throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
      /** @type {Set<string>} */
      const ids = new Set();
      for (const group of arr(res.json[sym])) {
        if (group?.assetClass !== "STK") continue;
        for (const c of arr(group.contracts)) if (c?.isUS === true) ids.add(String(c.conid));
      }
      const only = ids.size === 1 ? [...ids][0] : "";
      if (!CONID_RE.test(only)) throw new HttpError(400, `IBKR does not list a single US stock or ETF for ${sym}.`, { code: "not_tradable" });
      conid = Number(only);
    }

    const info = await answer(readCall(ctx, "preview", g.port, "GET", `/iserver/contract/${conid}/info`));
    if (info.status === 401) throw new HttpError(409, S.notLive, { code: "connection_not_live" });
    if (info.status >= 500) throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
    const j = info.json;
    if (info.status !== 200 || !j || typeof j !== "object" || normalizeSymbol(j.symbol) !== sym || j.currency !== "USD" || j.instrument_type !== "STK") {
      throw notTradable();
    }
    /** @type {{ name?: string, exchange?: string }} */
    const instrument = {};
    if (clean(j.company_name)) instrument.name = clean(j.company_name);
    if (clean(j.exchange)) instrument.exchange = clean(j.exchange);

    const rules = await answer(readCall(ctx, "preview", g.port, "POST", "/iserver/contract/rules", { conid, isBuy: ticket.side === "BUY" }));
    const r = rules.json;
    if (r && typeof r === "object" && r.error) throw new HttpError(422, `IBKR: ${clip(String(r.error))}`, { code: "broker_refused" });
    if (rules.status === 401) throw new HttpError(409, S.notLive, { code: "connection_not_live" });
    if (rules.status !== 200 || !r || typeof r !== "object") throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
    if (!Array.isArray(r.canTradeAcctIds) || !r.canTradeAcctIds.map(String).includes(g.acct)) {
      throw new HttpError(422, `IBKR says account ${ctx.account.display_number} cannot trade ${sym}.`, { code: "broker_refused" });
    }
    const types = arr(r.orderTypes).map((t) => String(t).toLowerCase());
    const need = [RULE_TYPE[ticket.type], ...(ticket.bracket ? ["stop", "limit"] : [])];
    const missing = need.find((t) => !types.includes(t));
    if (missing) {
      throw new HttpError(422, `IBKR does not take ${RULE_LABEL[/** @type {keyof typeof RULE_LABEL} */ (missing)]} orders for ${sym}.`, { code: "broker_refused" });
    }
    const tifOk = arr(r.tifTypes).some((t) => {
      const s = String(t).toUpperCase();
      return s === ticket.tif || s.startsWith(`${ticket.tif}/`);
    });
    if (!tifOk) throw new HttpError(422, `IBKR does not take ${ticket.tif === "GTC" ? "GTC" : "Day"} orders like this for ${sym}.`, { code: "broker_refused" });
    if (Array.isArray(r.incrementRules)) {
      const rulesList = r.incrementRules
        .map((/** @type {any} */ x) => ({ lowerEdge: num(x?.lowerEdge), increment: num(x?.increment) }))
        .filter((/** @type {{ lowerEdge?: number, increment?: number }} */ x) => x.lowerEdge !== undefined && x.increment !== undefined && x.increment > 0);
      const prices = [ticket.limitPrice, ticket.stopPrice, ticket.bracket?.takeProfit.limitPrice, ticket.bracket?.stopLoss.stopPrice, ticket.bracket?.stopLoss.limitPrice];
      for (const price of prices) {
        if (typeof price !== "number") continue;
        let rule = null;
        for (const x of rulesList) if (x.lowerEdge <= price && (!rule || x.lowerEdge > rule.lowerEdge)) rule = x;
        if (!rule) continue;
        const k = price / rule.increment;
        if (Math.abs(k - Math.round(k)) >= 1e-6) {
          throw new HttpError(400, `IBKR takes prices for ${sym} in steps of $${formatPrice(rule.increment)}.`, { code: "bad_ticket" });
        }
      }
    }
    return { conid, instrument: Object.keys(instrument).length ? instrument : null };
  }

  /**
   * IBKR's market data snapshot (required before a what-if). Its first call for a contract is a
   * pre-flight that answers nothing, so an empty answer is asked once more 500 ms later.
   * @param {OrderCtx} ctx @param {Ready} g @param {number} conid
   * @returns {Promise<Quote | null>}
   */
  async function snapshot(ctx, g, conid) {
    const path = `/iserver/marketdata/snapshot?conids=${conid}&fields=31,84,86`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        if (ctx.deadline - now() < 3_000) return null;
        await wait(500);
      }
      /** @type {{ status: number, json: any }} */
      let res;
      try {
        res = await readCall(ctx, "preview", g.port, "GET", path);
      } catch (e) {
        if (e instanceof ReadOnlyViolation) throw e;
        continue;
      }
      if (res.status === 401) throw new HttpError(409, S.notLive, { code: "connection_not_live" });
      const item = arr(res.json).find(
        (it) => it && typeof it === "object" && Number(it.conid) === conid && ["31", "84", "86"].some((f) => present(it[f])),
      );
      if (!item) continue;
      /** @type {Quote} */
      const quote = { source: "IBKR snapshot" };
      const last = snapshotPrice(item["31"]);
      const bid = snapshotPrice(item["84"]);
      const ask = snapshotPrice(item["86"]);
      if (bid !== undefined) quote.bid = bid;
      if (ask !== undefined) quote.ask = ask;
      if (last !== undefined) quote.last = last;
      return bid !== undefined || ask !== undefined || last !== undefined ? quote : null;
    }
    return null;
  }

  /**
   * Earlier attempts of a ticket by their cOID (IBKR's order_ref): the live orders list, then the
   * trades of the day. Reads only; "not found" never means that the order was not placed.
   * @param {OrderCtx} ctx
   * @param {string[]} ids
   * @param {{ notBefore: number }} o
   * @param {Ready | null} [given] a ready() answer of this same call
   * @returns {Promise<ReconcileOutcome>}
   */
  async function findByOrderRef(ctx, ids, o, given = null) {
    /** @type {Ready} */
    let g;
    try {
      g = given ?? (await ready(ctx, "reconcile"));
    } catch {
      return { found: null, reason: S.checkNotLoggedIn };
    }
    const want = new Set(ids.map(String));
    const lo = await liveOrders(ctx, g, o);
    if (!lo.complete) return { found: null, reason: S.checkNotListed };
    const mine = lo.items.filter((x) => x && typeof x === "object" && String(x.acct ?? x.account) === g.acct);
    for (const id of ids) {
      const hit = mine.find((x) => (clean(x.order_ref) || clean(x.cOID)) === id);
      const parent = hit ? String(hit.orderId ?? "") : "";
      if (!hit || !ORDER_ID_RE.test(parent)) continue;
      const children = mine.filter((x) => String(x.parentId ?? "") === parent && String(x.orderId ?? "") !== parent && ORDER_ID_RE.test(String(x.orderId ?? "")));
      if (!children.length) return { found: true, brokerOrderId: parent };
      /** @type {BrokerOrderRef[]} */
      const refs = [{ id: parent, role: "entry" }];
      for (const c of children) {
        const kind = typeKind(c.orderType ?? c.origOrderType);
        refs.push(kind === "limit" ? { id: String(c.orderId), role: "take_profit" } : kind === "stop" ? { id: String(c.orderId), role: "stop_loss" } : { id: String(c.orderId) });
      }
      return { found: true, brokerOrderId: parent, brokerOrderIds: refs };
    }
    const tr = await tradesFor(ctx, g, o);
    if (!tr.complete) return { found: null, reason: S.checkNotListed };
    const fill = tr.items.find(
      (t) => t && typeof t === "object" && String(t.account ?? t.accountCode ?? t.acct) === g.acct && want.has(clean(t.order_ref)),
    );
    if (fill) {
      const oid = String(fill.order_id ?? "");
      if (ORDER_ID_RE.test(oid)) return { found: true, brokerOrderId: oid };
      return { found: false, detail: S.fillWithoutNumber };
    }
    return { found: false };
  }

  /**
   * The order POST and the confirmations of its questions, while reads of the connection wait.
   * @param {OrderCtx} ctx @param {Ready} g @param {PlaceInput} input @param {number} conid
   * @param {{ live: string[], status: Map<string, string>, warnings: OrderWarning[], replies: number, lastAnswerAt: number }} st
   * @returns {Promise<PlaceOutcome | typeof PLACED>}
   */
  async function sendAndConfirm(ctx, g, input, conid, st) {
    const { ticket } = input;
    const acknowledged = new Set(input.acknowledged);
    /** @param {BrokerMessage} m */
    const confirmable = (m) =>
      (AUTO_MARKET.has(m.id) && acknowledged.has(IBKR_NOTICES.market.key)) ||
      (AUTO_STOP.has(m.id) && acknowledged.has(IBKR_NOTICES.stop.key)) ||
      input.approvedMessages.some((a) => a.id === m.id && a.textHash === messageTextHash(m.text));

    /** @param {string} [error] @returns {PlaceOutcome} */
    const unknown = (error = S.unknown) => ({ status: "unknown", error });
    /** @param {string} error @param {string} code @param {BrokerMessage[]} [messages] @returns {PlaceOutcome} */
    const rejected = (error, code, messages) => (messages ? { status: "rejected", error, code, messages } : { status: "rejected", error, code });
    /** @param {string} id @param {unknown} status */
    const addLive = (id, status) => {
      if (!st.live.includes(id)) st.live.push(id);
      if (typeof status === "string") st.status.set(id, status);
    };
    /** @param {any} item */
    const prompt = (item) => {
      const id = String(item.orderId ?? item.order_id ?? "");
      if (ORDER_ID_RE.test(id)) addLive(id, "PendingSubmit");
      const text = clip(String(item.text ?? ""));
      addWarning(st.warnings, {
        code: "ibkr_waiting_decision",
        text: text ? `IBKR is waiting for a decision on this order: ${text} Finish it in IBKR, or cancel it here.` : "IBKR is waiting for a decision on this order. Finish it in IBKR, or cancel it here.",
        source: "broker",
      });
      return st.live.length ? PLACED : unknown();
    };

    /**
     * Reads one answer of the order POST or of a reply.
     * @param {{ status: number, json: any }} res
     * @returns {Promise<PlaceOutcome | typeof PLACED>}
     */
    async function handle(res) {
      const s = res.status;
      if (s === 401) return unknown(S.sessionEnded);
      // A 429 is unknown too: IBKR does not say whether a rate-limited order was dropped.
      if (s === 429 || s < 200 || (s >= 300 && s < 400) || s >= 500) return unknown();
      const j = res.json;
      if (s >= 400) {
        const err = j && typeof j === "object" && !Array.isArray(j) && clean(j.error) ? clean(j.error) : "";
        return rejected(err ? `IBKR: ${clip(err)}` : `IBKR refused the order (${s}).`, "ibkr_refused");
      }
      if (j === null || typeof j !== "object") return unknown();
      // IBKR documents both an array and a bare object ({ order_id, order_status }, { prompt }, { error }).
      const list = Array.isArray(j) ? j : [j];
      /** @type {any[]} */
      const questions = [];
      /** @type {string[]} */
      const errors = [];
      let promptItem = null;
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        if (item.prompt === true) {
          promptItem ??= item;
          continue;
        }
        if (present(item.order_id)) {
          addLive(String(item.order_id), item.order_status);
          continue;
        }
        if (item.error) {
          errors.push(String(item.error));
          continue;
        }
        if (typeof item.id === "string" && (Array.isArray(item.messageIds) || Array.isArray(item.message))) questions.push(item);
      }
      if (promptItem) return prompt(promptItem);
      if (questions.length) {
        /** @type {BrokerMessage[]} */
        const messages = [];
        for (const q of questions) {
          const texts = arr(q.message).map(String);
          const qids = arr(q.messageIds).map(String);
          const list = qids.length ? qids.map((id, i) => ({ id, text: texts[i] ?? texts.join(" ") })) : [{ id: "ibkr", text: texts.join(" ") }];
          for (const m of list) if (!messages.some((x) => x.id === m.id && x.text === m.text)) messages.push(m);
        }
        const refused = messages.find((m) => REFUSE.has(m.id));
        if (refused) {
          return rejected(
            `IBKR asked to confirm something Nasscord does not send (${clip(refused.text)}). Nothing was placed. Place this order in IBKR instead.`,
            "ibkr_question_refused",
            messages,
          );
        }
        if (!messages.every(confirmable)) return { status: "needs_confirmation", messages, brokerState: { conid } };
        for (const q of questions) {
          if (!REPLY_ID_RE.test(q.id)) return rejected(S.replyInvalid, "ibkr_reply_invalid");
          const left = ctx.deadline - now();
          if (left < REPLY_MIN_MS || st.replies + 1 > MAX_REPLIES) return unknown();
          st.replies += 1;
          /** @type {{ status: number, json: any }} */
          let r;
          try {
            r = await gw.trade(g.cid, g.port, "POST", `/iserver/reply/${q.id}`, { confirmed: true }, { timeoutMs: Math.min(ORDER_CALL_MS, left), notAfter: ctx.deadline, minLeftMs: REPLY_MIN_MS });
          } catch {
            return unknown();
          } finally {
            st.lastAnswerAt = now();
          }
          const out = await handle(r);
          if (out !== PLACED) return out;
        }
        return PLACED;
      }
      if (errors.length) return rejected(`IBKR: ${clip(errors[0])}`, "ibkr_refused");
      return st.live.length ? PLACED : unknown();
    }

    /** @type {{ status: number, json: any }} */
    let res;
    try {
      res = await gw.trade(g.cid, g.port, "POST", `/iserver/account/${g.acct}/orders`, { orders: buildTickets(ticket, conid, g.acct, input.clientOrderId) }, {
        timeoutMs: Math.min(ORDER_CALL_MS, ctx.deadline - now()),
        notAfter: ctx.deadline,
        minLeftMs: SEND_MIN_MS,
      });
    } catch (e) {
      // Nothing left the process: the order was not sent.
      if (e instanceof ReadOnlyViolation) throw new OrderNotSentError(500, S.stoppedHere);
      if (e instanceof GatewayHttpError && e.code === "not_sent") {
        throw /^rate limited/.test(e.message) ? new OrderNotSentError(429, S.limitedNotSent, "rate_limited") : new OrderNotSentError(504, S.tooLongToSend);
      }
      if (e instanceof GatewayHttpError && e.code === "bad_port") throw new OrderNotSentError(409, S.notLive, "connection_not_live");
      if (e instanceof GatewayHttpError && e.code === "bad_path") throw new OrderNotSentError(500, S.stoppedHere);
      log.warn("ibkr order post failed", { connectionId: g.cid, requestId: ctx.requestId, code: e instanceof GatewayHttpError ? e.code : "error" });
      st.lastAnswerAt = now();
      return unknown();
    }
    st.lastAnswerAt = now();
    try {
      return await handle(res);
    } catch (e) {
      // From the POST on nothing throws: an unexpected failure is an unknown outcome.
      log.error("ibkr order answer unreadable", { connectionId: g.cid, requestId: ctx.requestId, error: e });
      return unknown();
    }
  }

  /**
   * After a placed answer, best effort: order status reads give the bracket's roles and the echo
   * of what IBKR took.
   * @param {OrderCtx} ctx @param {Ready} g @param {Ticket} ticket @param {number} conid
   * @param {{ live: string[], status: Map<string, string>, warnings: OrderWarning[], lastAnswerAt: number }} st
   * @returns {Promise<PlaceOutcome>}
   */
  async function finishPlaced(ctx, g, ticket, conid, st) {
    const ids = st.live;
    /** @type {Map<string, any>} */
    const status = new Map();
    try {
      if (ctx.deadline - now() >= 3_000) {
        const pause = st.lastAnswerAt + 1_500 - now();
        if (pause > 0) await wait(pause);
        for (const id of ids.slice(0, 3)) {
          const left = ctx.deadline - now() - 500;
          if (left < 500) break;
          if (!ORDER_ID_RE.test(id)) continue;
          try {
            const r = await gw.trade(g.cid, g.port, "GET", `/iserver/account/order/status/${id}`, undefined, { timeoutMs: Math.min(5_000, left), notAfter: ctx.deadline - 500 });
            if (r.status === 200 && r.json && typeof r.json === "object" && !Array.isArray(r.json)) status.set(id, r.json);
          } catch {
            /* best effort */
          }
        }
      }
    } catch {
      /* best effort */
    }

    /** @param {string} id */
    const echo = (id) => {
      const s = status.get(id);
      if (!s) return;
      let differs = false;
      if (present(s.side) && String(s.side).trim().toUpperCase()[0] !== ticket.side[0]) differs = true;
      if (present(s.total_size) && !sameNumber(s.total_size, ticket.quantity)) differs = true;
      if (present(s.conid) && !sameNumber(s.conid, conid)) differs = true;
      if ((ticket.type === "LMT" || ticket.type === "STP_LMT") && present(s.limit_price) && !sameNumber(s.limit_price, ticket.limitPrice)) differs = true;
      if (ticket.type === "STP" || ticket.type === "STP_LMT") {
        const stop = present(s.stop_price) ? s.stop_price : s.aux_price;
        if (present(stop) && !sameNumber(stop, ticket.stopPrice)) differs = true;
      }
      if (differs) addWarning(st.warnings, { code: "ibkr_echo_mismatch", text: S.echoMismatch, source: "nasscord" });
      const os = String(s.order_status ?? "").toLowerCase().replace(/\s+/g, "");
      if (os === "pendingsubmit") addWarning(st.warnings, { code: "ibkr_pending_submit", text: S.pendingSubmit, source: "nasscord" });
    };

    /** @type {{ status: "placed", brokerOrderId: string, brokerOrderIds?: BrokerOrderRef[] }} */
    let out;
    if (!ticket.bracket) {
      let id = ids[0];
      if (ids.length > 1) {
        const match = ids.find((x) => {
          const s = status.get(x);
          return s && String(s.side ?? "").trim().toUpperCase()[0] === ticket.side[0] && sameNumber(s.total_size, ticket.quantity);
        });
        if (match) id = match;
        addWarning(st.warnings, { code: "ibkr_echo_mismatch", text: S.echoMismatch, source: "nasscord" });
      }
      echo(id);
      out = { status: "placed", brokerOrderId: id };
    } else {
      /** @type {string | null} */
      let entry = null;
      /** @type {Map<string, "entry" | "take_profit" | "stop_loss">} */
      const roles = new Map();
      for (const id of ids) {
        const s = status.get(id);
        if (!s) continue;
        const side = String(s.side ?? "").trim().toUpperCase();
        if (side.startsWith("B")) {
          if (!entry) {
            entry = id;
            roles.set(id, "entry");
          }
        } else if (side.startsWith("S")) {
          const kind = typeKind(s.order_type);
          if (kind === "stop") roles.set(id, "stop_loss");
          else if (kind === "limit") roles.set(id, "take_profit");
        }
      }
      if (!entry) {
        addWarning(st.warnings, { code: "ibkr_bracket_unverified", text: S.bracketUnverified, source: "nasscord" });
        out = { status: "placed", brokerOrderId: ids[0], brokerOrderIds: ids.map((id) => ({ id })) };
      } else {
        const first = entry;
        const ordered = [first, ...ids.filter((id) => id !== first)];
        out = {
          status: "placed",
          brokerOrderId: first,
          brokerOrderIds: ordered.map((id) => {
            const role = roles.get(id);
            return role ? { id, role } : { id };
          }),
        };
        echo(first);
      }
      if (ids.length < 3) addWarning(st.warnings, { code: "ibkr_bracket_incomplete", text: S.bracketIncomplete, source: "nasscord" });
    }
    return st.warnings.length ? { ...out, warnings: st.warnings } : out;
  }

  return {
    capabilities(connection, accounts) {
      if (connection.environment !== "production" && connection.environment !== "paper") return null;
      if (accounts.length === 0) return { blocked: "IBKR has not listed the account of this login yet. Reconnect IBKR, then try again." };
      if (accounts.length > 1) return { blocked: multiAccountSentence(accounts.length) };
      const env = connection.environment === "paper" ? "paper" : "production";
      /** @param {"off" | "paper" | "on"} mode */
      const allows = (mode) => mode === "on" || (mode === "paper" && env === "paper");
      const stop = allows(stopOrders);
      const bracket = stop && allows(brackets);
      /** @type {string[]} */
      const notes = [];
      if (!stop) {
        notes.push(
          env === "production"
            ? "IBKR stop, stop limit and bracket orders are switched off for live accounts until Nasscord has checked them on a paper account."
            : "IBKR stop, stop limit and bracket orders are switched off on this server.",
        );
      } else if (!bracket) {
        notes.push(
          env === "production"
            ? "IBKR bracket orders are switched off for live accounts until Nasscord has checked them on a paper account."
            : "IBKR bracket orders are switched off on this server.",
        );
      }
      notes.push(
        "IBKR may ask you to confirm an order, for example one without market data. Nasscord shows IBKR's words and sends nothing until you confirm.",
        "Trade class shares such as BRK B from their row in Positions; Nasscord cannot look them up by symbol at IBKR yet.",
      );
      return {
        types: stop ? ["MKT", "LMT", "STP", "STP_LMT"] : ["MKT", "LMT"],
        tif: ["DAY", "GTC"],
        marketGtc: true,
        bracket: bracket ? { entryTypes: ["MKT", "LMT"], stopTypes: ["STP"] } : null,
        notes,
      };
    },

    async previewOrder(ctx, ticket, _clientOrderId) {
      const g = await ready(ctx, "preview");
      const { conid, instrument } = await contract(ctx, g, ticket);
      const quote = await snapshot(ctx, g, conid);
      const position = await readPosition(ctx, ticket, conid, g.port);

      // A bracket what-if needs a parent cOID for its children: a throwaway one, never stored.
      const whatIfId = `nw${randomBytes(9).toString("hex")}`;
      const body = { orders: buildTickets(ticket, conid, g.acct, ticket.bracket ? whatIfId : null) };
      /** @type {{ status: number, json: any }} */
      let res;
      try {
        res = await readCall(ctx, "preview", g.port, "POST", `/iserver/account/${g.acct}/orders/whatif`, body);
      } catch (e) {
        if (e instanceof HttpError || e instanceof ReadOnlyViolation) throw e;
        if (e instanceof GatewayHttpError && e.code === "not_sent") throw new HttpError(429, S.previewLimited, { code: "rate_limited", retryAfterSec: 5 });
        throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
      }
      const j = res.json;
      const items = Array.isArray(j) ? j.filter((x) => x && typeof x === "object") : j && typeof j === "object" ? [j] : [];
      if (res.status >= 400) {
        const err = items.map((x) => (typeof x.error === "string" ? x.error.trim() : "")).find(Boolean);
        if (err) throw new HttpError(422, `IBKR: ${clip(err.replace(/^Bad Request:\s*/i, ""))}`, { code: "broker_refused" });
        throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
      }
      if (res.status !== 200 || !items.length) throw new HttpError(502, S.previewDown, { code: "broker_unavailable" });
      const err = items.map((x) => (typeof x.error === "string" ? x.error.trim() : "")).find(Boolean);
      if (err) throw new HttpError(422, `IBKR: ${clip(err.replace(/^Bad Request:\s*/i, ""))}`, { code: "broker_refused" });

      /** @type {OrderWarning[]} */
      const warnings = [];
      const amount = items.map((x) => x.amount).find((a) => a && typeof a === "object");
      /** @type {import("../order-contract.mjs").Estimate} */
      const estimate = { source: "IBKR" };
      if (amount) {
        /** @type {{ amount?: string, commission?: string, total?: string }} */
        const brokerText = {};
        for (const k of /** @type {const} */ (["amount", "commission", "total"])) if (typeof amount[k] === "string" && amount[k].trim()) brokerText[k] = amount[k].trim();
        const notional = parseIbkrMoney(amount.amount);
        const commission = parseIbkrMoney(amount.commission);
        const total = parseIbkrMoney(amount.total);
        if (notional !== undefined) estimate.notional = notional;
        if (commission !== undefined) estimate.commission = commission;
        if (total !== undefined) estimate.total = total;
        if (Object.keys(brokerText).length) estimate.brokerText = brokerText;
      } else {
        warnings.push({ code: "ibkr_no_estimate", text: "IBKR did not return a cost estimate for this order.", source: "broker" });
      }
      for (const x of items) {
        const warn = typeof x.warn === "string" ? x.warn.trim().replace(/^\d+\//, "").trim() : "";
        if (warn && !warnings.some((w) => w.code === "ibkr_whatif_warning" && w.text === warn)) warnings.push({ code: "ibkr_whatif_warning", text: warn, source: "broker" });
      }

      // The limits are checked against the market, never against the user's own price: a priced
      // order's what-if amount comes from that price, and a bracket's what-if amount is UNCONFIRMED.
      /** @type {number | null} */
      let referencePrice = null;
      if (quote?.bid !== undefined && quote.ask !== undefined) referencePrice = round4((quote.bid + quote.ask) / 2);
      else if (quote?.last !== undefined) referencePrice = quote.last;
      else if (ticket.type === "MKT" && !ticket.bracket && estimate.notional !== undefined && estimate.notional > 0) referencePrice = round4(estimate.notional / ticket.quantity);

      /** @type {import("../order-contract.mjs").OrderNotice[]} */
      const notices = [];
      if (ticket.type === "MKT") notices.push({ ...IBKR_NOTICES.market });
      if (ticket.type === "STP" || ticket.type === "STP_LMT" || ticket.bracket) notices.push({ ...IBKR_NOTICES.stop });

      return { position, referencePrice, quote, instrument, estimate, warnings, notices, brokerState: { conid } };
    },

    async positionState(ctx, ticket, brokerState) {
      const conid = Number(brokerState?.conid);
      if (!Number.isSafeInteger(conid) || conid <= 0) throw new OrderNotSentError(409, S.incomplete);
      const port = livePort(ctx, "place");
      return readPosition(ctx, ticket, conid, port);
    },

    async placeOrder(ctx, input) {
      const { ticket } = input;
      const g = await ready(ctx, "place");
      const conid = Number(input.brokerState?.conid);
      if (!Number.isSafeInteger(conid) || conid <= 0) throw new OrderNotSentError(409, S.incomplete);

      // An earlier attempt of this ticket (an IBKR question round) may have gone through after all.
      if (input.previousClientOrderIds.length > 0) {
        const earlier = await findByOrderRef(ctx, input.previousClientOrderIds, { notBefore: 0 }, g);
        if (earlier.found === true) {
          log.info("ibkr earlier attempt found", { connectionId: g.cid, requestId: ctx.requestId });
          return earlier.brokerOrderIds
            ? { status: "placed", brokerOrderId: earlier.brokerOrderId, brokerOrderIds: earlier.brokerOrderIds }
            : { status: "placed", brokerOrderId: earlier.brokerOrderId };
        }
        // A fill with this reference but no order number: placed, and nothing more is sent.
        if (earlier.found === false && earlier.detail) return { status: "unknown", error: earlier.detail };
        if (earlier.found !== false) throw new OrderNotSentError(409, S.earlierUnchecked, "busy");
      }
      if (ctx.deadline - now() < SEND_MIN_MS) throw new OrderNotSentError(504, S.tooLongToSend);

      const st = { live: /** @type {string[]} */ ([]), status: new Map(), warnings: /** @type {OrderWarning[]} */ ([]), replies: 0, lastAnswerAt: now() };
      const raw = await gw.holdReads(g.cid, () => sendAndConfirm(ctx, g, input, conid, st));
      // Part of the order is live at IBKR: placed, whatever else the answers said, and nothing more is sent.
      if (raw !== PLACED && st.live.length > 0) {
        addWarning(
          st.warnings,
          ticket.bracket
            ? { code: "ibkr_bracket_incomplete", text: S.bracketIncomplete, source: "nasscord" }
            : { code: "ibkr_echo_mismatch", text: S.echoMismatch, source: "nasscord" },
        );
      }
      if (raw !== PLACED && st.live.length === 0) {
        const outcome = /** @type {PlaceOutcome} */ (raw);
        log.info("ibkr order outcome", { connectionId: g.cid, requestId: ctx.requestId, outcome: outcome.status, replies: st.replies });
        return outcome;
      }
      const out = await finishPlaced(ctx, g, ticket, conid, st);
      log.info("ibkr order outcome", { connectionId: g.cid, requestId: ctx.requestId, outcome: out.status, replies: st.replies });
      return out;
    },

    async reconcileOrder(ctx, input) {
      return findByOrderRef(ctx, input.clientOrderIds, { notBefore: parseTime(input.sentAt) ?? 0 });
    },

    async cancelOrder(ctx, brokerOrderId) {
      const id = String(brokerOrderId);
      if (!ORDER_ID_RE.test(id)) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });
      const g = await ready(ctx, "cancel");
      const lo = await liveOrders(ctx, g, { notBefore: 0 });
      if (!lo.complete) throw new HttpError(409, S.cancelBusy, { code: "busy" });
      const order = lo.items.find((o) => o && typeof o === "object" && String(o.orderId) === id && String(o.acct ?? o.account) === g.acct);
      if (!order) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });
      const state = String(order.status ?? "").toLowerCase().replace(/\s+/g, "");
      const done = { filled: "filled", cancelled: "cancelled", apicancelled: "cancelled", inactive: "inactive" }[state];
      if (done) throw new HttpError(409, `This order is already ${done} at IBKR.`, { code: "not_cancellable" });
      if (state === "pendingcancel" || state === "precancelled") return { status: "cancel_requested", message: S.cancelling };

      const left = ctx.deadline - now();
      if (left <= 0) throw new HttpError(504, S.tooLong, { code: "broker_timeout" });
      /** @type {{ status: number, json: any }} */
      let res;
      try {
        res = await gw.trade(g.cid, g.port, "DELETE", `/iserver/account/${g.acct}/order/${id}`, undefined, { timeoutMs: Math.min(ORDER_CALL_MS, left), notAfter: ctx.deadline });
      } catch (e) {
        if (e instanceof ReadOnlyViolation) throw e;
        if (e instanceof GatewayHttpError && e.code === "not_sent") {
          throw /^rate limited/.test(e.message)
            ? new HttpError(429, S.cancelLimited, { code: "rate_limited", retryAfterSec: 5 })
            : new HttpError(504, S.tooLong, { code: "broker_timeout" });
        }
        if (e instanceof GatewayHttpError && e.code === "bad_port") throw new HttpError(409, S.notLive, { code: "connection_not_live" });
        if (e instanceof GatewayHttpError && e.code === "bad_path") throw e;
        log.warn("ibkr cancel unconfirmed", { connectionId: g.cid, code: e instanceof GatewayHttpError ? e.code : "error" });
        throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
      }
      const s = res.status;
      if (s < 200 || (s >= 300 && s < 400) || s >= 500) throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
      const j = Array.isArray(res.json) ? res.json[0] : res.json;
      const error = j && typeof j === "object" && j.error ? clip(String(j.error)) : "";
      if (s >= 400 || error) {
        if (/doesn.t exist/i.test(error)) throw new HttpError(404, S.cancelNotOpen, { code: "order_not_open" });
        throw new HttpError(409, error ? `IBKR: ${error}` : `IBKR refused the cancel (${s}).`, { code: "not_cancellable" });
      }
      if (!j || typeof j !== "object") throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
      if (typeof j.id === "string" && present(j.message)) {
        const text = clip(Array.isArray(j.message) ? j.message.join(" ") : String(j.message));
        throw new HttpError(409, `IBKR asked a question about this cancel: ${text} Cancel it in IBKR.`, { code: "not_cancellable" });
      }
      if (present(j.msg)) {
        if (Number(j.conid) === -1 || j.account === null) return { status: "cancelled", message: S.cancelled };
        return { status: "cancel_requested", message: S.cancelRequested };
      }
      throw new HttpError(502, S.cancelUnknown, { code: "cancel_unknown" });
    },
  };
}

/** The marker of an answer whose order parts are live (the outcome is built afterwards). */
const PLACED = Object.freeze({ status: /** @type {const} */ ("placed_marker") });

/**
 * Adds a warning once per code.
 * @param {OrderWarning[]} list @param {OrderWarning} w
 */
function addWarning(list, w) {
  if (!list.some((x) => x.code === w.code)) list.push(w);
}
