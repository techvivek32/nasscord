import { BROKER_SERVICE_NOT_CONFIGURED, BrokerServiceError, signServiceJwt, type ServiceActor } from "@/lib/server/broker-service";
import { connectionInWorkspace } from "@/lib/server/connections";
import { TERMINAL_ROLES } from "@/lib/roles";

/*
 * Terminal additions to the broker service client (src/lib/server/broker-service.ts), kept apart
 * so phase 1's module stays as it is. Server only.
 *
 * IBKR login links: the browser never receives the bearer link that POST /v1/ibkr/start returns.
 * The app route GET /api/broker/ibkr/login/[id] asks for a fresh one-time ticket at the moment the
 * signed-in user opens the login, and redirects to it (docs/real-backend.md section 7).
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

const TIMEOUT_MS = 8_000;

const STATUS_MESSAGE: Record<number, string> = {
  400: "This connection has no IBKR login.",
  401: "The broker service did not accept this app's credentials. The operator needs to check BROKER_SERVICE_SECRET.",
  403: "That connection is not in your workspace.",
  404: "That connection no longer exists. Open Brokers in Nasscord and connect IBKR again.",
  409: "This IBKR login is not running any more. Press Reconnect in Nasscord to start a new one.",
  429: "Too many requests right now. Wait a few seconds and try again.",
};

/**
 * A fresh IBKR login URL on the login host for a connection of the actor's workspace.
 * Checks the role and the workspace here as well as in the service. Throws BrokerServiceError
 * with a sentence a user can read.
 */
export async function ibkrLoginUrl(actor: ServiceActor & { workspaceId: string }, connectionId: string): Promise<string> {
  if (!TERMINAL_ROLES.includes(actor.role)) throw new BrokerServiceError(403, "Broker connections belong to a trading workspace.");
  if (!(await connectionInWorkspace(connectionId, actor.workspaceId))) throw new BrokerServiceError(404, STATUS_MESSAGE[404]);

  const base = process.env.BROKER_SERVICE_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.BROKER_SERVICE_SECRET;
  if (!base || !secret) throw new BrokerServiceError(503, BROKER_SERVICE_NOT_CONFIGURED);

  let res: Response;
  try {
    res = await fetch(`${base}/v1/ibkr/${encodeURIComponent(connectionId)}/ticket`, {
      method: "POST",
      headers: { accept: "application/json", authorization: `Bearer ${signServiceJwt(actor, Date.now(), secret)}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new BrokerServiceError(504, "The broker service did not answer within 8 seconds. Try again in a moment.");
    throw new BrokerServiceError(503, "The broker service cannot be reached right now. Try again in a moment.");
  }

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const own = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
    const message = typeof own === "string" && own.trim() && own.length <= 300 ? own.trim() : (STATUS_MESSAGE[res.status] ?? "The broker service had a problem. Try again in a moment.");
    throw new BrokerServiceError(res.status === 401 || res.status >= 500 ? 502 : res.status, message);
  }

  const loginUrl = body && typeof body === "object" && "loginUrl" in body ? (body as { loginUrl?: unknown }).loginUrl : undefined;
  if (typeof loginUrl !== "string") throw new BrokerServiceError(502, "The broker service sent a reply the app could not read.");
  let parsed: URL;
  try {
    parsed = new URL(loginUrl);
  } catch {
    throw new BrokerServiceError(502, "The broker service sent a login link the app could not read.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new BrokerServiceError(502, "The broker service sent a login link the app could not read.");
  return parsed.toString();
}
