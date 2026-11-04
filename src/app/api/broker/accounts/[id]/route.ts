import { z } from "zod";
import { apiActor, json, jsonError, readBody, routeError, UUID_RE } from "@/lib/server/api";
import { audit } from "@/lib/server/audit";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const bodySchema = z.object({ included: z.boolean({ error: "Send included as true or false." }) });

/** PATCH /api/broker/accounts/[id] { included } -> { ok: true }. Only an account in the caller's workspace. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError(404, "That account no longer exists. Refresh the page.");
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  try {
    const admin = createAdminClient();
    const owned = await admin.from("broker_accounts").select("id, label, display_number").eq("id", id).eq("workspace_id", actor.workspaceId).maybeSingle();
    if (owned.error) throw new Error(owned.error.code ?? "read failed");
    if (!owned.data) return jsonError(404, "That account no longer exists. Refresh the page.");
    const { error } = await admin.from("broker_accounts").update({ included: body.included }).eq("id", id).eq("workspace_id", actor.workspaceId);
    if (error) throw new Error(error.code ?? "update failed");
    await audit({
      actorUserId: actor.userId,
      actorEmail: actor.email,
      workspaceId: actor.workspaceId,
      action: body.included ? "broker.account.include" : "broker.account.exclude",
      target: `${owned.data.label} ${owned.data.display_number}`,
    });
    return json({ ok: true });
  } catch (err) {
    return routeError(err, "PATCH /api/broker/accounts/[id]");
  }
}
