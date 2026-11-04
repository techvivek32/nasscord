"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";
import { audit } from "@/lib/server/audit";
import { brandingSchema, type BrandingInput } from "@/lib/branding";
import type { ActionResult } from "@/lib/signup";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A tenant edits its own white-label branding. Allowed only once the super admin has granted
 * white-label. The super admin may do it for a tenant by passing `tenantId`.
 */
export async function updateMyTenantBranding(branding: BrandingInput, tenantId?: string): Promise<ActionResult> {
  if (!isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const session = await getSession();
  const target = session?.role === "tenant" ? session.tenantId : session?.role === "superadmin" && tenantId && UUID_RE.test(tenantId) ? tenantId : undefined;
  if (!session || !target) {
    await audit({ actorUserId: session?.uid ?? null, actorEmail: session?.email ?? null, action: "tenant.branding.update", result: "denied" });
    return { ok: false, error: "Only a tenant can change its branding." };
  }

  const parsed = brandingSchema.safeParse(branding);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the branding fields.", field: issue?.path[0]?.toString() };
  }

  const admin = createAdminClient();
  const tenant = await admin.from("tenants").select("name, white_label").eq("id", target).maybeSingle();
  if (tenant.error || !tenant.data) return { ok: false, error: "We could not find your tenant. Try again." };
  if (!tenant.data.white_label) {
    await audit({ actorUserId: session.uid, actorEmail: session.email, action: "tenant.branding.update", target: tenant.data.name, result: "denied" });
    return { ok: false, error: "Branding opens once Nasscord turns on white-label for your tenant." };
  }
  if (parsed.data.domain) {
    const clash = await admin.from("tenants").select("id").eq("branding->>domain", parsed.data.domain).neq("id", target).limit(1);
    if ((clash.data ?? []).length) return { ok: false, field: "domain", error: "Another tenant already uses that domain." };
  }

  const { error } = await admin.from("tenants").update({ branding: parsed.data }).eq("id", target);
  if (error) return { ok: false, error: "We could not save the branding. Try again." };
  await audit({ actorUserId: session.uid, actorEmail: session.email, action: "tenant.branding.update", target: tenant.data.name, meta: { domain: parsed.data.domain ?? null } });
  revalidatePath("/tenant", "layout");
  return { ok: true };
}
