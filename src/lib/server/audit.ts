import { createAdminClient } from "@/lib/supabase/admin";
import { requestIp } from "@/lib/server/request";
import type { AuditEvent } from "@/lib/types";

/*
 * Append-only audit log (public.audit_events), written with the service role.
 * Writing an audit row never fails the action that caused it: an error is logged without values.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

export interface AuditInput {
  actorUserId?: string | null;
  actorEmail?: string | null;
  workspaceId?: string | null;
  action: string;
  target?: string | null;
  result?: AuditEvent["result"];
  meta?: Record<string, unknown> | null;
  /** Defaults to the request's client address. */
  ip?: string | null;
}

export async function audit(input: AuditInput): Promise<void> {
  await recordAudit(input);
}

/**
 * The same row, for an action whose record IS the outcome (a request the console reads back): answers true
 * only when the row was written. Never throws; a failure is logged without values.
 */
export async function recordAudit(input: AuditInput): Promise<boolean> {
  try {
    const ip = input.ip === undefined ? await requestIp() : input.ip;
    const { error } = await createAdminClient()
      .from("audit_events")
      .insert({
        actor_user_id: input.actorUserId ?? null,
        actor_email: input.actorEmail ?? null,
        workspace_id: input.workspaceId ?? null,
        action: input.action,
        target: input.target ?? null,
        result: input.result ?? "ok",
        ip,
        meta: input.meta ?? null,
      });
    if (error) {
      console.error(`[audit] could not record ${input.action}: ${error.code ?? "unknown error"}`);
      return false;
    }
    return true;
  } catch {
    console.error(`[audit] could not record ${input.action}`);
    return false;
  }
}
