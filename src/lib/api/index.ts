/* ------------------------------------------------------------------
   Browser data functions over the app's own routes (/api/broker/*,
   see docs/real-backend.md section 4). Client components use them
   through the hooks in src/hooks/queries.ts. They call relative URLs,
   so they are for the browser only: server components read through
   src/lib/server/* instead.
   Every failure throws ApiError with a sentence a user can read.
   ------------------------------------------------------------------ */

import type {
  BrokerConnection,
  BrokerId,
  BrokerOptions,
  CancelResult,
  ConnectClient,
  ConnectionEnvironment,
  ConnectionMethod,
  Execution,
  Order,
  OrderCapabilities,
  OrderRequest,
  OrderTicket,
  Position,
  RenewNext,
} from "@/lib/types";
import { ORDER_COPY } from "@/lib/order-entry";

export class ApiError extends Error {
  readonly status: number;
  /** The route's `code`, when it sent one (order routes always do). */
  readonly code?: string;
  /** True when the body was JSON with a string `error`: the app or the broker service refused on purpose. */
  readonly answered: boolean;
  /** From Retry-After on a 429. */
  readonly retryAfterSec?: number;
  constructor(status: number, message: string, extra: { code?: string; answered?: boolean; retryAfterSec?: number } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.answered = extra.answered ?? false;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.retryAfterSec !== undefined) this.retryAfterSec = extra.retryAfterSec;
  }
}

/** A connection that could not be read on this call, from the broker service. */
export interface PartialError {
  connectionId: string;
  message: string;
}

async function request<T>(path: string, init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "You appear to be offline. Check your connection and try again.");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const own = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : null;
    const code = body && typeof body === "object" && "code" in body && typeof (body as { code: unknown }).code === "string" ? (body as { code: string }).code : undefined;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, own ?? "Something went wrong. Try again in a moment.", {
      code,
      answered: own !== null,
      retryAfterSec: res.status === 429 && Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
  }
  return body as T;
}

/* ---------- reads ---------- */

/** Broker connections of the workspace, with balances when the broker answered. */
export async function fetchConnections(): Promise<BrokerConnection[]> {
  return (await fetchConnectionsResult()).connections;
}

/** Same as fetchConnections, plus why balances are missing when the broker service could not answer. */
export function fetchConnectionsResult(): Promise<{ connections: BrokerConnection[]; portfolioError?: string }> {
  return request("/api/broker/connections");
}

export function fetchPositionsResult(): Promise<{ positions: Position[]; errors: PartialError[] }> {
  return request("/api/broker/positions");
}

export function fetchOrdersResult(): Promise<{ orders: Order[]; errors: PartialError[] }> {
  return request("/api/broker/orders");
}

export function fetchExecutionsResult(): Promise<{ executions: Execution[]; errors: PartialError[] }> {
  return request("/api/broker/executions");
}

/** One connection with fresh status from the broker service. */
export async function fetchConnection(id: string): Promise<BrokerConnection> {
  return (await request<{ connection: BrokerConnection }>(`/api/broker/connections/${encodeURIComponent(id)}`)).connection;
}

/* ---------- changes ---------- */

/** Include or exclude an account from totals, positions, orders and executions. */
export async function setAccountIncluded(accountId: string, included: boolean): Promise<void> {
  await request<{ ok: true }>(`/api/broker/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: { included } });
}

/** E*TRADE step 1: the user's own consumer key and secret. Open `authorizeUrl` in a new tab next. */
export function startEtrade(input: { environment: "production" | "sandbox"; consumerKey: string; consumerSecret: string }): Promise<{ connectionId: string; authorizeUrl: string }> {
  return request("/api/broker/etrade/start", { method: "POST", body: input });
}

/** E*TRADE step 2: the verification code E*TRADE showed after the user approved. */
export async function verifyEtrade(input: { connectionId: string; verifier: string }): Promise<BrokerConnection> {
  return (await request<{ connection: BrokerConnection }>("/api/broker/etrade/verify", { method: "POST", body: input })).connection;
}

/** IBKR: starts a gateway. Open /api/broker/ibkr/login/[connectionId] next, then poll fetchConnection until it is connected. */
export function startIbkr(input: { environment: "production" | "paper" }): Promise<{ connectionId: string }> {
  return request("/api/broker/ibkr/start", { method: "POST", body: input });
}

/** What Reconnect answers. `next` says what the user does now; no `next` means the session is fine again. */
export interface RenewResult {
  connection: BrokerConnection;
  /**
   * gateway_login: open /api/broker/ibkr/login/[id] in a new tab, then poll the connection.
   * oauth1_verifier: open `authorizeUrl` (E*TRADE) and ask for the new verification code.
   * api_key: open the key dialog in replace-key mode for this connection (connectKey with connectionId).
   * redirect: open `url` (the canonical hop) in a new tab, then poll until the login lands.
   */
  next?: RenewNext;
  /** IBKR, kept for the existing dialogs: same as next.kind "gateway_login". */
  needsLogin?: boolean;
  /** E*TRADE, kept for the existing dialogs: same as next.authorizeUrl. */
  authorizeUrl?: string;
}

/** Renews a session, or starts a new login when the broker needs one (see RenewResult.next). */
export function renewConnection(id: string): Promise<RenewResult> {
  return request(`/api/broker/connections/${encodeURIComponent(id)}/renew`, { method: "POST" });
}

/* ---------- generic connect flows (docs/real-backend.md section 8) ---------- */

/** Every way of connecting and whether the signed-in user may use it now. Join with connectChoices() from src/lib/broker-connect. */
export function fetchOptions(): Promise<BrokerOptions> {
  return request("/api/broker/options");
}

/** An API key or personal token (Alpaca, the owner's Tradier token). `connectionId` re-keys that connection (replace-key mode). */
export interface ConnectKeyInput {
  brokerId: BrokerId;
  method?: ConnectionMethod;
  environment?: Extract<ConnectionEnvironment, "production" | "paper">;
  keyId?: string;
  secret: string;
  connectionId?: string;
}

/** Checks the key with the broker and stores it on the broker service. Answers the connection with its accounts. */
export async function connectKey(input: ConnectKeyInput): Promise<BrokerConnection> {
  return (await request<{ connection: BrokerConnection }>("/api/broker/key/connect", { method: "POST", body: input })).connection;
}

/** A broker login through OAuth: Nasscord's client (`client: "platform"`), or the user's own app with its key and secret. */
export interface StartOAuthInput {
  brokerId: BrokerId;
  method?: ConnectionMethod;
  client?: ConnectClient;
  environment?: ConnectionEnvironment;
  clientId?: string;
  clientSecret?: string;
}

/** A login started on the broker service: the pending connection and the tab to open. */
export interface StartedLogin {
  connectionId: string;
  /** Nasscord's canonical hop (https://nasscord.com/api/broker/oauth/go?...): open it with target _blank, rel noopener noreferrer. */
  openUrl: string;
}

/**
 * Starts a login that leaves Nasscord for the broker's page. Open `openUrl` in a new tab (it goes
 * through Nasscord's own host, then on to the broker), then poll fetchConnection(connectionId) until
 * it is connected.
 *
 * A 404 from that poll means only that the login finished elsewhere or was removed. It answers 404
 * both when the login joined a connection the workspace already had (the login tab lands on
 * /app/brokers?connected=<that id>, not on the id started here) and when a login that never
 * connected failed: the broker refused it, it was approved in another browser, or it ran past its
 * 10 minutes. So a 404 alone is never success. Refresh the list, and report success only when the
 * landing page names a connection (its announcement to the other tabs) or an active connection of
 * that broker appeared or changed after the start; otherwise say the login did not finish (the
 * login tab shows why).
 */
export function startOAuth(input: StartOAuthInput): Promise<StartedLogin> {
  return request("/api/broker/oauth/start", { method: "POST", body: input });
}

/** The same for a broker read through SnapTrade (Fidelity, Robinhood, Public, Moomoo, Webull...), with the same reading of a 404. */
export function startAggregator(input: { brokerId: BrokerId; environment?: ConnectionEnvironment }): Promise<StartedLogin> {
  return request("/api/broker/aggregator/start", { method: "POST", body: input });
}

/** Disconnects: revokes the broker's tokens where it has a revoke (E*TRADE, SnapTrade), stops an IBKR gateway, and forgets the stored credentials. */
export async function disconnectConnection(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/broker/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ---------- order entry (docs/real-backend.md section 13) ---------- */

/** Whether order entry is on for the workspace and what each connection may send for this user. */
export function fetchOrderCapabilities(): Promise<OrderCapabilities> {
  return request("/api/broker/orders/capabilities");
}

/** Asks the broker for a preview of the ticket; nothing is placed. Answers the stored request (status preview). */
export function previewOrder(ticket: OrderTicket): Promise<{ request: OrderRequest }> {
  return request("/api/broker/orders/preview", { method: "POST", body: ticket });
}

export type PlaceResult = { request: OrderRequest } | { checking: true; requestId: string; error: string };

/** A deliberate refusal of the place route: a 4xx whose body is JSON with an error sentence. */
function isRefusal(err: unknown): err is ApiError {
  return err instanceof ApiError && err.answered && err.status >= 400 && err.status < 500;
}

/**
 * Only a JSON 4xx is a refusal (thrown as ApiError: nothing was sent). A network failure, any 5xx, a 408 or 429
 * without a JSON error, an answer that is not JSON, or a 2xx without `request` or `checking` all mean the order may
 * have gone out: they answer { checking: true, requestId, error: ORDER_COPY.unknownOutcome } and the dialog polls.
 */
export async function placeOrder(input: { requestId: string; acknowledged: string[]; confirmBrokerMessages?: string[] }): Promise<PlaceResult> {
  const checking: PlaceResult = { checking: true, requestId: input.requestId, error: ORDER_COPY.unknownOutcome };
  let answer: unknown;
  try {
    answer = await request<unknown>("/api/broker/orders/place", { method: "POST", body: input });
  } catch (err) {
    if (isRefusal(err)) throw err;
    return checking;
  }
  if (answer && typeof answer === "object") {
    const a = answer as { request?: unknown; checking?: unknown; requestId?: unknown; error?: unknown };
    if (a.request && typeof a.request === "object") return { request: a.request as OrderRequest };
    if (a.checking === true) return { checking: true, requestId: input.requestId, error: typeof a.error === "string" && a.error ? a.error : ORDER_COPY.unknownOutcome };
  }
  return checking;
}

/** One order request as the broker service has it now (it may check an unconfirmed one at the broker first). */
export function fetchOrderRequest(id: string): Promise<{ request: OrderRequest }> {
  return request(`/api/broker/orders/requests/${encodeURIComponent(id)}`);
}

/** The workspace's unconfirmed orders of the last 24 hours that nobody marked as checked. */
export function fetchOrderRequests(): Promise<{ requests: OrderRequest[] }> {
  return request("/api/broker/orders/requests");
}

/** "Check again": asks the broker for an unconfirmed order now, at any age. */
export function checkOrderRequest(id: string): Promise<{ request: OrderRequest }> {
  return request(`/api/broker/orders/requests/${encodeURIComponent(id)}/check`, { method: "POST", body: {} });
}

/** "I checked it": Nasscord stops warning about an unconfirmed order. Nothing changes at the broker. */
export function resolveOrderRequest(id: string): Promise<{ request: OrderRequest }> {
  return request(`/api/broker/orders/requests/${encodeURIComponent(id)}/resolve`, { method: "POST", body: {} });
}

/** Same rule as placeOrder: anything but a JSON 4xx throws ApiError(status, ORDER_COPY.cancelUnknown, { code: "cancel_unknown" }). */
export async function cancelOrder(input: { accountId: string; orderId: string }): Promise<CancelResult> {
  let answer: unknown;
  try {
    answer = await request<unknown>("/api/broker/orders/cancel", { method: "POST", body: input });
  } catch (err) {
    if (isRefusal(err)) throw err;
    throw new ApiError(err instanceof ApiError ? err.status : 0, ORDER_COPY.cancelUnknown, { code: "cancel_unknown" });
  }
  const a = answer && typeof answer === "object" ? (answer as { status?: unknown; message?: unknown }) : null;
  if (a && (a.status === "cancel_requested" || a.status === "cancelled") && typeof a.message === "string") {
    return { status: a.status, message: a.message };
  }
  throw new ApiError(502, ORDER_COPY.cancelUnknown, { code: "cancel_unknown" });
}
