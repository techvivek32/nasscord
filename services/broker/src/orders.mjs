import { createHash } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { LockTimeoutError } from "./locks.mjs";
import {
  isValidPrice,
  formatPrice,
  messageTextHash,
  newClientOrderId,
  normalizeSymbol,
  OrderNotSentError,
  TRADING_METHODS,
  usRegularSession,
} from "./order-contract.mjs";
import { BROKER_NAMES } from "./registry.mjs";

/**
 * The order core (docs/real-backend.md section 13): the gate, the account and connection checks,
 * the ticket, position, price and duplicate rules, the order_requests state machine, reconciliation
 * of unconfirmed outcomes, and cancels. The brokers' own calls live in the trading part of three
 * adapters (src/order-contract.mjs); nothing else in the service sends an order.
 *
 * Safety rules kept here:
 * - preview, then place. A ticket's client order id is made once and stored before anything is
 *   sent; place moves the row preview -> sending in one conditional UPDATE (status and expiry), so
 *   a ticket is sent at most once and never after its preview expired.
 * - a send is never retried. Any failure after a send is "unknown" and is reconciled by reads; a
 *   broker's "not found" never reads as "not placed".
 * - every order call to a broker runs under the lock "order:<connectionId>" with a bounded wait.
 * - the workspace switch, the member row and the workspace status are read from the database on
 *   every order request.
 * - logs hold ids, statuses and codes only: never a body, an account number in full, a key or token.
 */

/**
 * @typedef {import("./jwt.mjs").ServiceClaims} Claims
 * @typedef {import("./db.mjs").AccountRow} AccountRow
 * @typedef {import("./db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("./db.mjs").OrderRequestRow} OrderRequestRow
 * @typedef {import("./db.mjs").OrderGateWorkspace} OrderGateWorkspace
 * @typedef {import("./order-contract.mjs").Ticket} Ticket
 * @typedef {import("./order-contract.mjs").TicketType} TicketType
 * @typedef {import("./order-contract.mjs").TradingCapabilities} TradingCapabilities
 * @typedef {import("./order-contract.mjs").TradingAdapter} TradingAdapter
 * @typedef {import("./order-contract.mjs").PositionState} PositionState
 * @typedef {import("./order-contract.mjs").BrokerPreview} BrokerPreview
 * @typedef {import("./order-contract.mjs").OrderWarning} OrderWarning
 * @typedef {import("./order-contract.mjs").PlaceOutcome} PlaceOutcome
 * @typedef {import("./order-contract.mjs").OrderCtx} OrderCtx
 * @typedef {import("./order-contract.mjs").ApprovedMessage} ApprovedMessage
 * @typedef {import("./order-contract.mjs").BrokerMessage} BrokerMessage
 */

export const PREVIEW_TTL_MS = 120_000;
export const PREVIEW_DEADLINE_MS = 25_000;
export const PLACE_DEADLINE_MS = 38_000;
export const STATUS_DEADLINE_MS = 20_000;
export const CANCEL_DEADLINE_MS = 25_000;
export const LOCK_WAIT_MS = 10_000;
export const STATUS_LOCK_WAIT_MS = 5_000;
export const RECONCILE_EVERY_MS = 5_000;
export const RECONCILE_FOR_MS = 30 * 60_000;
export const STALE_SENDING_MS = 120_000;
export const LIST_RECONCILE_MAX = 3;
export const BAND_REFUSE = 0.3;
export const BAND_WARN = 0.05;
export const SIMILAR_WINDOW_MS = 10 * 60_000;
export const UNKNOWN_WINDOW_MS = 24 * 3_600_000;
/**
 * The duplicate check of a preview and the refusal at place both use the service clock (sent_at and
 * the preview's checkedAt). A claim stamps sent_at a moment before its row is written, so the place
 * check starts this long before checkedAt and leaves out only the rows the preview check saw (and
 * warned about): no send falls between the warning and the refusal.
 */
export const SIMILAR_MARGIN_MS = 5_000;
export const MAX_ATTEMPTS = 4;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const TYPES = /** @type {const} */ (["MKT", "LMT", "STP", "STP_LMT"]);
const TYPE_LABEL = /** @type {Record<TicketType, string>} */ ({ MKT: "Market", LMT: "Limit", STP: "Stop", STP_LMT: "Stop limit" });
const TIF_LABEL = /** @type {Record<string, string>} */ ({ DAY: "Day", GTC: "Good till cancelled" });
const ROLES = ["superadmin", "trader", "tenant_user"];
const OPEN_STATUSES = /** @type {const} */ (["sending", "placed", "unknown", "needs_confirmation"]);
const NOT_PLACED = "Nothing was placed.";

// ─────────────────────────────────────────────────────────────── sentences

/** @param {string} broker */
export const unknownSentence = (broker) => `Nasscord could not confirm whether ${broker} received this order. Check Orders before you place it again.`;
/** @param {string} broker */
const notListedSentence = (broker) =>
  `${broker} does not list this order yet. That does not mean it was not placed. Check ${broker} before you place it again.`;
/** @param {string} broker */
const workingUnreadable = (broker, placing = false) =>
  placing
    ? `${broker} did not list your working orders, so Nasscord cannot check them against this order. Nothing was placed. Try again in a few seconds.`
    : `${broker} did not list your working orders, so Nasscord cannot check them against this order. Try again in a few seconds.`;
const D17_PLACE = (/** @type {string} */ broker) => `Only the person who connected this ${broker} login, or the workspace owner, can place orders on it.`;
const D17_TRADE = (/** @type {string} */ broker) =>
  `Only the person who connected this ${broker} login, or the workspace owner, can place or cancel orders on it.`;
const GEOMETRY = "For a buy bracket, the stop-loss goes below the entry and the take-profit above it.";

const GATE = {
  forbidden: "Order entry belongs to a trading workspace.",
  no_workspace: "Finish creating your workspace before you place orders.",
  order_entry_off: "Order entry is not switched on for this workspace.",
  not_member: "Your login no longer belongs to this workspace. Sign in again.",
  workspace_suspended: "This workspace is suspended, so it cannot place orders.",
  order_entry_paused: "Order entry is paused on this server. Your broker's own app still works.",
  shutting_down: "The broker service is restarting. Nothing was placed. Try again in a minute.",
};

const LIMITS = {
  preview: "Too many order previews from your login. Wait a minute and try again.",
  place: "Too many orders from your login in a short time. Wait a minute and try again.",
  placeAll: "Many orders are being sent right now. Try again in a minute.",
  cancel: "Too many cancel requests from your login. Wait a minute and try again.",
  check: "Too many checks from your login. Wait a minute and try again.",
  resolve: "Too many changes from your login. Wait a minute and try again.",
};

// ─────────────────────────────────────────────────────────────── small helpers

/** @param {number} status @param {string} code @param {string} message */
const fail = (status, code, message) => new HttpError(status, message, { code });
/** @param {string} message @param {string} [code] */
const badTicket = (message, code = "bad_ticket") => fail(400, code, message);
/** @param {number} ms */
const isoOf = (ms) => new Date(ms).toISOString();
/** @param {string | null | undefined} s @returns {number | null} */
const timeOf = (s) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
/** @param {string | null | undefined} s */
const isoOrNull = (s) => {
  const t = timeOf(s);
  return t === null ? null : isoOf(t);
};
/** @param {number} n */
const qtyText = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
/** @param {number} p "$185.50" */
const money = (p) => `$${formatPrice(p)}`;
/** @param {number} n "$1,855,000" */
const dollars = (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
/** @param {string} s @param {number} max */
const cut = (s, max) => (s.length > max ? s.slice(0, max) : s);
/** @param {unknown} v */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * One limit per broker account, the same under two connections, and no account number in a memory key.
 * @param {{ broker_id: string, external_id: string }} account
 */
export function accountKey(account) {
  return createHash("sha256").update(`${account.broker_id}:${account.external_id}`).digest("hex").slice(0, 16);
}

/**
 * The ticket as the service validates it (section 1.5). Absent fields and null mean the same;
 * unknown fields are ignored. Throws 400 bad_ticket with a sentence.
 * @param {any} body
 * @param {TradingCapabilities} caps
 * @param {{ brokerName: string, account: { id: string, broker_id: string }, maxQty: number }} o
 * @returns {Ticket}
 */
export function normalizeTicket(body, caps, o) {
  const broker = o.brokerName;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badTicket("Enter a US stock or ETF symbol.");
  /** @param {unknown} v */
  const opt = (v) => (v === undefined ? null : v);

  const symbol = normalizeSymbol(body.symbol ?? "");
  if (typeof body.symbol !== "string" || !SYMBOL_RE.test(symbol)) throw badTicket("Enter a US stock or ETF symbol.");

  const side = body.side;
  if (side !== "BUY" && side !== "SELL") throw badTicket("Pick Buy or Sell.");

  const quantity = body.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > o.maxQty) {
    throw badTicket(`Enter whole shares, from 1 to ${qtyText(o.maxQty)}.`);
  }

  const type = body.type;
  if (!TYPES.includes(type)) throw badTicket(`${broker} does not take these orders from Nasscord for this account.`);
  const label = TYPE_LABEL[/** @type {TicketType} */ (type)];
  if (!caps.types.includes(type)) throw badTicket(`${broker} does not take ${label} orders from Nasscord for this account.`);

  const priceRule = "Use a price above 0 with at most 2 decimals (4 below $1).";
  const limitPrice = opt(body.limitPrice);
  const stopPrice = opt(body.stopPrice);
  const usesLimit = type === "LMT" || type === "STP_LMT";
  const usesStop = type === "STP" || type === "STP_LMT";
  if (usesLimit && limitPrice === null) throw badTicket("Enter a limit price.");
  if (!usesLimit && limitPrice !== null) throw badTicket(`A ${label} order has no limit price.`);
  if (usesStop && stopPrice === null) throw badTicket("Enter a stop price.");
  if (!usesStop && stopPrice !== null) throw badTicket(`A ${label} order has no stop price.`);
  if (limitPrice !== null && !isValidPrice(limitPrice)) throw badTicket(priceRule);
  if (stopPrice !== null && !isValidPrice(stopPrice)) throw badTicket(priceRule);

  const tif = body.tif;
  if (tif !== "DAY" && tif !== "GTC") throw badTicket("Pick Day or Good till cancelled.");
  if (!caps.tif.includes(tif)) throw badTicket(`${broker} does not take ${TIF_LABEL[tif]} orders from Nasscord for this account.`);
  if (type === "MKT" && tif === "GTC" && !caps.marketGtc) throw badTicket(`${broker} takes Market orders as Day orders only.`);

  const intent = opt(body.intent) ?? "trade";
  if (intent !== "trade" && intent !== "close") throw badTicket("Pick a trade or a close.");

  /** @type {Ticket["bracket"]} */
  let bracket = null;
  const rawBracket = /** @type {any} */ (opt(body.bracket));
  if (rawBracket !== null) {
    if (!caps.bracket) throw badTicket(`${broker} does not take bracket orders from Nasscord for this account.`);
    if (typeof rawBracket !== "object" || Array.isArray(rawBracket)) throw badTicket(GEOMETRY);
    if (!caps.bracket.entryTypes.includes(/** @type {any} */ (type))) throw badTicket("A bracket enters with a Market or Limit order.");
    if (side !== "BUY") throw badTicket("Brackets are for buy orders: Nasscord does not open short positions.");
    if (intent !== "trade") throw badTicket("A Close is sent without a bracket.");
    if (tif !== "GTC") {
      throw badTicket("A bracket is sent as Good till cancelled, so its stop-loss and take-profit stay after today's close. Pick Good till cancelled.");
    }
    const tp = opt(rawBracket.takeProfit?.limitPrice);
    const slStop = opt(rawBracket.stopLoss?.stopPrice);
    const slLimit = opt(rawBracket.stopLoss?.limitPrice);
    if (tp === null || slStop === null) throw badTicket(GEOMETRY);
    if (slLimit !== null && !caps.bracket.stopTypes.includes("STP_LMT")) {
      throw badTicket(`${broker} takes a stop-loss without a limit price from Nasscord.`);
    }
    if (!isValidPrice(tp) || !isValidPrice(slStop) || (slLimit !== null && !isValidPrice(slLimit))) throw badTicket(priceRule);
    if (slLimit !== null && slLimit > slStop + 1e-9) throw badTicket("The stop-loss limit goes at or below its stop price.");
    if (type === "LMT") {
      const entry = /** @type {number} */ (limitPrice);
      if (!(slStop <= entry - 0.01 + 1e-9) || !(tp >= entry + 0.01 - 1e-9)) throw badTicket(GEOMETRY);
    }
    bracket = { takeProfit: { limitPrice: tp }, stopLoss: { stopPrice: slStop, limitPrice: slLimit } };
  }

  const positionId = opt(body.positionId);
  if (positionId !== null) {
    const prefix = `${o.account.broker_id}:${o.account.id}:`;
    if (typeof positionId !== "string" || positionId.length > 200 || !positionId.startsWith(prefix) || positionId.length === prefix.length) {
      throw badTicket("That position is not in this account.");
    }
  }

  const expected = opt(body.expectedPositionQty);
  if (intent === "close") {
    if (typeof expected !== "number" || !Number.isFinite(expected) || expected === 0 || positionId === null) {
      throw badTicket("Open Close from the Positions page.");
    }
  } else if (expected !== null) {
    throw badTicket("Only a Close carries the position quantity.");
  }

  return {
    symbol,
    side,
    quantity,
    type,
    limitPrice: /** @type {number | null} */ (limitPrice),
    stopPrice: /** @type {number | null} */ (stopPrice),
    tif,
    bracket,
    intent,
    positionId: /** @type {string | null} */ (positionId),
    expectedPositionQty: /** @type {number | null} */ (expected),
  };
}

/**
 * The no-short rules of section 1.5 (D5). Throws an HttpError with the sentence; `placing` picks
 * the place-time wording of an unreadable working-order list.
 * @param {Ticket} ticket
 * @param {PositionState} ps
 * @param {{ brokerName: string, maxQty: number, placing?: boolean }} o
 */
export function applyPositionRules(ticket, ps, o) {
  const broker = o.brokerName;
  const sym = ticket.symbol;
  if (!ps || !isNum(ps.qty)) throw fail(502, "position_unreadable", `Nasscord could not read your ${sym} position at ${broker}.`);
  const pos = ps.qty;
  const workingSell = isNum(ps.workingSell) ? Math.max(0, ps.workingSell) : 0;
  const workingBuy = isNum(ps.workingBuy) ? Math.max(0, ps.workingBuy) : 0;
  const needWorking = ticket.side === "SELL" || ticket.intent === "close" || pos < 0;
  if (needWorking && ps.working !== true) throw fail(409, "working_orders_unreadable", workingUnreadable(broker, o.placing));

  if (ticket.intent === "close") {
    if (pos === 0) throw fail(409, "no_position", `You no longer hold ${sym} in this account.`);
    if (!Number.isInteger(pos)) {
      throw fail(409, "fractional_position", `This position holds a fractional share count (${qtyText(pos)}). Nasscord sends whole shares only: close it in ${broker}.`);
    }
    if (pos !== ticket.expectedPositionQty) {
      throw fail(
        409,
        "position_changed",
        `Your ${sym} position changed from ${qtyText(Number(ticket.expectedPositionQty))} to ${qtyText(pos)} shares. Review the order and confirm again.`,
      );
    }
    if (Math.abs(pos) > o.maxQty) {
      throw badTicket(`This position is larger than the ${qtyText(o.maxQty)} shares Nasscord sends in one order. Sell it in parts.`);
    }
    if (ticket.side !== (pos > 0 ? "SELL" : "BUY") || ticket.quantity !== Math.abs(pos)) {
      throw fail(409, "position_changed", `Your ${sym} position is now ${qtyText(pos)} shares. Review the order and confirm again.`);
    }
    if (pos > 0 && workingSell > 0) {
      throw fail(
        409,
        "working_sells",
        `You have working sell orders for ${qtyText(workingSell)} ${sym} shares in this account. Cancel them first: after this order they would sell short.`,
      );
    }
    if (pos < 0 && workingBuy > 0) {
      throw fail(
        409,
        "working_buys",
        `You have working buy orders for ${qtyText(workingBuy)} ${sym} shares in this account. Cancel them first: after this order they would buy past zero.`,
      );
    }
    return;
  }

  if (ticket.side === "SELL") {
    if (pos > 0 && ticket.quantity + workingSell <= pos) return;
    if (pos <= 0) throw badTicket(`You hold no ${sym} in this account. Nasscord does not sell short.`, "no_short");
    if (workingSell > 0) {
      const free = Math.max(0, Math.floor(pos - workingSell));
      throw badTicket(
        `You hold ${qtyText(pos)} ${sym} in this account and working sell orders already cover ${qtyText(workingSell)}. Nasscord sells at most the ${qtyText(free)} shares they do not cover, and does not sell short.`,
        "no_short",
      );
    }
    throw badTicket(`You hold ${qtyText(pos)} ${sym} in this account. Nasscord sells at most what you hold and does not sell short.`, "no_short");
  }

  // BUY
  if (ticket.bracket && pos < 0) throw badTicket("Cover the short position before you open a bracket.", "no_short");
  if (pos < 0) {
    const abs = Math.abs(pos);
    if (ticket.quantity + workingBuy <= abs) return;
    const free = Math.max(0, Math.floor(abs - workingBuy));
    const covered = workingBuy > 0 ? `, and working buy orders already cover ${qtyText(workingBuy)}` : "";
    throw badTicket(
      `This account is short ${qtyText(abs)} ${sym}${covered}. Buy at most ${qtyText(free)} shares to cover; buying past zero in one order is not available.`,
      "no_short",
    );
  }
}

/**
 * The notional cap of section 1.5: only a BUY that opens or adds to a long position (`pos >= 0`; a
 * sell or a cover is bounded by the position). The entry price is the limit (LMT, STP_LMT), the stop
 * (STP) or the reference price (MKT). The place path runs it again with the fresh position, so a
 * cover that became an opening buy (the short closed elsewhere) can never skip the cap.
 * @param {Ticket} ticket
 * @param {number | null} ref
 * @param {{ maxNotional: number, pos: number }} o
 */
export function checkNotional(ticket, ref, o) {
  if (ticket.side !== "BUY" || !(o.pos >= 0)) return;
  const t = ticket.type;
  const entry = t === "LMT" || t === "STP_LMT" ? ticket.limitPrice : t === "STP" ? ticket.stopPrice : ref;
  if (entry === null) return;
  const notional = ticket.quantity * entry;
  if (notional > o.maxNotional) {
    throw badTicket(`This order is worth about ${dollars(notional)}, above the ${dollars(o.maxNotional)} Nasscord allows per order.`, "notional_cap");
  }
}

/**
 * Reference price, stop side, bracket geometry, notional cap and price band (section 1.5).
 * Throws on a refusal; answers the warnings.
 * @param {Ticket} ticket
 * @param {BrokerPreview} bp
 * @param {{ brokerName: string, maxNotional: number, pos: number }} o
 * @returns {OrderWarning[]}
 */
export function checkPrices(ticket, bp, o) {
  /** @type {OrderWarning[]} */
  const warnings = [];
  /** @param {string} code @param {string} text */
  const warn = (code, text) => warnings.push({ code, text, source: "nasscord" });
  const ref = isNum(bp.referencePrice) && /** @type {number} */ (bp.referencePrice) > 0 ? /** @type {number} */ (bp.referencePrice) : null;
  const t = ticket.type;
  const needsRef = t === "MKT" || t === "STP" || t === "STP_LMT" || !!ticket.bracket;
  if (ref === null && needsRef) {
    const what = ticket.bracket ? "bracket" : TYPE_LABEL[t];
    throw fail(
      409,
      "no_reference_price",
      `${o.brokerName} did not give Nasscord a market price for ${ticket.symbol}, so this ${what} order cannot be checked against your limits. Use a Limit order, or place it in ${o.brokerName}.`,
    );
  }
  if (ref === null) warn("no_reference", `Nasscord could not check this price against the market. ${o.brokerName} may still refuse it.`);

  if (ticket.limitPrice !== null && ticket.stopPrice !== null && t === "STP_LMT") {
    const inverted = ticket.side === "BUY" ? ticket.limitPrice < ticket.stopPrice : ticket.limitPrice > ticket.stopPrice;
    if (inverted) warn("stop_limit_inverted", "The limit is on the far side of the stop, so the order may not fill when it triggers.");
  }

  if (ref !== null) {
    if ((t === "STP" || t === "STP_LMT") && ticket.stopPrice !== null) {
      const p = ticket.stopPrice;
      const buy = ticket.side === "BUY";
      if (buy ? p <= ref : p >= ref) {
        throw badTicket(
          `A ${buy ? "buy" : "sell"} stop at ${money(p)} is already ${buy ? "at or below" : "at or above"} the market price ${money(ref)}, so it would trigger at once. Check the stop price.`,
          "stop_wrong_side",
        );
      }
    }
    if (ticket.bracket) {
      const sl = ticket.bracket.stopLoss.stopPrice;
      const tp = ticket.bracket.takeProfit.limitPrice;
      if (sl >= ref) {
        throw badTicket(`The stop-loss at ${money(sl)} is at or above the market price ${money(ref)}, so it would sell as soon as the entry fills.`, "stop_wrong_side");
      }
      if (tp <= ref) {
        warn("take_profit_below_market", `The take-profit at ${money(tp)} is at or below the market price ${money(ref)}, so it would sell as soon as the entry fills.`);
      }
      if (t === "MKT" && (!(sl <= ref - 0.01 + 1e-9) || !(tp >= ref + 0.01 - 1e-9))) throw badTicket(GEOMETRY);
    }
  }

  checkNotional(ticket, ref, o);

  if (ref !== null) {
    /** @type {Array<[string, number | null, boolean]>} label, price, own (warns too) */
    const prices = [
      ["Limit price", ticket.limitPrice, true],
      ["Stop price", ticket.stopPrice, true],
      ["Take-profit", ticket.bracket?.takeProfit.limitPrice ?? null, false],
      ["Stop-loss", ticket.bracket?.stopLoss.stopPrice ?? null, false],
      ["Stop-loss limit", ticket.bracket?.stopLoss.limitPrice ?? null, false],
    ];
    for (const [label, p, own] of prices) {
      if (p === null) continue;
      const away = Math.abs(p / ref - 1);
      const pct = (away * 100).toFixed(1);
      if (away > BAND_REFUSE) {
        throw badTicket(`${label} ${money(p)} is ${pct}% away from the reference price ${money(ref)}. Check the price.`, "price_band");
      }
      if (own && away > BAND_WARN) warn("far_from_market", `${label} ${money(p)} is ${pct}% away from the reference price ${money(ref)}.`);
    }
  }
  return warnings;
}

/**
 * The order request as the API answers it (section 3.2). broker_state is never sent.
 * @param {OrderRequestRow} row
 * @param {number} t now
 */
export function viewOf(row, t) {
  let status = /** @type {string} */ (row.status);
  let error = row.error ?? null;
  const sentAt = timeOf(row.sent_at);
  const expiresAt = timeOf(row.expires_at);
  const broker = BROKER_NAMES[row.broker_id] ?? row.broker_id;
  if ((status === "preview" || status === "needs_confirmation") && expiresAt !== null && expiresAt <= t) status = "expired";
  if (status === "sending" && isStaleSending(row, t)) {
    status = "unknown";
    error = error ?? unknownSentence(broker);
  }
  /** @type {Record<string, unknown>} */
  const out = {
    id: row.id,
    status,
    clientOrderId: row.client_order_id,
    accountId: row.account_id,
    connectionId: row.connection_id,
    brokerId: row.broker_id,
    environment: row.environment,
    accountDisplay: row.account_display,
    ticket: ticketView(row),
  };
  const preview = previewView(row);
  if (preview) out.preview = preview;
  out.expiresAt = isoOrNull(row.expires_at);
  if (row.broker_order_id) out.brokerOrderId = row.broker_order_id;
  if (Array.isArray(row.broker_order_ids) && row.broker_order_ids.length) out.brokerOrderIds = row.broker_order_ids;
  out.brokerMessages = Array.isArray(row.broker_messages) ? row.broker_messages : [];
  if (error) out.error = error;
  out.autoChecking = status === "unknown" && sentAt !== null && t - sentAt <= RECONCILE_FOR_MS;
  const resolvedAt = isoOrNull(row.resolved_at);
  if (resolvedAt) out.resolvedAt = resolvedAt;
  out.createdAt = isoOrNull(row.created_at);
  out.updatedAt = isoOrNull(row.updated_at);
  const sent = isoOrNull(row.sent_at);
  if (sent) out.sentAt = sent;
  const placed = isoOrNull(row.placed_at);
  if (placed) out.placedAt = placed;
  return out;
}

/** @param {OrderRequestRow} row */
function ticketView(row) {
  const r = row.request && typeof row.request === "object" ? row.request : {};
  /** @type {Record<string, unknown>} */
  const out = { accountId: row.account_id ?? "" };
  for (const k of ["symbol", "side", "quantity", "type", "limitPrice", "stopPrice", "tif"]) {
    if (r[k] !== null && r[k] !== undefined) out[k] = r[k];
  }
  if (r.bracket) {
    const sl = r.bracket.stopLoss ?? {};
    out.bracket = {
      takeProfit: { limitPrice: r.bracket.takeProfit?.limitPrice },
      stopLoss: sl.limitPrice === null || sl.limitPrice === undefined ? { stopPrice: sl.stopPrice } : { stopPrice: sl.stopPrice, limitPrice: sl.limitPrice },
    };
  }
  out.intent = r.intent ?? "trade";
  if (r.positionId !== null && r.positionId !== undefined) out.positionId = r.positionId;
  if (r.expectedPositionQty !== null && r.expectedPositionQty !== undefined) out.expectedPositionQty = r.expectedPositionQty;
  return out;
}

/** @param {OrderRequestRow} row */
function previewView(row) {
  const p = row.preview;
  if (!p || typeof p !== "object") return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  if (p.quote) out.quote = p.quote;
  if (isNum(p.referencePrice)) out.referencePrice = p.referencePrice;
  if (p.instrument) out.instrument = p.instrument;
  out.estimate = p.estimate ?? { source: BROKER_NAMES[row.broker_id] ?? row.broker_id };
  const before = isNum(p.position?.qty) ? p.position.qty : 0;
  const q = Number(row.quantity) || 0;
  out.position = { before, after: before + (row.side === "BUY" ? q : -q) };
  if (isNum(p.buyingPower)) out.buyingPower = p.buyingPower;
  if (typeof p.marketOpen === "boolean") out.marketOpen = p.marketOpen;
  if (typeof p.nextOpen === "string" && p.nextOpen) out.nextOpen = p.nextOpen;
  out.warnings = Array.isArray(p.warnings) ? p.warnings : [];
  out.notices = Array.isArray(p.notices) ? p.notices : [];
  return out;
}

/** @param {OrderRequestRow} row @param {number} t */
function isStaleSending(row, t) {
  const sent = timeOf(row.sent_at);
  return row.status === "sending" && sent !== null && t - sent > STALE_SENDING_MS;
}

/** @param {OrderRequestRow} row @param {number} t */
const isUnconfirmed = (row, t) => row.status === "unknown" || isStaleSending(row, t);

// ─────────────────────────────────────────────────────────────── the service

/**
 * @param {{
 *   config: import("./config.mjs").Config,
 *   registry: import("./registry.mjs").Registry,
 *   store: import("./db.mjs").Store,
 *   audit: import("./audit.mjs").Audit,
 *   cache: import("./cache.mjs").CoalescingCache,
 *   locks: import("./locks.mjs").Locks,
 *   log: import("./log.mjs").Logger,
 *   now?: () => number,
 *   steps: import("./limits.mjs").WindowCounter,
 * }} deps
 */
export function createOrderService(deps) {
  const { config, registry, store, audit, cache, locks, log, steps } = deps;
  const now = deps.now ?? Date.now;
  const limits = config.orders;

  let draining = false;
  let inFlight = 0;
  let calendarWarnedAt = 0;
  /** @type {Map<string, Promise<OrderRequestRow>>} single-flight reconcile per request id */
  const reconciling = new Map();

  /** @param {string} id */
  const nameOf = (id) => BROKER_NAMES[id] ?? id;

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function counted(fn) {
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
    }
  }

  /** A refusal that is logged but not audited (gate and rate limits). @param {unknown} e */
  function refused(e) {
    if (e instanceof HttpError) log.info("order refused", { code: e.code });
    return e;
  }

  /**
   * @param {string} key
   * @param {number} limit
   * @param {number} windowMs
   * @param {string} message
   */
  function take(key, limit, windowMs, message) {
    try {
      steps.take(key, limit, windowMs, message);
    } catch (e) {
      throw refused(e);
    }
  }

  // ── gate (section 1.2)

  /**
   * @param {Claims} claims
   * @param {{ placing: boolean, ignoreDrain?: boolean }} o
   * @returns {Promise<{ workspace: OrderGateWorkspace, member: { role: string, workspace_id: string | null } }>}
   */
  async function gate(claims, o) {
    try {
      if (!ROLES.includes(claims.role)) throw fail(403, "forbidden", GATE.forbidden);
      const wid = claims.wid;
      if (!wid) throw fail(403, "no_workspace", GATE.no_workspace);
      let rows;
      try {
        rows = await store.orderGate(wid, claims.sub);
      } catch (e) {
        log.warn("order gate unreadable", { code: /** @type {any} */ (e)?.code ?? null });
        throw fail(403, "order_entry_off", GATE.order_entry_off);
      }
      const { workspace, member } = rows;
      if (!workspace) throw fail(403, "order_entry_off", GATE.order_entry_off);
      if (!member || member.workspace_id !== wid || member.role !== claims.role) throw fail(403, "not_member", GATE.not_member);
      if (workspace.status === "suspended") throw fail(403, "workspace_suspended", GATE.workspace_suspended);
      if (workspace.orders_enabled !== true) throw fail(403, "order_entry_off", GATE.order_entry_off);
      if (o.placing && limits.entry !== "on") throw fail(403, "order_entry_paused", GATE.order_entry_paused);
      if (o.placing && !o.ignoreDrain && draining) throw fail(503, "shutting_down", GATE.shutting_down);
      return { workspace, member };
    } catch (e) {
      throw refused(e);
    }
  }

  /**
   * Status, "Check again", "mark as checked" and the list: role, workspace and member only (D15).
   * @param {Claims} claims
   * @returns {Promise<{ workspace: OrderGateWorkspace | null }>}
   */
  async function readGate(claims) {
    try {
      if (!ROLES.includes(claims.role)) throw fail(403, "forbidden", GATE.forbidden);
      const wid = claims.wid;
      if (!wid) throw fail(403, "no_workspace", GATE.no_workspace);
      let rows;
      try {
        rows = await store.orderGate(wid, claims.sub);
      } catch (e) {
        log.warn("order gate unreadable", { code: /** @type {any} */ (e)?.code ?? null });
        throw fail(503, "unavailable", "Nasscord could not check your workspace right now. Try again in a moment.");
      }
      const { workspace, member } = rows;
      if (!member || member.workspace_id !== wid || member.role !== claims.role) throw fail(403, "not_member", GATE.not_member);
      return { workspace };
    } catch (e) {
      throw refused(e);
    }
  }

  /** @param {ConnectionRow} connection @param {string} sub @param {{ owner_id: string | null } | null} workspace */
  const mayTrade = (connection, sub, workspace) => connection.user_id === sub || (!!workspace?.owner_id && workspace.owner_id === sub);

  // ── account and connection (section 3.3 resolve)

  /**
   * @param {string} wid
   * @param {unknown} accountId
   * @param {{ sub: string, workspace: { owner_id: string | null } | null }} o
   */
  async function resolve(wid, accountId, o) {
    const notHere = () => fail(404, "not_found", "That account is not in your workspace.");
    if (typeof accountId !== "string" || !UUID_RE.test(accountId)) throw notHere();
    const account = await store.getAccount(accountId.toLowerCase());
    if (!account || account.workspace_id !== wid) throw notHere();
    if (account.included !== true) {
      throw fail(409, "account_excluded", "This account is switched off in Brokers. Include it to trade it from Nasscord.");
    }
    const connection = await store.getConnection(account.connection_id);
    if (!connection || connection.workspace_id !== wid) throw notHere();
    const brokerName = nameOf(account.broker_id);
    if (connection.broker_id !== account.broker_id) {
      throw fail(409, "account_mismatch", `Nasscord could not match this account to its connection. Reconnect ${brokerName}.`);
    }
    if (!TRADING_METHODS.includes(connection.method)) {
      throw fail(403, "broker_read_only", `Nasscord does not place orders at ${brokerName}. Use ${brokerName}'s own app.`);
    }
    if (connection.environment === "sandbox") throw fail(400, "sandbox_refused", "Orders never go to a sandbox connection.");
    if (connection.status !== "active") {
      throw fail(409, "connection_not_live", `${brokerName} is not connected right now. Reconnect it in Brokers, then try again.`);
    }
    if (!mayTrade(connection, o.sub, o.workspace)) throw fail(403, "not_your_connection", D17_TRADE(brokerName));
    const trading = registry.tradingFor(connection);
    if (!trading) throw fail(403, "broker_read_only", `Nasscord does not place orders at ${brokerName}. Use ${brokerName}'s own app.`);
    const answer = trading.capabilities(connection, await store.listAccounts([connection.id]));
    if (!answer) throw fail(403, "broker_read_only", `Orders are not available for this ${brokerName} connection.`);
    if ("blocked" in answer) throw fail(403, "broker_read_only", answer.blocked);
    return { account, connection, trading, caps: /** @type {TradingCapabilities} */ (answer), brokerName, accountKey: accountKey(account) };
  }

  /** "IBKR Paper DU1•••67 · BUY 10 AAPL" @param {{ broker_id: string, environment: string, account_display: string }} r @param {string} what */
  const targetOf = (r, what) => `${nameOf(r.broker_id)} ${r.environment === "paper" ? "Paper" : "Live"} ${r.account_display} · ${what}`;
  /** @param {OrderRequestRow} row */
  const target = (row) => targetOf(row, `${row.side} ${row.quantity} ${row.symbol}`);

  /**
   * @param {Claims} claims
   * @param {Omit<import("./audit.mjs").AuditEntry, "actor">} entry
   */
  function record(claims, entry) {
    void audit.record({ actor: { sub: claims.sub, wid: claims.wid }, workspaceId: claims.wid, ...entry });
  }

  /** @param {unknown} e @returns {"denied" | "error"} */
  const resultOf = (e) => (e instanceof HttpError && e.status < 500 ? "denied" : "error");

  /**
   * Runs `fn` under the order lock of a connection, or throws 409 busy with `busyMessage`.
   * @template T
   * @param {string} connectionId
   * @param {number} maxWaitMs
   * @param {string} busyMessage
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function underLock(connectionId, maxWaitMs, busyMessage, fn) {
    try {
      return await locks.run(`order:${connectionId}`, fn, { maxWaitMs });
    } catch (e) {
      if (e instanceof LockTimeoutError) throw fail(409, "busy", busyMessage);
      throw e;
    }
  }

  // ── duplicate risk (section 1.5)

  /**
   * @param {AccountRow} account
   * @param {Ticket} ticket
   * @param {number} t the service time of the check (stored with the preview as checkedAt)
   * @returns {Promise<{ warnings: OrderWarning[], seen: string[] }>} seen: the similar rows sent within
   *   SIMILAR_MARGIN_MS of the check, which the warning covers (place leaves them out)
   */
  async function duplicateWarnings(account, ticket, t) {
    // Keyed by the broker account (account_key), not broker_accounts.id: the same account can sit under
    // two connections, and a disconnect and reconnect replace its broker_accounts rows.
    const key = accountKey(account);
    /** @type {OrderWarning[]} */
    const out = [];
    const recent = await store.listOrderRequests(
      {
        account_key: key,
        symbol: ticket.symbol,
        side: ticket.side,
        status: ["in", [...OPEN_STATUSES]],
        sent_at: ["gte", isoOf(t - SIMILAR_WINDOW_MS)],
      },
      { order: "sent_at.desc", limit: 20 },
    );
    const seen = recent.filter((x) => (timeOf(x.sent_at) ?? 0) >= t - SIMILAR_MARGIN_MS).map((x) => x.id);
    if (recent.length) {
      const sent = timeOf(recent[0].sent_at) ?? t;
      const min = Math.max(1, Math.ceil((t - sent) / 60_000));
      out.push({
        code: "recent_similar",
        text: `You sent a ${ticket.side === "BUY" ? "Buy" : "Sell"} order for ${ticket.symbol} from Nasscord ${min} min ago. Check Orders so you do not place it twice.`,
        source: "nasscord",
      });
    }
    const open = await store.listOrderRequests(
      { account_key: key, status: ["in", ["unknown", "sending"]], resolved_at: ["is", null], sent_at: ["gte", isoOf(t - UNKNOWN_WINDOW_MS)] },
      { limit: 50 },
    );
    if (open.some((r) => isUnconfirmed(r, t))) {
      out.push({
        code: "unknown_outcome",
        text: "An earlier Nasscord order on this account has an unconfirmed outcome. Check Orders before you place another.",
        source: "nasscord",
      });
    }
    return { warnings: out, seen };
  }

  /**
   * The session warnings of section 1.5.
   * @param {Ticket} ticket
   * @param {BrokerPreview} bp
   * @returns {{ marketOpen: boolean, warnings: OrderWarning[] }}
   */
  function sessionWarnings(ticket, bp) {
    const session = usRegularSession(now());
    if (!session.known && now() - calendarWarnedAt > 3_600_000) {
      calendarWarnedAt = now();
      log.warn("market calendar ended");
    }
    const marketOpen = typeof bp.marketOpen === "boolean" ? bp.marketOpen : session.open;
    /** @type {OrderWarning[]} */
    const warnings = [];
    if (!marketOpen) {
      if (ticket.type === "MKT") {
        const ref = isNum(bp.referencePrice) ? money(/** @type {number} */ (bp.referencePrice)) : "the last price";
        warnings.push({
          code: "market_closed_market",
          text: `The market is closed. This Market order waits for the next session and fills at the opening price, which can be far from ${ref}.`,
          source: "nasscord",
        });
      } else {
        warnings.push({ code: "market_closed", text: "The market is closed. This order waits for the next regular session.", source: "nasscord" });
      }
    }
    return { marketOpen, warnings };
  }

  /** Strips the place-time words from a sentence a preview answers. @param {string} s */
  const withoutNotPlaced = (s) => s.replace(/\s*Nothing was placed\.\s*/g, " ").replace(/\s+/g, " ").trim();
  /** @param {string} s */
  const withNotPlaced = (s) => (s.includes(NOT_PLACED) ? s : `${s} ${NOT_PLACED}`);

  /**
   * A safe summary of a ticket body for the audit meta (no free text from the request).
   * @param {any} body
   * @param {string | null} code
   */
  function ticketMeta(body, code) {
    const b = body && typeof body === "object" ? body : {};
    const sym = normalizeSymbol(typeof b.symbol === "string" ? b.symbol : "");
    return {
      accountId: typeof b.accountId === "string" && UUID_RE.test(b.accountId) ? b.accountId : null,
      symbol: SYMBOL_RE.test(sym) ? sym : null,
      side: b.side === "BUY" || b.side === "SELL" ? b.side : null,
      quantity: isNum(b.quantity) ? b.quantity : null,
      type: TYPES.includes(b.type) ? b.type : null,
      tif: b.tif === "DAY" || b.tif === "GTC" ? b.tif : null,
      bracket: !!b.bracket,
      intent: b.intent === "close" ? "close" : "trade",
      code,
    };
  }

  // ── preview

  /** @param {Claims} claims @param {any} body */
  function preview(claims, body) {
    return counted(async () => {
      const { workspace } = await gate(claims, { placing: true });
      take(`order-preview:${claims.sub}`, 30, 60_000, LIMITS.preview);
      const wid = /** @type {string} */ (claims.wid);
      /** @type {{ broker_id: string, environment: string, account_display: string } | null} */
      let where = null;
      try {
        const r = await resolve(wid, body?.accountId, { sub: claims.sub, workspace });
        where = { broker_id: r.account.broker_id, environment: r.connection.environment, account_display: r.account.display_number };
        const ticket = normalizeTicket(body, r.caps, { brokerName: r.brokerName, account: r.account, maxQty: limits.maxQty });
        const clientOrderId = newClientOrderId();
        const bp = await underLock(r.connection.id, LOCK_WAIT_MS, "Another order on this connection is being sent. Try the preview again in a moment.", async () => {
          /** @type {OrderCtx} */
          const ctx = { connection: r.connection, account: r.account, requestId: null, deadline: now() + PREVIEW_DEADLINE_MS, saveBrokerState: async () => {} };
          // A preview that waited for the lock while the service began to stop calls no broker.
          if (draining) throw fail(503, "shutting_down", GATE.shutting_down);
          // The gate again after the lock wait: a switch turned off meanwhile stops the preview too.
          await gate(claims, { placing: true });
          try {
            return await r.trading.previewOrder(ctx, ticket, clientOrderId);
          } catch (e) {
            if (e instanceof OrderNotSentError) {
              throw new HttpError(e.status, withoutNotPlaced(e.message), { code: e.code, retryAfterSec: e.retryAfterSec });
            }
            throw e;
          }
        });
        const position = bp?.position;
        applyPositionRules(ticket, position, { brokerName: r.brokerName, maxQty: limits.maxQty });
        const priceWarnings = checkPrices(ticket, bp, { brokerName: r.brokerName, maxNotional: limits.maxNotional, pos: position.qty });
        const session = sessionWarnings(ticket, bp);
        const checkedAt = now();
        const dupes = await duplicateWarnings(r.account, ticket, checkedAt);
        const brokerWarnings = Array.isArray(bp.warnings) ? bp.warnings : [];
        const row = await store.insertOrderRequest({
          workspace_id: wid,
          user_id: claims.sub,
          connection_id: r.connection.id,
          account_id: r.account.id,
          account_key: r.accountKey,
          broker_id: /** @type {any} */ (r.account.broker_id),
          method: /** @type {any} */ (r.connection.method),
          environment: /** @type {any} */ (r.connection.environment),
          account_display: r.account.display_number,
          client_order_id: clientOrderId,
          symbol: ticket.symbol,
          side: ticket.side,
          quantity: ticket.quantity,
          order_type: ticket.type,
          tif: ticket.tif,
          bracket: !!ticket.bracket,
          intent: ticket.intent,
          request: ticket,
          preview: {
            quote: bp.quote ?? null,
            referencePrice: isNum(bp.referencePrice) ? bp.referencePrice : null,
            instrument: bp.instrument ?? null,
            estimate: bp.estimate ?? { source: r.brokerName },
            buyingPower: isNum(bp.buyingPower) ? bp.buyingPower : null,
            marketOpen: session.marketOpen,
            nextOpen: typeof bp.nextOpen === "string" ? bp.nextOpen : null,
            position: { qty: position.qty, workingSell: position.workingSell ?? 0, workingBuy: position.workingBuy ?? 0, working: position.working === true },
            warnings: [...brokerWarnings, ...priceWarnings, ...session.warnings, ...dupes.warnings],
            notices: Array.isArray(bp.notices) ? bp.notices : [],
            // The service time of the duplicate check and the similar rows it saw near that time: place
            // refuses any other similar order sent from SIMILAR_MARGIN_MS before it on.
            checkedAt: isoOf(checkedAt),
            similarSeen: dupes.seen,
          },
          broker_state: bp.brokerState && typeof bp.brokerState === "object" ? bp.brokerState : {},
          status: "preview",
          expires_at: isoOf(now() + PREVIEW_TTL_MS),
        });
        log.info("order previewed", { requestId: row.id, connectionId: r.connection.id, clientOrderId });
        return { request: viewOf(row, now()) };
      } catch (e) {
        const code = e instanceof HttpError ? e.code : "error";
        record(claims, {
          action: "broker.order.preview",
          target: where ? targetOf(where, `${body?.side === "SELL" ? "SELL" : "BUY"} ${isNum(body?.quantity) ? body.quantity : "?"} ${ticketMeta(body, null).symbol ?? "?"}`) : "orders",
          result: resultOf(e),
          meta: ticketMeta(body, code),
        });
        if (!(e instanceof HttpError)) log.error("order preview failed", { error: e });
        throw e;
      }
    });
  }

  // ── place

  /** @param {any} body */
  function parsePlaceBody(body) {
    const b = body && typeof body === "object" ? body : {};
    if (typeof b.requestId !== "string" || !UUID_RE.test(b.requestId)) throw fail(400, "bad_request", "Send the order request id.");
    const list = (/** @type {unknown} */ v, /** @type {number} */ max) =>
      v === undefined || v === null ? [] : Array.isArray(v) && v.length <= 10 && v.every((s) => typeof s === "string" && s.length <= max) ? /** @type {string[]} */ (v) : null;
    const acknowledged = list(b.acknowledged, 64);
    if (acknowledged === null) throw fail(400, "bad_request", "Confirm the order from the dialog that shows its notices.");
    const confirm = list(b.confirmBrokerMessages, 32);
    if (confirm === null) throw fail(400, "bad_request", "IBKR's questions changed. Preview the order again.");
    return { requestId: b.requestId.toLowerCase(), acknowledged, confirm, confirmSent: b.confirmBrokerMessages !== undefined && b.confirmBrokerMessages !== null };
  }

  /** @param {Claims} claims @param {any} body */
  function place(claims, body) {
    return counted(async () => {
      await readGate(claims);
      const input = parsePlaceBody(body);
      const wid = /** @type {string} */ (claims.wid);
      const row = await store.getOrderRequest(input.requestId);
      if (!row || row.workspace_id !== wid) throw fail(404, "not_found", "That order request does not exist.");
      // An idempotent replay: no gate, no broker call, no audit.
      if (row.status !== "preview" && row.status !== "needs_confirmation") return { request: viewOf(row, now()) };

      const { workspace } = await gate(claims, { placing: true });
      if (row.user_id !== claims.sub) throw refused(fail(403, "not_your_preview", "Only the person who previewed this order can place it."));
      if ((timeOf(row.expires_at) ?? 0) <= now()) throw refused(fail(409, "preview_expired", "This preview is more than 2 minutes old. Preview the order again."));
      const noticeKeys = (Array.isArray(row.preview?.notices) ? row.preview.notices : []).map((/** @type {any} */ n) => String(n?.key ?? ""));
      if (!noticeKeys.every((k) => input.acknowledged.includes(k))) {
        throw refused(fail(409, "notices_not_acknowledged", "Confirm the order from the dialog that shows its notices."));
      }
      const ack = input.acknowledged.filter((k) => noticeKeys.includes(k));
      /** @type {BrokerMessage[]} */
      const rowMessages = Array.isArray(row.broker_messages) ? row.broker_messages : [];
      if (row.status === "needs_confirmation") {
        const want = new Set(rowMessages.map((m) => String(m.id)));
        const got = new Set(input.confirm);
        if (want.size !== got.size || [...want].some((id) => !got.has(id))) {
          throw refused(fail(409, "confirm_mismatch", "IBKR's questions changed. Preview the order again."));
        }
      } else if (input.confirm.length > 0) {
        throw refused(fail(400, "bad_request", "This order has no broker questions to confirm. Preview the order again."));
      }

      take(`order-place:${claims.sub}`, 10, 60_000, LIMITS.place);
      take(`order-place-h:${claims.sub}`, 60, 3_600_000, LIMITS.place);
      take("order-place:*", 120, 60_000, LIMITS.placeAll);

      try {
        const r = await resolve(wid, row.account_id, { sub: claims.sub, workspace });
        take(`order-place-acct:${r.accountKey}`, 6, 60_000, LIMITS.place);
        /** @type {Ticket} */
        let ticket;
        try {
          ticket = normalizeTicket({ ...row.request, accountId: row.account_id }, r.caps, { brokerName: r.brokerName, account: r.account, maxQty: limits.maxQty });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          throw fail(409, "capabilities_changed", `What ${r.brokerName} accepts from Nasscord changed. Preview the order again.`);
        }
        return await underLock(r.connection.id, LOCK_WAIT_MS, "Another order on this connection is still being sent. Nothing was placed. Try again in a moment.", () =>
          placeLocked(claims, row, r, ticket, ack, rowMessages),
        );
      } catch (e) {
        if (!(e instanceof PlacedError)) {
          record(claims, {
            action: "broker.order.place",
            target: target(row),
            result: resultOf(e),
            meta: { requestId: row.id, clientOrderId: row.client_order_id, attempt: row.attempts, code: e instanceof HttpError ? e.code : "error" },
          });
          throw e;
        }
        throw e.cause;
      }
    });
  }

  /**
   * Thrown out of placeLocked once the claim happened, so the caller does not audit twice.
   */
  class PlacedError extends Error {
    /** @param {unknown} cause */
    constructor(cause) {
      super("order outcome not stored");
      this.name = "PlacedError";
      this.cause = cause;
    }
  }

  /**
   * A BUY checked again with the fresh position, right before the send (inside the lock). A ticket
   * previewed as a cover of a short position that is no longer short would go out as an opening buy
   * the preview never checked: refused. Every BUY that now opens or adds to a long position runs the
   * notional cap again with the stored reference price. Throws an HttpError (the outcome is rejected).
   * @param {OrderRequestRow} row
   * @param {Ticket} ticket
   * @param {number} pos the fresh signed position
   */
  function buyStillFits(row, ticket, pos) {
    const p = row.preview && typeof row.preview === "object" ? row.preview : {};
    const before = p.position?.qty;
    if (ticket.intent === "trade" && isNum(before) && before < 0 && pos >= 0) {
      throw fail(409, "position_changed", `Your ${ticket.symbol} position is now ${qtyText(pos)} shares. Review the order and confirm again.`);
    }
    if (pos < 0) return;
    const ref = isNum(p.referencePrice) && p.referencePrice > 0 ? /** @type {number} */ (p.referencePrice) : null;
    if (ticket.type === "MKT" && ref === null) {
      throw fail(409, "no_reference_price", `Nasscord has no market price for ${ticket.symbol} from the preview, so this Market order cannot be checked against your limits.`);
    }
    checkNotional(ticket, ref, { maxNotional: limits.maxNotional, pos });
  }

  /**
   * Steps 6.1 to 6.10 of section 3.3, inside the order lock.
   * @param {Claims} claims
   * @param {OrderRequestRow} row
   * @param {Awaited<ReturnType<typeof resolve>>} r
   * @param {Ticket} ticket
   * @param {string[]} ack
   * @param {BrokerMessage[]} rowMessages
   */
  async function placeLocked(claims, row, r, ticket, ack, rowMessages) {
    const { connection, account, trading, brokerName } = r;
    // A place that waited for the lock while the service began to stop: the row is still unclaimed,
    // so nothing is sent and Place can be pressed again after the restart (D13).
    if (draining) throw fail(503, "shutting_down", GATE.shutting_down);
    // The gate again after the lock wait (up to LOCK_WAIT_MS): a super admin who turns order entry
    // off, or suspends the workspace, while this place is queued stops it before the claim.
    await gate(claims, { placing: true });
    // The claim names the attempt this call validated (status and client order id): a call that
    // queued behind another round of the same row can never send with that round's stale questions.
    const claimed = await store.claimOrderRequest(
      row.id,
      [row.status],
      { status: "sending", attempts: row.attempts + 1, sent_at: isoOf(now()), error: null },
      { notExpiredAt: isoOf(now()), clientOrderId: row.client_order_id },
    );
    if (!claimed) {
      const again = await store.getOrderRequest(row.id);
      if (again && again.status === "needs_confirmation" && again.client_order_id !== row.client_order_id) {
        throw fail(409, "confirm_mismatch", "IBKR's questions changed. Preview the order again.");
      }
      if (!again || again.status === "preview" || again.status === "needs_confirmation") {
        throw fail(409, "preview_expired", "This preview is more than 2 minutes old. Preview the order again.");
      }
      return { request: viewOf(again, now()) };
    }

    const deadline = now() + PLACE_DEADLINE_MS;
    /** @type {Record<string, unknown>} */
    let current = claimed.broker_state && typeof claimed.broker_state === "object" ? { ...claimed.broker_state } : {};
    /** @type {OrderCtx} */
    const ctx = {
      connection,
      account,
      requestId: row.id,
      deadline,
      saveBrokerState: async (patch) => {
        current = { ...current, ...patch };
        await store.updateOrderRequest(row.id, { broker_state: current });
      },
    };

    /** @type {ApprovedMessage[]} */
    const approved = [
      ...(Array.isArray(current.approvedMessages) ? /** @type {ApprovedMessage[]} */ (current.approvedMessages) : []),
      ...(row.status === "needs_confirmation" ? rowMessages.map((m) => ({ id: String(m.id), textHash: messageTextHash(String(m.text ?? "")) })) : []),
    ];
    const previous = Array.isArray(current.previousClientOrderIds) ? /** @type {string[]} */ (current.previousClientOrderIds) : [];

    /** @type {PlaceOutcome} */
    let outcome = { status: "unknown", error: unknownSentence(brokerName) };
    let sent = false;
    try {
      // 6.3: another ticket for the same broker account, symbol and side went out after this preview
      // (keyed by account_key, so it holds across two connections and across a reconnect).
      // From the preview's duplicate check (service clock, the same clock as sent_at) less a margin,
      // leaving out the rows that check saw: nothing sent between the warning and this read slips past
      // both guards. An older row without checkedAt falls back to its insert time.
      const pv = row.preview && typeof row.preview === "object" ? row.preview : {};
      const checked = timeOf(pv.checkedAt);
      const seen = new Set(Array.isArray(pv.similarSeen) ? pv.similarSeen.map(String) : []);
      const since = checked !== null ? checked - SIMILAR_MARGIN_MS : (timeOf(row.created_at) ?? 0);
      const similar = (
        await store.listOrderRequests(
          {
            account_key: r.accountKey,
            symbol: ticket.symbol,
            side: ticket.side,
            status: ["in", [...OPEN_STATUSES]],
            sent_at: ["gte", isoOf(since)],
            id: ["neq", row.id],
          },
          { limit: 50 },
        )
      ).filter((x) => !seen.has(String(x.id)));
      if (similar.length) {
        outcome = {
          status: "rejected",
          code: "similar_since_preview",
          error: `Another ${ticket.side === "BUY" ? "Buy" : "Sell"} order for ${ticket.symbol} went out from Nasscord after this preview. Nothing was placed. Preview again if you want a second one.`,
        };
      } else {
        // 6.4: the position and working orders, fresh, right before the send.
        /** @type {PositionState | null} */
        let ps = null;
        try {
          ps = await trading.positionState(ctx, ticket, current);
          applyPositionRules(ticket, ps, { brokerName, maxQty: limits.maxQty, placing: true });
          if (ticket.side === "BUY") buyStillFits(row, ticket, ps.qty);
        } catch (e) {
          ps = null;
          outcome =
            e instanceof HttpError
              ? { status: "rejected", error: withNotPlaced(e.message), code: e.code }
              : { status: "rejected", error: `Nasscord could not read your ${ticket.symbol} position at ${brokerName}. ${NOT_PLACED}`, code: "position_unreadable" };
          if (!(e instanceof HttpError)) log.warn("order position unreadable", { requestId: row.id, error: e });
        }
        if (ps) {
          // 6.5: the send.
          sent = true;
          try {
            outcome = await trading.placeOrder(ctx, {
              ticket,
              clientOrderId: claimed.client_order_id,
              previousClientOrderIds: previous,
              brokerState: current,
              acknowledged: ack,
              approvedMessages: approved,
              position: ps,
            });
            outcome = checkOutcome(outcome, brokerName, row.id);
          } catch (e) {
            if (e instanceof OrderNotSentError) {
              outcome = { status: "rejected", error: e.message, code: e.code };
            } else {
              log.error("order outcome unknown", { requestId: row.id, error: e });
              outcome = { status: "unknown", error: unknownSentence(brokerName) };
            }
          }
        }
      }
    } catch (e) {
      if (sent) {
        // Defensive: the send path catches its own errors, but once it started nothing may read as "not placed".
        log.error("order outcome unknown", { requestId: row.id, error: e });
        outcome = { status: "unknown", error: unknownSentence(brokerName) };
      } else {
        // A database read before the send failed: nothing went out.
        log.error("order check failed before sending", { requestId: row.id, error: e });
        outcome = { status: "rejected", code: "unavailable", error: `Nasscord could not check this order before sending. ${NOT_PLACED} Try again.` };
      }
    }
    const o = outcome;

    // 6.6: persist the outcome (one update).
    /** @type {Partial<OrderRequestRow>} */
    let patch;
    let stored = o.status;
    if (o.status === "placed") {
      const p = row.preview && typeof row.preview === "object" ? row.preview : {};
      const extra = Array.isArray(o.warnings) ? o.warnings : [];
      patch = {
        status: "placed",
        broker_order_id: validOrderId(o.brokerOrderId),
        broker_order_ids: Array.isArray(o.brokerOrderIds) && o.brokerOrderIds.length ? o.brokerOrderIds : null,
        broker_messages: Array.isArray(o.messages) && o.messages.length ? o.messages : null,
        placed_at: isoOf(now()),
        error: null,
        preview: extra.length ? { ...p, warnings: [...(Array.isArray(p.warnings) ? p.warnings : []), ...extra] } : row.preview,
      };
    } else if (o.status === "rejected") {
      patch = { status: "rejected", error: cut(o.error, 500), broker_messages: Array.isArray(o.messages) && o.messages.length ? o.messages : null };
    } else if (o.status === "needs_confirmation") {
      if (claimed.attempts >= MAX_ATTEMPTS) {
        stored = "rejected";
        patch = { status: "rejected", error: "IBKR kept asking for confirmations. Nothing was placed. Place this order in IBKR instead.", broker_messages: o.messages };
      } else {
        patch = {
          status: "needs_confirmation",
          broker_messages: o.messages,
          broker_state: {
            ...current,
            ...(o.brokerState ?? {}),
            previousClientOrderIds: [...previous, claimed.client_order_id],
            approvedMessages: approved,
          },
          client_order_id: newClientOrderId(),
          expires_at: isoOf(now() + PREVIEW_TTL_MS),
        };
      }
    } else {
      patch = { status: "unknown", error: cut(o.error, 500) };
    }

    /** @type {OrderRequestRow} */
    let latest;
    try {
      const saved = await store.updateOrderRequest(row.id, patch);
      if (!saved) throw new Error("order request row missing");
      latest = saved;
    } catch (e) {
      log.error("order outcome not stored", {
        requestId: row.id,
        status: o.status,
        brokerOrderId: o.status === "placed" ? validOrderId(o.brokerOrderId) : null,
        error: e,
      });
      record(claims, {
        action: "broker.order.place",
        target: target(row),
        result: "error",
        meta: { requestId: row.id, clientOrderId: claimed.client_order_id, attempt: claimed.attempts, outcome: "unknown", code: "not_stored" },
      });
      if (sent) cache.invalidate(connection.id);
      // Never an HttpError: the service answers 500 without a code, and the app keeps checking.
      throw new PlacedError(new Error("order outcome not stored"));
    }

    // 6.7, 6.8
    if (stored === "placed" || stored === "unknown" || stored === "needs_confirmation") cache.invalidate(connection.id);
    log.info("order outcome", {
      requestId: row.id,
      connectionId: connection.id,
      clientOrderId: claimed.client_order_id,
      outcome: stored,
      brokerCode: o.status === "rejected" ? o.code : null,
    });
    /** @type {Record<string, unknown>} */
    const meta = { requestId: row.id, clientOrderId: claimed.client_order_id, attempt: claimed.attempts, outcome: stored };
    if (o.status === "placed" && latest.broker_order_id) meta.brokerOrderId = latest.broker_order_id;
    if (o.status === "rejected") meta.code = o.code;
    if (stored === "rejected" && o.status === "needs_confirmation") meta.code = "too_many_confirmations";
    if (o.status === "needs_confirmation" || (o.status === "rejected" && o.messages?.length)) {
      meta.messageIds = (o.messages ?? []).map((m) => String(m.id)).slice(0, 20);
    }
    record(claims, {
      action: "broker.order.place",
      target: target(row),
      result: stored === "placed" || stored === "needs_confirmation" ? "ok" : stored === "rejected" ? "denied" : "error",
      meta,
    });

    // 6.9: one reconcile right away, with the time the deadline leaves.
    if (stored === "unknown" && deadline - now() > 3_000) {
      try {
        latest = await reconcile(latest, { force: true, locked: true, budgetMs: Math.min(STATUS_DEADLINE_MS, deadline - now()) });
      } catch (e) {
        log.warn("order reconcile failed", { requestId: row.id, error: e });
      }
    }
    return { request: viewOf(latest, now()) };
  }

  /**
   * An adapter answer that is not one of the four outcomes is unknown (the order may have gone out).
   * @param {any} out
   * @param {string} brokerName
   * @param {string} requestId
   * @returns {PlaceOutcome}
   */
  function checkOutcome(out, brokerName, requestId) {
    const s = out?.status;
    if (s === "placed") return out;
    if (s === "rejected" && typeof out.error === "string") return { ...out, code: typeof out.code === "string" ? out.code : "broker_refused" };
    if (s === "needs_confirmation" && Array.isArray(out.messages) && out.messages.length) return out;
    if (s === "unknown") return { status: "unknown", error: typeof out.error === "string" && out.error ? out.error : unknownSentence(brokerName) };
    log.error("order outcome unreadable", { requestId, status: typeof s === "string" ? s : null });
    return { status: "unknown", error: unknownSentence(brokerName) };
  }

  /** @param {unknown} id */
  function validOrderId(id) {
    if (typeof id !== "string" && typeof id !== "number") return null;
    const s = String(id).trim();
    return s.length >= 1 && s.length <= 64 ? s : null;
  }

  // ── reconcile (section 1.4)

  /**
   * @param {OrderRequestRow} row
   * @param {{ force?: boolean, budgetMs?: number, locked?: boolean }} o
   * @returns {Promise<OrderRequestRow>}
   */
  function reconcile(row, o) {
    if (o.locked) return reconcileNow(row, o);
    const running = reconciling.get(row.id);
    if (running) return running;
    const p = reconcileNow(row, o).finally(() => {
      if (reconciling.get(row.id) === p) reconciling.delete(row.id);
    });
    reconciling.set(row.id, p);
    return p;
  }

  /**
   * @param {OrderRequestRow} row
   * @param {number} t
   * @param {boolean} force no 30-minute limit
   */
  function eligible(row, t, force) {
    if (!isUnconfirmed(row, t)) return false;
    const sent = timeOf(row.sent_at);
    if (!force && (sent === null || t - sent > RECONCILE_FOR_MS)) return false;
    const last = timeOf(row.reconciled_at);
    return last === null || t - last >= RECONCILE_EVERY_MS;
  }

  /**
   * @param {OrderRequestRow} row
   * @param {{ force?: boolean, budgetMs?: number, locked?: boolean }} o
   * @returns {Promise<OrderRequestRow>}
   */
  async function reconcileNow(row, o) {
    const reach = await reconcileTarget(row);
    if (!reach) return row;
    const { connection, account, trading } = reach;
    const brokerName = nameOf(row.broker_id);

    const inner = async () => {
      const fresh = await store.getOrderRequest(row.id);
      if (!fresh) return row;
      const t = now();
      if (!eligible(fresh, t, !!o.force)) return fresh;
      const stale = fresh.status === "sending";
      const state = fresh.broker_state && typeof fresh.broker_state === "object" ? fresh.broker_state : {};
      const previous = Array.isArray(state.previousClientOrderIds) ? /** @type {string[]} */ (state.previousClientOrderIds) : [];
      /** @type {OrderCtx} */
      const ctx = {
        connection,
        account,
        requestId: fresh.id,
        deadline: t + (o.budgetMs ?? STATUS_DEADLINE_MS),
        saveBrokerState: async (patch) => {
          await store.updateOrderRequest(fresh.id, { broker_state: { ...state, ...patch } });
        },
      };
      /** @type {import("./order-contract.mjs").ReconcileOutcome} */
      let out;
      try {
        out = await trading.reconcileOrder(ctx, {
          ticket: /** @type {Ticket} */ (fresh.request),
          clientOrderIds: [fresh.client_order_id, ...[...previous].reverse()],
          brokerState: state,
          sentAt: fresh.sent_at,
        });
      } catch (e) {
        log.warn("order reconcile failed", { requestId: fresh.id, error: e });
        return (await store.updateOrderRequest(fresh.id, { reconciled_at: isoOf(now()) })) ?? fresh;
      }
      const at = isoOf(now());
      if (out?.found === true) {
        const brokerOrderId = validOrderId(out.brokerOrderId);
        const legs = Array.isArray(out.brokerOrderIds) && out.brokerOrderIds.length ? out.brokerOrderIds : null;
        /** @type {Partial<OrderRequestRow>} */
        const patch = out.rejected
          ? { status: "rejected", error: `${brokerName} rejected this order.`, broker_order_id: brokerOrderId, broker_order_ids: legs, reconciled_at: at }
          : { status: "placed", broker_order_id: brokerOrderId, broker_order_ids: legs, placed_at: at, error: null, reconciled_at: at };
        const saved = (await store.updateOrderRequest(fresh.id, patch)) ?? fresh;
        cache.invalidate(connection.id);
        log.info("order reconciled", { requestId: fresh.id, connectionId: connection.id, clientOrderId: fresh.client_order_id, outcome: patch.status });
        void audit.record({
          actor: "system",
          workspaceId: fresh.workspace_id,
          action: "broker.order.reconcile",
          target: target(fresh),
          result: "ok",
          meta: { requestId: fresh.id, clientOrderId: fresh.client_order_id, outcome: patch.status, brokerOrderId },
        });
        return saved;
      }
      const error =
        out?.found === false
          ? cut(typeof out.detail === "string" && out.detail ? out.detail : notListedSentence(brokerName), 500)
          : cut(`${unknownSentence(brokerName)} ${typeof out?.reason === "string" ? out.reason : ""}`.trim(), 500);
      /** @type {Partial<OrderRequestRow>} */
      const patch = { reconciled_at: at, error };
      if (stale) patch.status = "unknown";
      return (await store.updateOrderRequest(fresh.id, patch)) ?? fresh;
    };

    if (o.locked) return inner();
    try {
      return await locks.run(`order:${connection.id}`, inner, { maxWaitMs: STATUS_LOCK_WAIT_MS });
    } catch (e) {
      if (e instanceof LockTimeoutError) return (await store.getOrderRequest(row.id)) ?? row;
      throw e;
    }
  }

  /**
   * The connection and account a reconcile of this row reads through: the row's own while they are
   * still there, active and in the row's workspace; else the account with the same account_key (a
   * disconnect and reconnect replaced the broker_accounts rows, so account_id became null) on an active
   * connection of the same method in the workspace. Null when there is none: nothing can check the
   * row automatically. The switch, `included` and the connection owner are not required (D15).
   * @param {OrderRequestRow} row
   * @returns {Promise<{ connection: ConnectionRow, account: AccountRow, trading: TradingAdapter } | null>}
   */
  async function reconcileTarget(row) {
    /** @param {ConnectionRow | null} c */
    const usable = (c) =>
      !!c && c.workspace_id === row.workspace_id && c.status === "active" && c.method === row.method && c.broker_id === row.broker_id && !!registry.tradingFor(c);
    const [connection, account] = await Promise.all([
      row.connection_id ? store.getConnection(row.connection_id) : Promise.resolve(null),
      row.account_id ? store.getAccount(row.account_id) : Promise.resolve(null),
    ]);
    if (connection && account && usable(connection) && account.workspace_id === row.workspace_id && account.connection_id === connection.id) {
      return { connection, account, trading: /** @type {TradingAdapter} */ (registry.tradingFor(connection)) };
    }
    if (typeof row.account_key !== "string" || !row.account_key) return null;
    const conns = (await store.listConnections({ workspace_id: row.workspace_id, status: "active" })).filter(usable);
    if (!conns.length) return null;
    for (const a of await store.listAccounts(conns.map((c) => c.id))) {
      if (a.workspace_id !== row.workspace_id || a.broker_id !== row.broker_id || accountKey(a) !== row.account_key) continue;
      const c = conns.find((x) => x.id === a.connection_id);
      if (c) return { connection: c, account: a, trading: /** @type {TradingAdapter} */ (registry.tradingFor(c)) };
    }
    return null;
  }

  /**
   * The views of rows, with `autoChecking: false` where no active connection can reach the row's
   * broker account any more (it was disconnected, or its session dropped): the UI then says Nasscord
   * stopped checking instead of promising a check that cannot run. A failed lookup keeps the view.
   * @param {OrderRequestRow[]} rows
   * @param {number} t
   */
  async function viewsOf(rows, t) {
    /** @type {Map<string, Promise<boolean>>} */
    const reachable = new Map();
    return Promise.all(
      rows.map(async (row) => {
        const view = viewOf(row, t);
        if (view.autoChecking !== true) return view;
        const k = `${row.connection_id}|${row.account_id}|${row.account_key}|${row.method}`;
        let p = reachable.get(k);
        if (!p) {
          p = reconcileTarget(row).then(
            (x) => x !== null,
            () => true,
          );
          reachable.set(k, p);
        }
        if (!(await p)) view.autoChecking = false;
        return view;
      }),
    );
  }

  /** @param {string} wid @param {string} id */
  async function loadRow(wid, id) {
    if (typeof id !== "string" || !UUID_RE.test(id)) throw fail(404, "not_found", "That order request does not exist.");
    const row = await store.getOrderRequest(id.toLowerCase());
    if (!row || row.workspace_id !== wid) throw fail(404, "not_found", "That order request does not exist.");
    return row;
  }

  // ── status reads

  /** @param {Claims} claims @param {string} id */
  async function request(claims, id) {
    await readGate(claims);
    let row = await loadRow(/** @type {string} */ (claims.wid), id);
    if (eligible(row, now(), false)) {
      try {
        row = await reconcile(row, { force: false });
      } catch (e) {
        log.warn("order reconcile failed", { requestId: row.id, error: e });
      }
    }
    return { request: (await viewsOf([row], now()))[0] };
  }

  /** @param {Claims} claims @param {string} id */
  async function check(claims, id) {
    await readGate(claims);
    take(`order-check:${claims.sub}`, 30, 60_000, LIMITS.check);
    let row = await loadRow(/** @type {string} */ (claims.wid), id);
    if (isUnconfirmed(row, now())) {
      try {
        row = await reconcile(row, { force: true });
      } catch (e) {
        log.warn("order reconcile failed", { requestId: row.id, error: e });
      }
    }
    return { request: (await viewsOf([row], now()))[0] };
  }

  /** @param {Claims} claims @param {string} id */
  async function markChecked(claims, id) {
    const { workspace } = await readGate(claims);
    take(`order-resolve:${claims.sub}`, 10, 60_000, LIMITS.resolve);
    const row = await loadRow(/** @type {string} */ (claims.wid), id);
    if (row.resolved_at) return { request: viewOf(row, now()) };
    if (!isUnconfirmed(row, now())) throw fail(409, "not_unconfirmed", "Only an unconfirmed order can be marked as checked.");
    if (row.user_id !== claims.sub && !(workspace?.owner_id && workspace.owner_id === claims.sub)) {
      throw fail(403, "not_your_order", "Only the person who sent this order, or the workspace owner, can mark it as checked.");
    }
    const saved = (await store.updateOrderRequest(row.id, { resolved_at: isoOf(now()), resolved_by: claims.sub })) ?? row;
    record(claims, {
      action: "broker.order.resolve",
      target: target(row),
      result: "ok",
      meta: { requestId: row.id, clientOrderId: row.client_order_id },
    });
    return { request: viewOf(saved, now()) };
  }

  /** @param {Claims} claims */
  async function requests(claims) {
    await readGate(claims);
    const t = now();
    const rows = await store.listOrderRequests(
      { workspace_id: /** @type {string} */ (claims.wid), status: ["in", ["sending", "unknown"]], resolved_at: ["is", null], created_at: ["gte", isoOf(t - UNKNOWN_WINDOW_MS)] },
      { limit: 20 },
    );
    const due = rows
      .filter((r) => eligible(r, t, false))
      .sort((a, b) => (timeOf(a.reconciled_at) ?? 0) - (timeOf(b.reconciled_at) ?? 0))
      .slice(0, LIST_RECONCILE_MAX);
    for (const r of due) {
      reconcile(r, { force: false }).catch((e) => log.warn("order reconcile failed", { requestId: r.id, error: e }));
    }
    return { requests: await viewsOf(rows, t) };
  }

  // ── cancel

  /** @param {Claims} claims @param {any} body */
  function cancel(claims, body) {
    return counted(async () => {
      const { workspace } = await gate(claims, { placing: false });
      take(`order-cancel:${claims.sub}`, 30, 60_000, LIMITS.cancel);
      const wid = /** @type {string} */ (claims.wid);
      /** @type {{ broker_id: string, environment: string, account_display: string } | null} */
      let where = null;
      let brokerOrderId = "";
      const accountId = typeof body?.accountId === "string" ? body.accountId : null;
      try {
        if (!accountId || typeof body?.orderId !== "string" || !body.orderId) throw fail(400, "bad_request", "Send the account and the order to cancel.");
        const r = await resolve(wid, accountId, { sub: claims.sub, workspace });
        where = { broker_id: r.account.broker_id, environment: r.connection.environment, account_display: r.account.display_number };
        const orderId = String(body.orderId);
        const parts = orderId.length <= 200 ? orderId.split(":") : [];
        const okParts =
          parts.length >= 3 &&
          parts[0] === r.account.broker_id &&
          parts[1] === r.account.id &&
          !!parts[2] &&
          (r.account.broker_id === "etrade" ? parts.length === 3 || parts.length === 4 : parts.length === 3);
        if (!okParts) throw fail(404, "order_not_open", "This order is not in this account.");
        brokerOrderId = parts[2];
        const outcome = await underLock(r.connection.id, LOCK_WAIT_MS, "Another order on this connection is still being sent. Nothing was cancelled. Try again in a moment.", async () => {
          /** @type {OrderCtx} */
          const ctx = { connection: r.connection, account: r.account, requestId: null, deadline: now() + CANCEL_DEADLINE_MS, saveBrokerState: async () => {} };
          // A cancel that waited for the lock while the service began to stop is not sent: a shutdown
          // must not cut it in half.
          if (draining) throw fail(503, "shutting_down", "The broker service is restarting. Nothing was cancelled. Try again in a minute.");
          try {
            return await r.trading.cancelOrder(ctx, brokerOrderId);
          } catch (e) {
            if (e instanceof HttpError && e.code === "cancel_unknown") cache.invalidate(r.connection.id);
            throw e;
          }
        });
        if (!outcome || (outcome.status !== "cancel_requested" && outcome.status !== "cancelled")) {
          cache.invalidate(r.connection.id);
          throw fail(502, "cancel_unknown", `Nasscord could not confirm the cancel with ${r.brokerName}. Check Orders: the order may still be working.`);
        }
        const rows = await store.listOrderRequests(
          { workspace_id: wid, account_key: r.accountKey, broker_order_id: brokerOrderId, status: ["in", ["placed", "unknown"]] },
          { limit: 10 },
        );
        for (const row of rows) await store.updateOrderRequest(row.id, { status: outcome.status });
        cache.invalidate(r.connection.id);
        record(claims, {
          action: "broker.order.cancel",
          target: targetOf(where, `cancel ${brokerOrderId}`),
          result: "ok",
          meta: { accountId: r.account.id, brokerOrderId, outcome: outcome.status, ...(rows[0] ? { requestId: rows[0].id } : {}) },
        });
        return { status: outcome.status, message: String(outcome.message ?? "") };
      } catch (e) {
        const code = e instanceof HttpError ? e.code : "error";
        /** @type {Record<string, string>} */
        const outcomes = { order_not_open: "not_found", not_cancellable: "not_cancellable", cancel_unknown: "unknown" };
        record(claims, {
          action: "broker.order.cancel",
          target: where ? targetOf(where, `cancel ${brokerOrderId || "?"}`) : "orders",
          result: code === "cancel_unknown" ? "error" : resultOf(e),
          meta: { accountId: accountId && UUID_RE.test(accountId) ? accountId : null, brokerOrderId: brokerOrderId || null, ...(outcomes[code] ? { outcome: outcomes[code] } : {}), code },
        });
        if (!(e instanceof HttpError)) log.error("order cancel failed", { error: e });
        throw e;
      }
    });
  }

  // ── capabilities

  /** @param {Claims} claims */
  async function capabilities(claims) {
    const base = { limits: { maxQty: limits.maxQty, maxNotional: limits.maxNotional } };
    /** @type {{ workspace: OrderGateWorkspace }} */
    let g;
    try {
      g = await gate(claims, { placing: true, ignoreDrain: true });
    } catch (e) {
      /** @type {Record<string, "off" | "suspended" | "paused">} */
      const reasons = { order_entry_off: "off", workspace_suspended: "suspended", order_entry_paused: "paused" };
      if (e instanceof HttpError && reasons[e.code]) {
        return { enabled: false, reason: reasons[e.code], message: e.message, ...base, connections: {}, blocked: {} };
      }
      throw e;
    }
    const conns = (await store.listConnections({ workspace_id: /** @type {string} */ (claims.wid), status: "active" })).filter(
      (c) => TRADING_METHODS.includes(c.method) && c.environment !== "sandbox" && !!registry.tradingFor(c),
    );
    const accounts = await store.listAccounts(conns.map((c) => c.id));
    /** @type {Record<string, TradingCapabilities>} */
    const connections = {};
    /** @type {Record<string, string>} */
    const blocked = {};
    for (const c of conns) {
      const brokerName = nameOf(c.broker_id);
      if (!mayTrade(c, claims.sub, g.workspace)) {
        blocked[c.id] = D17_PLACE(brokerName);
        continue;
      }
      try {
        const answer = registry.tradingFor(c)?.capabilities(
          c,
          accounts.filter((a) => a.connection_id === c.id),
        );
        if (!answer) continue;
        if ("blocked" in answer) blocked[c.id] = answer.blocked;
        else connections[c.id] = answer;
      } catch (e) {
        log.warn("order capabilities failed", { connectionId: c.id, error: e });
      }
    }
    return { enabled: true, reason: null, message: null, ...base, connections, blocked };
  }

  // ── shutdown

  /**
   * Refuses new previews and places at once (503 shutting_down) and resolves when no preview, place
   * or cancel is in flight, or after `maxMs`. Status reads and their reconciles go on meanwhile.
   * @param {number} maxMs
   */
  async function drain(maxMs) {
    draining = true;
    const until = now() + Math.max(0, maxMs);
    while (inFlight > 0 && now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(1, until - now()))));
    }
    if (inFlight > 0) log.warn("orders still in flight at shutdown", { count: inFlight });
  }

  return {
    capabilities,
    preview,
    place,
    request,
    check,
    markChecked,
    requests,
    cancel,
    drain,
    /** For tests and health: previews, places and cancels running now. */
    inFlight: () => inFlight,
  };
}

/** @typedef {ReturnType<typeof createOrderService>} OrderService */
