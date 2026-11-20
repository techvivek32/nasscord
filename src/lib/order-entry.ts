import { z } from "zod";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import type { BrokerId, ConnectionMethod, OrderRequestStatus, OrderStatus, TicketOrderType, Tif } from "@/lib/types";

/*
 * Order entry rules shared by the app's order routes and the terminal (docs/real-backend.md section 13).
 * Client-safe: no server imports. The broker service checks every rule again (services/broker/src/orders.mjs
 * and src/order-contract.mjs); the ones here only give the ticket the same answer sooner.
 */

/** The only connect methods that may place orders (the broker service's TRADING_METHODS). */
export const TRADING_METHODS: readonly ConnectionMethod[] = ["ibkr_gateway", "etrade_oauth1", "alpaca_key"];

export function isTradingMethod(m: ConnectionMethod): boolean {
  return TRADING_METHODS.includes(m);
}

/** Brokers with a method that may place orders (Alpaca only through its API key method). */
export const TRADING_BROKERS: readonly BrokerId[] = ["ibkr", "etrade", "alpaca"];

export const ORDER_TYPE_LABEL: Record<TicketOrderType, string> = { MKT: "Market", LMT: "Limit", STP: "Stop", STP_LMT: "Stop limit" };

export const TIF_LABEL: Record<Tif, string> = { DAY: "Day", GTC: "Good till cancelled" };

/** Nasscord's client order id: "nc" + 18 lower-case hex digits. */
export const CLIENT_ORDER_ID_RE = /^nc[0-9a-f]{18}$/;

/**
 * True when the broker reports Nasscord's own client order id on the order. E*TRADE never returns it, so
 * E*TRADE orders are never tagged: the tag is a positive signal only.
 */
export function isNasscordOrder(clientId?: string): boolean {
  return typeof clientId === "string" && CLIENT_ORDER_ID_RE.test(clientId);
}

/** A US stock or ETF ticker as Nasscord stores it. */
export const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

/** Trimmed, upper case, a run of spaces becomes "." ("BRK B" is "BRK.B"), as the broker service does. */
export function normalizeSymbol(s: string): string {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ".");
}

/** The highest price a ticket may carry. */
export const MAX_PRICE = 100_000;

/** Above 0, at most MAX_PRICE, at most 2 decimals at or above $1 and 4 below (the broker service's rule). */
export function isValidPrice(p: number): boolean {
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p > MAX_PRICE) return false;
  const scale = p >= 1 ? 100 : 10_000;
  return Math.abs(Math.round(p * scale) - p * scale) < 1e-6;
}

/**
 * An order price exactly as it is sent (no "$"): 2 decimals with thousands separators at or above $1, 4 below.
 * Every order price on screen uses it, never fmtPrice (which rounds to 2 decimals).
 */
export function formatOrderPrice(p: number): string {
  return p >= 1 ? p.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p.toFixed(4);
}

/** Statuses of an order request whose outcome is still open: keep polling. */
export const ACTIVE_REQUEST: ReadonlySet<OrderRequestStatus> = new Set<OrderRequestStatus>(["sending", "unknown"]);

/** Broker order statuses a cancel can still reach. */
export const CANCELLABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>(["submitted", "verifying", "working", "verified"]);

/** Preview warnings that need the "I checked Orders" tick box before Place. */
export const DUPLICATE_CODES: ReadonlySet<string> = new Set(["duplicate_risk", "recent_similar", "unknown_outcome"]);

/** Warnings on a placed order that mean "check it now". */
export const PLACED_CHECK_CODES: ReadonlySet<string> = new Set([
  "ibkr_waiting_decision",
  "ibkr_echo_mismatch",
  "etrade_echo_mismatch",
  "alpaca_echo_mismatch",
  "ibkr_bracket_incomplete",
  "ibkr_bracket_unverified",
  "ibkr_pending_submit",
]);

const ECHO_MISMATCH = new Set(["ibkr_echo_mismatch", "etrade_echo_mismatch", "alpaca_echo_mismatch"]);

/** Warnings shown as a destructive Alert: an incomplete bracket, and a broker echo that differs on a live account. */
export function isDangerWarning(code: string, environment: "production" | "paper"): boolean {
  if (code === "ibkr_bracket_incomplete") return true;
  return environment === "production" && ECHO_MISMATCH.has(code);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** TradeScope's take-profit for a buy (0.72 R above the entry), or null when the stop is not below the entry. */
export function defaultTarget(entry: number, stop: number): number | null {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || stop <= 0 || !(stop < entry)) return null;
  return round2(entry + ENGINE_DEFAULTS.rewardToRisk * (entry - stop));
}

/* ---------------------------------------------------------------- sentences */

export const ORDER_COPY = {
  offWorkspace: "Order entry is not switched on for this workspace. Place orders in your broker's app.",
  suspended: "This workspace is suspended, so it cannot place orders.",
  unavailable: "Order entry is not available right now because the broker service did not answer. Your broker's own app still works.",
  unknownOutcome: "Nasscord could not confirm whether your broker received this order. Check Orders before you place it again.",
  stillUnconfirmed: "Still unconfirmed. It stays listed on Orders and Positions until Nasscord finds it.",
  sendingNow: "Nasscord is sending this order now. Its outcome shows here in a moment.",
  notSentYet: "Nasscord has not sent this order yet. Placing it again is safe: Nasscord sends one ticket at most once.",
  crossSite: "For your safety, Nasscord accepts orders only from its own terminal pages.",
  notJson: "Send the order as JSON.",
  tooMany: "Too many order requests from your account. Wait a minute and try again.",
  previewTimeout: "The broker service did not answer the preview in time. Nothing was placed. Try again.",
  cancelUnknown: "Nasscord could not confirm the cancel. Check Orders: the order may still be working.",
  listUnavailable: "Nasscord could not load unconfirmed orders right now.",
  termsRequired: "Read the order entry notice and confirm it before your first order.",
  readOnlyBrokers:
    "Buy, Sell and Close appear on stock and ETF positions of included IBKR, E*TRADE and Alpaca (API key) accounts that you can trade. Other connections stay read only.",
  noTradableAccount:
    "None of your connected accounts can take orders from Nasscord. Order entry works with included IBKR, E*TRADE and Alpaca (API key) accounts on broker logins you connected.",
  onButNoAccount: "Order entry is on for this workspace, but none of your connected accounts can take orders.",
  noStopLoss: "This order has no stop-loss. The stop you used for sizing is not sent.",
  duplicateTick: "I checked Orders and this is not a repeat of an earlier order.",
  requestSent: "Request sent. Nasscord switches order entry on per workspace.",
  requestAlready: "You asked already today. Nasscord switches order entry on per workspace.",
} as const;

/** Shown when Nasscord stopped reconciling an unconfirmed order on its own (30 minutes after the send). */
export function stoppedChecking(broker: string): string {
  return `Nasscord stopped checking this order automatically. Check ${broker} directly, then mark it as checked.`;
}

/** "Before your first order": the one-time notice a user accepts before the first preview (the owner confirms the wording). */
export const ORDER_TERMS = [
  "Orders go to your broker account exactly as you confirm them, and your broker fills them under its own rules.",
  "If your broker's answer is lost, Nasscord marks the order Unconfirmed. Check Orders before you send it again.",
  "Your broker's rules, fees and limits apply to every order.",
  "Nasscord is software. It is not a broker and does not give advice.",
] as const;

/* ---------------------------------------------------------------- request bodies */

const PRICE_MESSAGE = "Use a price above 0 with at most 2 decimals (4 below $1).";
const price = z.number({ error: PRICE_MESSAGE }).refine(isValidPrice, PRICE_MESSAGE);

/** Body of POST /api/broker/orders/preview (the OrderTicket type). Unused fields are left out, never null. */
export const ticketSchema = z
  .object({
    accountId: z.uuid({ error: "Pick an account." }),
    symbol: z
      .string({ error: "Enter a US stock or ETF symbol." })
      .transform(normalizeSymbol)
      .pipe(z.string().regex(SYMBOL_RE, "Enter a US stock or ETF symbol.")),
    side: z.enum(["BUY", "SELL"], { error: "Pick Buy or Sell." }),
    quantity: z
      .number({ error: "Enter whole shares." })
      .int("Enter whole shares.")
      .min(1, "Enter at least 1 share.")
      .max(1_000_000, "Enter whole shares, up to 1,000,000."),
    type: z.enum(["MKT", "LMT", "STP", "STP_LMT"], { error: "Pick an order type." }),
    limitPrice: price.optional(),
    stopPrice: price.optional(),
    tif: z.enum(["DAY", "GTC"], { error: "Pick a time in force." }),
    bracket: z
      .object({
        takeProfit: z.object({ limitPrice: price }),
        stopLoss: z.object({ stopPrice: price, limitPrice: price.optional() }),
      })
      .optional(),
    intent: z.enum(["trade", "close"], { error: "Send the order's intent." }),
    positionId: z.string().min(1).max(200, "That position is not in this account.").optional(),
    // zod 4 numbers refuse Infinity and NaN on their own.
    expectedPositionQty: z.number({ error: "Open Close from the Positions page." }).optional(),
  })
  .superRefine((t, ctx) => {
    const needsLimit = t.type === "LMT" || t.type === "STP_LMT";
    const needsStop = t.type === "STP" || t.type === "STP_LMT";
    if (needsLimit && t.limitPrice === undefined) ctx.addIssue({ code: "custom", path: ["limitPrice"], message: "Enter a limit price." });
    if (!needsLimit && t.limitPrice !== undefined) ctx.addIssue({ code: "custom", path: ["limitPrice"], message: "This order type has no limit price." });
    if (needsStop && t.stopPrice === undefined) ctx.addIssue({ code: "custom", path: ["stopPrice"], message: "Enter a stop price." });
    if (!needsStop && t.stopPrice !== undefined) ctx.addIssue({ code: "custom", path: ["stopPrice"], message: "This order type has no stop price." });
    if (t.intent === "close") {
      if (t.positionId === undefined || t.expectedPositionQty === undefined) {
        ctx.addIssue({ code: "custom", path: ["positionId"], message: "Open Close from the Positions page." });
      }
      if (t.bracket) ctx.addIssue({ code: "custom", path: ["bracket"], message: "Open Close from the Positions page." });
    }
    const b = t.bracket;
    if (b) {
      if (t.side !== "BUY") ctx.addIssue({ code: "custom", path: ["bracket"], message: "Brackets are for buy orders: Nasscord does not open short positions." });
      if (t.type !== "MKT" && t.type !== "LMT") ctx.addIssue({ code: "custom", path: ["type"], message: "A bracket enters with a Market or Limit order." });
      if (t.tif !== "GTC") {
        ctx.addIssue({ code: "custom", path: ["tif"], message: "A bracket is sent as Good till cancelled, so its stop-loss and take-profit stay after today's close." });
      }
      if (t.type === "LMT" && t.limitPrice !== undefined && (!(b.stopLoss.stopPrice < t.limitPrice) || !(b.takeProfit.limitPrice > t.limitPrice))) {
        ctx.addIssue({ code: "custom", path: ["bracket"], message: "For a buy bracket, the stop-loss goes below the entry and the take-profit above it." });
      }
      if (b.stopLoss.limitPrice !== undefined && b.stopLoss.limitPrice > b.stopLoss.stopPrice) {
        ctx.addIssue({ code: "custom", path: ["bracket", "stopLoss", "limitPrice"], message: "The stop-loss limit goes at or below its stop price." });
      }
    }
  });

/** Body of POST /api/broker/orders/place: the previewed request, the notice keys and (IBKR) the questions approved. */
export const placeSchema = z.object({
  requestId: z.uuid({ error: "Send the order request id." }),
  acknowledged: z
    .array(z.string({ error: "Confirm the order from the dialog that shows its notices." }).max(64, "Confirm the order from the dialog that shows its notices."))
    .max(10, "Confirm the order from the dialog that shows its notices.")
    .default([]),
  confirmBrokerMessages: z
    .array(z.string({ error: "IBKR's questions changed. Preview the order again." }).max(32, "IBKR's questions changed. Preview the order again."))
    .max(10, "IBKR's questions changed. Preview the order again.")
    .optional(),
});

/** Body of POST /api/broker/orders/cancel: the account and Order.id from GET /api/broker/orders. */
export const cancelSchema = z.object({
  accountId: z.uuid({ error: "Send the account and the order to cancel." }),
  orderId: z.string({ error: "Send the account and the order to cancel." }).min(3, "Send the account and the order to cancel.").max(200, "This order is not in this account."),
});
