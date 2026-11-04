import type { z } from "zod";
import { getAuthUser, getMemberRow } from "@/lib/auth";
import { BrokerServiceError, type ServiceActor } from "@/lib/server/broker-service";
import { rateLimit } from "@/lib/server/rate-limit";
import { TERMINAL_ROLES } from "@/lib/roles";
import { isAdminConfigured } from "@/lib/supabase/admin";
import { isSupabaseConfigured, SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";
import type { Role } from "@/lib/types";

/*
 * Shared plumbing for the /api/broker route handlers: the caller's member and workspace, JSON errors
 * `{ error: "<sentence>" }`, body parsing with zod, and error mapping. Server only.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

export interface ApiActor extends ServiceActor {
  email: string;
  role: Role;
  workspaceId: string;
}

export function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * The signed-in member with a trading workspace, or the error response to send. Only the roles that
 * open the terminal (TERMINAL_ROLES) have broker connections; the broker service refuses every other
 * role, so a tenant login is refused here too instead of half-working.
 */
export async function apiActor(): Promise<ApiActor | Response> {
  if (!isSupabaseConfigured() || !isAdminConfigured()) return jsonError(503, SUPABASE_NOT_CONFIGURED);
  const user = await getAuthUser();
  if (!user) return jsonError(401, "Sign in to continue.");
  const member = await getMemberRow();
  if (!member) return jsonError(403, "Finish setting up your workspace first.");
  if (!TERMINAL_ROLES.includes(member.role)) return jsonError(403, "Broker connections belong to a trading workspace, and this login has none.");
  if (!member.workspace_id) return jsonError(403, "Your account has no trading workspace, so it has no broker connections.");
  return { userId: member.user_id, email: member.email, role: member.role, workspaceId: member.workspace_id };
}

const TOO_MANY_STEPS = "Too many connection attempts from your account. Wait a few minutes and try again.";

/**
 * Connect steps (start, verify, renew) per user: 10 of each kind in 10 minutes. In memory, so on
 * Vercel each instance counts on its own; the broker service enforces the binding per-user and
 * process-wide limits (it runs as one instance). Returns the 429 to send, or null.
 */
export function limitConnectStep(actor: ApiActor, kind: "start" | "verify" | "renew"): Response | null {
  if (rateLimit(`broker-${kind}:${actor.userId}`, 10, 10 * 60_000)) return null;
  return Response.json({ error: TOO_MANY_STEPS }, { status: 429, headers: { "Cache-Control": "private, no-store", "Retry-After": "60" } });
}

/** Parsed JSON body, or a 400 response with the first validation message. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S> | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(400, "Send the request body as JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Check the details and try again.");
  return parsed.data;
}

/** Turns anything thrown in a route into a response. Logs the kind of failure, never values. */
export function routeError(err: unknown, where: string): Response {
  if (err instanceof BrokerServiceError) return jsonError(err.status, err.message);
  console.error(`[api] ${where} failed: ${err instanceof Error ? err.name : "unknown error"}`);
  return jsonError(500, "Something went wrong on our side. Try again in a moment.");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
