"use server";

import { getSession } from "@/lib/auth";
import { TERMINAL_ROLES } from "@/lib/roles";
import { audit, recordAudit } from "@/lib/server/audit";
import { isMissingColumn } from "@/lib/server/rows";
import type { ActionResult } from "@/lib/signup";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";

/*
 * Terminal server actions of order entry (docs/real-backend.md section 13): "Request order entry" and the
 * one-time "Before your first order" notice. Each action checks the session itself, writes with the service
 * role and appends an audit_events row. Results are { ok: true, ... } or { ok: false, error }.
 */

const REQUEST_FAILED = "We could not send the request. Try again.";
const DAY_MS = 24 * 3_600_000;

/**
 * "Request order entry" from the terminal: an audit row the console shows on the trader's page. The super
 * admin still decides. A second request within 24 hours writes nothing and answers already: true.
 * `data.already` repeats `already` for callers that read it there.
 */
export async function requestOrderEntry(): Promise<ActionResult<{ already: boolean; data: { already: boolean } }>> {
  if (!isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const session = await getSession();
  if (!session || !TERMINAL_ROLES.includes(session.role) || !session.workspaceId) return { ok: false, error: "Order entry belongs to a trading workspace." };
  if (session.role === "superadmin") return { ok: false, error: "Switch order entry on for your own desk in the console: Traders, your desk, Order entry." };
  try {
    const admin = createAdminClient();
    const ws = await admin.from("workspaces").select("slug, orders_enabled").eq("id", session.workspaceId).maybeSingle();
    if (ws.error && !isMissingColumn(ws.error.code)) return { ok: false, error: REQUEST_FAILED };
    let slug: string | null = null;
    if (ws.error) {
      // Before the order entry migration the switch does not exist: it is off, and the request still counts.
      const bare = await admin.from("workspaces").select("slug").eq("id", session.workspaceId).maybeSingle();
      if (bare.error || !bare.data) return { ok: false, error: REQUEST_FAILED };
      slug = String((bare.data as { slug?: unknown }).slug ?? "");
    } else {
      if (!ws.data) return { ok: false, error: REQUEST_FAILED };
      const row = ws.data as { slug?: unknown; orders_enabled?: unknown };
      if (row.orders_enabled === true) return { ok: false, error: "Order entry is already on for this workspace." };
      slug = String(row.slug ?? "");
    }
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const recent = await admin
      .from("audit_events")
      .select("id")
      .eq("workspace_id", session.workspaceId)
      .eq("action", "workspace.order_entry.request")
      .gte("at", since)
      .limit(1);
    if (recent.error) return { ok: false, error: REQUEST_FAILED };
    if ((recent.data ?? []).length) return { ok: true, already: true, data: { already: true } };
    // The audit row IS the request (the console's Requested flag and the 24 h check read it): only a
    // written row counts as sent.
    const written = await recordAudit({
      actorUserId: session.uid,
      actorEmail: session.email,
      workspaceId: session.workspaceId,
      action: "workspace.order_entry.request",
      target: `${slug || session.workspace || "workspace"} · requested`,
    });
    if (!written) return { ok: false, error: REQUEST_FAILED };
    return { ok: true, already: false, data: { already: false } };
  } catch {
    return { ok: false, error: REQUEST_FAILED };
  }
}

/**
 * "I understand" on "Before your first order": stores when the user accepted the notice. The first time is
 * kept; accepting again changes nothing.
 */
export async function acceptOrderTerms(): Promise<ActionResult> {
  if (!isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in to continue." };
  const failed = "We could not save that. Try again.";
  const notSetUp = "Order entry is not set up on this server yet.";
  try {
    const admin = createAdminClient();
    const current = await admin.from("user_settings").select("order_terms_accepted_at").eq("user_id", session.uid).maybeSingle();
    if (current.error) return { ok: false, error: isMissingColumn(current.error.code) ? notSetUp : failed };
    const at = (current.data as { order_terms_accepted_at?: unknown } | null)?.order_terms_accepted_at;
    if (typeof at === "string" && at) return { ok: true };
    const { error } = await admin.from("user_settings").upsert({ user_id: session.uid, order_terms_accepted_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) return { ok: false, error: isMissingColumn(error.code) ? notSetUp : failed };
    await audit({
      actorUserId: session.uid,
      actorEmail: session.email,
      workspaceId: session.workspaceId ?? null,
      action: "user.order_terms.accept",
      target: "order entry notice",
    });
    return { ok: true };
  } catch {
    return { ok: false, error: failed };
  }
}
