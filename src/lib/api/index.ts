/* ------------------------------------------------------------------
   Browser data functions over the app's own routes (/api/broker/*,
   see docs/real-backend.md section 4). Client components use them
   through the hooks in src/hooks/queries.ts. They call relative URLs,
   so they are for the browser only: server components read through
   src/lib/server/* instead.
   Every failure throws ApiError with a sentence a user can read.
   ------------------------------------------------------------------ */

import type { BrokerConnection, Execution, Order, Position } from "@/lib/types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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
    const message = body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string" ? (body as { error: string }).error : "Something went wrong. Try again in a moment.";
    throw new ApiError(res.status, message);
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

/** Renews a session. IBKR may answer needsLogin (open the app's login route); E*TRADE may answer a new authorizeUrl. */
export function renewConnection(id: string): Promise<{ connection: BrokerConnection; needsLogin?: boolean; authorizeUrl?: string }> {
  return request(`/api/broker/connections/${encodeURIComponent(id)}/renew`, { method: "POST" });
}

/** Disconnects: revokes E*TRADE tokens or stops the IBKR gateway, and forgets the stored credentials. */
export async function disconnectConnection(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/broker/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}
