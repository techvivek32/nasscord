import { marketSession, sizeByRisk } from "@/lib/engine";
import { fmtMoney, fmtNum } from "@/lib/format";
import { ORDER_TYPE_LABEL, TIF_LABEL, isValidPrice, normalizeSymbol, ticketSchema } from "@/lib/order-entry";
import type { OrderSide, OrderTicket, Position, TicketOrderType, Tif, TradingCaps } from "@/lib/types";

/*
 * The order ticket's rules, as pure functions (no React, no I/O), so the places where a wrong side, a wrong
 * quantity or a wrong account could be born are tested (src/lib/server/__tests__/order-ticket.test.mjs).
 * The components in src/components/terminal only call them. The broker service checks every rule again.
 */

/** The ticket form's raw values. The provider keeps it while the confirm dialog is open, so "Edit order" returns to exactly what the user typed. */
export interface TicketDraft {
  /** broker_accounts.id, or null until the user (or the default rule) picks one. */
  accountId: string | null;
  symbol: string;
  side: OrderSide;
  quantityText: string;
  type: TicketOrderType;
  limitText: string;
  stopText: string;
  tif: Tif;
  bracketOn: boolean;
  stopLossStopText: string;
  stopLossLimitText: string;
  takeProfitText: string;
  /** A stop used for sizing only. It is never sent. */
  sizingStopText: string;
  intent: "trade" | "close";
  /** Position.id of the row the ticket was opened from (row actions and Close). */
  positionId: string | null;
  /** Close: the signed position the user saw. */
  expectedPositionQty: number | null;
  /** Last price of the Positions row, for sizing a Market order. Never sent. */
  last: number | null;
  /** A quantity the ticket may offer as a button (all you hold, cover all). Never put in the field by itself. */
  suggestion: number | null;
}

/** An account the ticket can pick: its id and its connection's environment. */
export interface PickableAccount {
  id: string;
  connection: { environment: string };
}

/** A blank ticket: Buy, Limit, Day, nothing typed. */
export function emptyDraft(accountId: string | null = null): TicketDraft {
  return {
    accountId,
    symbol: "",
    side: "BUY",
    quantityText: "",
    type: "LMT",
    limitText: "",
    stopText: "",
    tif: "DAY",
    bracketOn: false,
    stopLossStopText: "",
    stopLossLimitText: "",
    takeProfitText: "",
    sizingStopText: "",
    intent: "trade",
    positionId: null,
    expectedPositionQty: null,
    last: null,
    suggestion: null,
  };
}

const PRICE_TEXT = /^\d+(\.\d{1,4})?$/;
const QUANTITY_TEXT = /^\d+$/;
export const MAX_TICKET_QTY = 1_000_000;

/** A price typed by the user: digits with at most 4 decimals, then the service's price rule. "185.5O" is null, never 185.5. */
export function parsePrice(text: string): number | null {
  const t = String(text ?? "").trim();
  if (!PRICE_TEXT.test(t)) return null;
  const p = Number(t);
  return isValidPrice(p) ? p : null;
}

/** Whole shares typed by the user, 1 to 1,000,000. "1e3", "10.0" and "-5" are null. */
export function parseQuantity(text: string): number | null {
  const t = String(text ?? "").trim();
  if (!QUANTITY_TEXT.test(t)) return null;
  const q = Number(t);
  return Number.isSafeInteger(q) && q >= 1 && q <= MAX_TICKET_QTY ? q : null;
}

/**
 * The account the ticket starts on: the row it was opened from; else the header's account; else, with the
 * paper setting on, the first paper account; else the only account that can take orders; else null (the user
 * picks, and Preview stays disabled until then). The ticket never guesses between two live accounts.
 */
export function defaultAccountId(o: { prefillAccountId?: string | null; selected?: string | null; tradable: readonly PickableAccount[]; paperFirst: boolean }): string | null {
  const ids = new Set(o.tradable.map((a) => a.id));
  if (o.prefillAccountId && ids.has(o.prefillAccountId)) return o.prefillAccountId;
  if (o.selected && ids.has(o.selected)) return o.selected;
  if (o.paperFirst) {
    const paper = o.tradable.find((a) => a.connection.environment === "paper");
    if (paper) return paper.id;
  }
  if (o.tradable.length === 1) return o.tradable[0].id;
  return null;
}

/** Whether a position row is a stock or ETF the ticket may trade. */
export function isStockPosition(p: Pick<Position, "secType">): boolean {
  return !p.secType || p.secType === "STK" || p.secType === "EQ";
}

/**
 * A ticket opened from a Positions row. buy: Buy (on a short row the button reads "Buy to cover" and the
 * suggestion is the short size); sell: Sell, with the whole shares held as a suggestion; close: the whole
 * position on the opposite side, read only, a Market Day order while the regular session is open by the
 * given clock, otherwise a Limit order with an empty price. Only Close puts a quantity in the field.
 */
export function prefillFromPosition(position: Pick<Position, "id" | "accountId" | "symbol" | "qty" | "last">, action: "buy" | "sell" | "close", ctx: { now: Date; broker: string }): TicketDraft | { error: string } {
  const symbol = normalizeSymbol(position.symbol);
  const qty = Number(position.qty);
  const base: TicketDraft = {
    ...emptyDraft(position.accountId),
    symbol,
    positionId: position.id,
    last: typeof position.last === "number" && Number.isFinite(position.last) && position.last > 0 ? position.last : null,
  };
  if (!Number.isFinite(qty)) return { error: `Nasscord could not read your ${symbol} position.` };
  if (action === "buy") {
    const cover = qty < 0 ? Math.floor(Math.abs(qty)) : 0;
    return { ...base, side: "BUY", suggestion: cover > 0 ? cover : null };
  }
  if (action === "sell") {
    if (qty <= 0) return { error: `You hold no ${symbol} in this account. Nasscord does not sell short.` };
    const all = Math.floor(qty);
    return { ...base, side: "SELL", suggestion: all > 0 ? all : null };
  }
  if (qty === 0) return { error: `You no longer hold ${symbol} in this account.` };
  if (!Number.isInteger(qty)) return { error: `Close fractional positions in ${ctx.broker}.` };
  const open = marketSession(ctx.now) === "regular";
  return {
    ...base,
    intent: "close",
    side: qty > 0 ? "SELL" : "BUY",
    quantityText: String(Math.abs(qty)),
    expectedPositionQty: qty,
    type: open ? "MKT" : "LMT",
    limitText: "",
    tif: "DAY",
  };
}

/** Whether the draft can carry a bracket on these caps (Buy, a trade, an allowed entry type). */
export function bracketAllowed(draft: Pick<TicketDraft, "side" | "intent" | "type">, caps: TradingCaps | null): boolean {
  if (!caps?.bracket) return false;
  return draft.side === "BUY" && draft.intent === "trade" && (caps.bracket.entryTypes as readonly string[]).includes(draft.type);
}

/** Whether the draft's type uses a limit price, a stop price. */
export function usesLimit(type: TicketOrderType): boolean {
  return type === "LMT" || type === "STP_LMT";
}
export function usesStop(type: TicketOrderType): boolean {
  return type === "STP" || type === "STP_LMT";
}

/**
 * After an account change (or any edit), keeps type, time in force and bracket only where the account's caps
 * allow them, otherwise resets them (type Limit, Day, bracket off) and says why in one line each. Market with
 * marketGtc false forces Day; a bracket forces Good till cancelled.
 */
export function fitToCaps(draft: TicketDraft, caps: TradingCaps | null, broker = "This broker"): { draft: TicketDraft; notes: string[] } {
  if (!caps) return { draft, notes: [] };
  const notes: string[] = [];
  let next = { ...draft };
  if (!caps.types.includes(next.type)) {
    const fallback: TicketOrderType = caps.types.includes("LMT") ? "LMT" : (caps.types[0] ?? "LMT");
    notes.push(`${broker} does not take ${ORDER_TYPE_LABEL[next.type]} orders from Nasscord, so the type is now ${ORDER_TYPE_LABEL[fallback]}.`);
    next = { ...next, type: fallback };
  }
  if (next.bracketOn && !bracketAllowed(next, caps)) {
    if (!caps.bracket) notes.push(`${broker} does not take bracket orders from Nasscord for this account, so the stop-loss and take-profit are off.`);
    next = { ...next, bracketOn: false };
  }
  if (next.bracketOn && !caps.tif.includes("GTC")) {
    notes.push(`${broker} does not take Good till cancelled orders from Nasscord, so the stop-loss and take-profit are off.`);
    next = { ...next, bracketOn: false };
  }
  if (next.bracketOn) {
    next = { ...next, tif: "GTC" };
  } else {
    if (!caps.tif.includes(next.tif)) {
      const fallback: Tif = caps.tif.includes("DAY") ? "DAY" : (caps.tif[0] ?? "DAY");
      notes.push(`${broker} does not take ${TIF_LABEL[next.tif]} orders from Nasscord, so the time in force is now ${TIF_LABEL[fallback]}.`);
      next = { ...next, tif: fallback };
    }
    if (next.type === "MKT" && !caps.marketGtc && next.tif !== "DAY") {
      notes.push(`${broker} takes Market orders as Day orders only.`);
      next = { ...next, tif: "DAY" };
    }
  }
  if (!caps.bracket?.stopTypes.includes("STP_LMT") && next.stopLossLimitText) next = { ...next, stopLossLimitText: "" };
  if (next.intent === "close" && next.bracketOn) next = { ...next, bracketOn: false };
  return { draft: next, notes };
}

/** The entry price a size or a value is worked out from: the limit (Limit, Stop limit), the stop (Stop), else the row's last price (Market). */
export function entryPrice(draft: Pick<TicketDraft, "type" | "limitText" | "stopText" | "last">): number | null {
  if (usesLimit(draft.type)) return parsePrice(draft.limitText);
  if (draft.type === "STP") return parsePrice(draft.stopText);
  return draft.last;
}

/**
 * The body of POST /api/broker/orders/preview, with only the fields visible for the current type and caps: a
 * bracket the account cannot take is never sent, a stop price only for Stop and Stop limit, the sizing stop
 * never. The shared rules (ticketSchema) run last; the first refusal is answered as { error }.
 */
export function buildTicketBody(draft: TicketDraft, caps: TradingCaps | null): OrderTicket | { error: string } {
  if (!draft.accountId) return { error: "Pick an account." };
  if (!caps) return { error: "This account cannot take orders from Nasscord." };
  const fitted = fitToCaps(draft, caps).draft;
  const symbol = normalizeSymbol(fitted.symbol);
  if (!symbol) return { error: "Enter a US stock or ETF symbol." };
  const quantity = parseQuantity(fitted.quantityText);
  if (quantity === null) return { error: fitted.quantityText.trim() ? "Enter whole shares." : "Enter a quantity." };
  const body: OrderTicket = { accountId: fitted.accountId as string, symbol, side: fitted.side, quantity, type: fitted.type, tif: fitted.tif, intent: fitted.intent };
  if (usesLimit(fitted.type)) {
    if (!fitted.limitText.trim()) return { error: "Enter a limit price." };
    const p = parsePrice(fitted.limitText);
    if (p === null) return { error: "Use a limit price above 0 with at most 2 decimals (4 below $1)." };
    body.limitPrice = p;
  }
  if (usesStop(fitted.type)) {
    if (!fitted.stopText.trim()) return { error: "Enter a stop price." };
    const p = parsePrice(fitted.stopText);
    if (p === null) return { error: "Use a stop price above 0 with at most 2 decimals (4 below $1)." };
    body.stopPrice = p;
  }
  if (fitted.bracketOn && bracketAllowed(fitted, caps)) {
    if (!fitted.stopLossStopText.trim()) return { error: "Enter the stop-loss price." };
    const slStop = parsePrice(fitted.stopLossStopText);
    if (slStop === null) return { error: "Use a stop-loss price above 0 with at most 2 decimals (4 below $1)." };
    if (!fitted.takeProfitText.trim()) return { error: "Enter the take-profit price." };
    const tp = parsePrice(fitted.takeProfitText);
    if (tp === null) return { error: "Use a take-profit price above 0 with at most 2 decimals (4 below $1)." };
    const stopLoss: { stopPrice: number; limitPrice?: number } = { stopPrice: slStop };
    if (caps.bracket?.stopTypes.includes("STP_LMT") && fitted.stopLossLimitText.trim()) {
      const slLimit = parsePrice(fitted.stopLossLimitText);
      if (slLimit === null) return { error: "Use a stop-loss limit above 0 with at most 2 decimals (4 below $1)." };
      stopLoss.limitPrice = slLimit;
    }
    body.bracket = { takeProfit: { limitPrice: tp }, stopLoss };
    body.tif = "GTC";
  }
  if (fitted.positionId) body.positionId = fitted.positionId;
  if (fitted.intent === "close") {
    if (!fitted.positionId || fitted.expectedPositionQty === null) return { error: "Open Close from the Positions page." };
    body.expectedPositionQty = fitted.expectedPositionQty;
  }
  const checked = ticketSchema.safeParse(body);
  if (!checked.success) return { error: checked.error.issues[0]?.message ?? "Check the order." };
  return checked.data as OrderTicket;
}

/** A size so a stop-out costs riskPct of net liquidation (TradeScope's sizeByRisk), capped at maxQty; null without both prices or when it comes to 0. */
export function sizeSuggestion(o: { netLiq: number | null | undefined; riskPct: number; entry: number | null; stop: number | null; maxQty: number }): number | null {
  if (o.entry === null || o.stop === null || !o.netLiq || o.netLiq <= 0) return null;
  const qty = sizeByRisk(o.netLiq, o.riskPct, o.entry, o.stop).qty;
  const capped = o.maxQty > 0 ? Math.min(qty, o.maxQty) : qty;
  return capped > 0 ? capped : null;
}

/**
 * The per-order limits the broker service enforces, shown inline: the quantity cap, and for a Buy that opens
 * or adds to a long position the value cap. `held` is the signed position when known (a cover is bounded by
 * the short, so it skips the value cap).
 */
export function ticketLimitError(draft: TicketDraft, caps: { limits: { maxQty: number; maxNotional: number } }, held: number | null = null): string | null {
  const q = parseQuantity(draft.quantityText);
  if (q === null) return null;
  const { maxQty, maxNotional } = caps.limits;
  if (maxQty > 0 && q > maxQty) return `Up to ${fmtNum(maxQty)} shares per order.`;
  if (draft.side === "BUY" && maxNotional > 0 && !(held !== null && held < 0)) {
    const entry = entryPrice(draft);
    if (entry !== null && q * entry > maxNotional) {
      return `This order is worth about ${fmtMoney(q * entry, { digits: 0 })}, above the ${fmtMoney(maxNotional, { digits: 0 })} Nasscord allows per order.`;
    }
  }
  return null;
}
