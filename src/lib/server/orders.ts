import type { z } from "zod";
import { apiActor, type ApiActor } from "@/lib/server/api";
import { BrokerServiceError } from "@/lib/server/broker-service";
import { rateLimit } from "@/lib/server/rate-limit";
import { isMissingColumn } from "@/lib/server/rows";
import { ORDER_COPY } from "@/lib/order-entry";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Shared plumbing of the order entry routes (/api/broker/orders/*, docs/real-backend.md section 13): the
 * workspace switch and the user's notice, POST guards, per-user step limits and JSON errors `{ error, code }`.
 * Server only. The broker service checks the switch, the connection and every ticket rule again: the checks
 * here only refuse early, so a hand-made request never reaches the service while order entry is off.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

export type OrderStepKind = "preview" | "place" | "cancel" | "check" | "resolve";

/** The service gate's sentences (services/broker/src/orders.mjs), so a refusal reads the same from both. */
const OFF_SENTENCE = "Order entry is not switched on for this workspace.";
const SUSPENDED_SENTENCE = "This workspace is suspended, so it cannot place orders.";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The workspace switch and status, and the user's notice, read with the service role on every call. Any
 * error or a missing row counts as off, and as not accepted. A read that failed (other than a column missing
 * before the order entry migration) is also marked `unreadable`: the POST gates still treat it as off, while
 * the capabilities route answers 503 so the terminal keeps its last good answer instead of flipping to off.
 */
export async function orderEntryState(
  workspaceId: string,
  userId: string,
): Promise<{ enabled: boolean; reason: "off" | "suspended" | null; termsAcceptedAt: string | null; unreadable: boolean }> {
  let enabled = false;
  let reason: "off" | "suspended" | null = "off";
  let termsAcceptedAt: string | null = null;
  let unreadable = false;
  try {
    const admin = createAdminClient();
    const [ws, settings] = await Promise.all([
      admin.from("workspaces").select("status, orders_enabled").eq("id", workspaceId).maybeSingle(),
      admin.from("user_settings").select("order_terms_accepted_at").eq("user_id", userId).maybeSingle(),
    ]);
    if (ws.error) {
      console.error(`[orders] workspace switch unreadable: ${ws.error.code ?? "unknown error"}`);
      if (!isMissingColumn(ws.error.code)) unreadable = true;
    } else if (ws.data) {
      const row = ws.data as { status?: unknown; orders_enabled?: unknown };
      if (row.status === "suspended") reason = "suspended";
      else if (row.orders_enabled === true) {
        enabled = true;
        reason = null;
      }
    }
    if (settings.error) {
      console.error(`[orders] order notice unreadable: ${settings.error.code ?? "unknown error"}`);
      if (!isMissingColumn(settings.error.code)) unreadable = true;
    } else {
      const at = (settings.data as { order_terms_accepted_at?: unknown } | null)?.order_terms_accepted_at;
      if (typeof at === "string" && at) termsAcceptedAt = at;
    }
  } catch (err) {
    console.error(`[orders] order entry state unreadable: ${err instanceof Error ? err.name : "unknown error"}`);
    return { enabled: false, reason: "off", termsAcceptedAt: null, unreadable: true };
  }
  return { enabled, reason, termsAcceptedAt, unreadable };
}

/** { error, code } with Cache-Control private, no-store. Every order route answers errors this way. */
export function orderJsonError(status: number, code: string, error: string, headers?: Record<string, string>): Response {
  return Response.json({ error, code }, { status, headers: { ...NO_STORE, ...(headers ?? {}) } });
}

/**
 * A BrokerServiceError: its status, message and code (code "error" when it has none). A deliberate 503 of the
 * service (shutting_down) keeps its 503; a 429 keeps the service's Retry-After. Anything else:
 * 500 { error: "Something went wrong on our side.", code: "error" }. Logs err.name only.
 */
export function orderRouteError(err: unknown, where: string): Response {
  if (err instanceof BrokerServiceError) {
    const deliberate503 = err.kind === "answered" && err.serviceStatus === 503 && typeof err.code === "string" && err.code !== "error";
    const status = deliberate503 ? 503 : err.status;
    const headers: Record<string, string> = {};
    if (err.retryAfterSec !== undefined && (status === 429 || status === 503)) headers["Retry-After"] = String(err.retryAfterSec);
    return orderJsonError(status, err.code ?? "error", err.message, headers);
  }
  console.error(`[orders] ${where} failed: ${err instanceof Error ? err.name : "unknown error"}`);
  return orderJsonError(500, "error", "Something went wrong on our side.");
}

/** Parsed JSON body, or 400 { error: <first zod message>, code } (code "bad_ticket" for preview, "bad_request" otherwise). */
export async function readOrderBody<S extends z.ZodType>(request: Request, schema: S, code: string): Promise<z.infer<S> | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return orderJsonError(400, code, ORDER_COPY.notJson);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return orderJsonError(400, code, parsed.error.issues[0]?.message ?? "Check the order and try again.");
  return parsed.data;
}

/**
 * POST guard: 403 cross_site when Sec-Fetch-Site is sent and is not same-origin; 415 not_json unless the
 * content type is application/json.
 */
export function orderPostGuard(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return orderJsonError(403, "cross_site", ORDER_COPY.crossSite);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return orderJsonError(415, "not_json", ORDER_COPY.notJson);
  return null;
}

const STEP_LIMIT: Record<OrderStepKind, number> = { preview: 30, place: 10, cancel: 30, check: 30, resolve: 10 };

/**
 * 30 previews, 10 places, 30 cancels, 30 checks and 10 resolves per user per minute (rateLimit, per app
 * instance: a burst guard; the broker service holds the binding limits). 429 rate_limited with Retry-After: 60.
 */
export function limitOrderStep(actor: ApiActor, kind: OrderStepKind): Response | null {
  if (rateLimit(`order-${kind}:${actor.userId}`, STEP_LIMIT[kind], 60_000)) return null;
  return orderJsonError(429, "rate_limited", ORDER_COPY.tooMany, { "Retry-After": "60" });
}

/** apiActor() with its refusals rewritten as { error, code }: 401 signed_out, 403 forbidden, 503 not_configured. */
export async function orderReader(): Promise<ApiActor | Response> {
  const actor = await apiActor();
  if (!(actor instanceof Response)) return actor;
  const body = (await actor.json().catch(() => null)) as { error?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error : "Sign in to continue.";
  const code = actor.status === 401 ? "signed_out" : actor.status === 403 ? "forbidden" : actor.status === 503 ? "not_configured" : "error";
  return orderJsonError(actor.status, code, error);
}

/**
 * For the POST routes: the guard, the caller (orderReader), the step limit; for preview, place and cancel then
 * the switch (403 order_entry_off or workspace_suspended); for preview then the notice (403 terms_not_accepted).
 * check and resolve need no switch: an unconfirmed order stays checkable after order entry is switched off.
 */
export async function orderActor(request: Request, kind: OrderStepKind): Promise<ApiActor | Response> {
  const guard = orderPostGuard(request);
  if (guard) return guard;
  const actor = await orderReader();
  if (actor instanceof Response) return actor;
  const limited = limitOrderStep(actor, kind);
  if (limited) return limited;
  if (kind === "check" || kind === "resolve") return actor;
  const state = await orderEntryState(actor.workspaceId, actor.userId);
  if (state.reason === "suspended") return orderJsonError(403, "workspace_suspended", SUSPENDED_SENTENCE);
  if (!state.enabled) return orderJsonError(403, "order_entry_off", OFF_SENTENCE);
  if (kind === "preview" && !state.termsAcceptedAt) return orderJsonError(403, "terms_not_accepted", ORDER_COPY.termsRequired);
  return actor;
}
