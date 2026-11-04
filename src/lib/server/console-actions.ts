"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { isAdminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";
import { audit } from "@/lib/server/audit";
import { PORTAL_TENANT_COOKIE } from "@/lib/server/tenant";
import { brandingSchema, type BrandingInput } from "@/lib/branding";
import type { ActionResult } from "@/lib/signup";
import type { PlanId, Session, TenantApplicationStatus, WorkspaceStatus } from "@/lib/types";

/*
 * Super admin writes for the console. Each action checks the caller's members row again (role
 * superadmin), validates its input, writes with the service role and appends an audit_events row.
 * A refused call is audited as "denied". Results are { ok: true } or { ok: false, error }.
 */

const DENIED = "Only the super admin can do this.";
const uuid = z.uuid("That id is not valid.");

type Refusal = { ok: false; error: string };

async function superadmin(action: string, target?: string): Promise<Session | Refusal> {
  if (!isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const session = await getSession();
  if (session?.role === "superadmin") return session;
  await audit({ actorUserId: session?.uid ?? null, actorEmail: session?.email ?? null, action, target, result: "denied" });
  return { ok: false, error: DENIED };
}

function isSession(v: Session | Refusal): v is Session {
  return "uid" in v;
}

function done(path: string) {
  revalidatePath(path, "layout");
}

const workspaceStatus = z.enum(["active", "trial", "past_due", "suspended"]);
const planId = z.enum(["starter", "pro", "desk", "enterprise"]);

export async function setWorkspaceStatus(workspaceId: string, status: WorkspaceStatus): Promise<ActionResult> {
  const actor = await superadmin("workspace.status.update", workspaceId);
  if (!isSession(actor)) return actor;
  const id = uuid.safeParse(workspaceId);
  const next = workspaceStatus.safeParse(status);
  if (!id.success || !next.success) return { ok: false, error: "Pick a workspace and a valid status." };
  const { data, error } = await createAdminClient().from("workspaces").update({ status: next.data }).eq("id", id.data).select("slug").maybeSingle();
  if (error) return { ok: false, error: "We could not change the status. Try again." };
  if (!data) return { ok: false, error: "That workspace no longer exists." };
  await audit({ actorUserId: actor.uid, actorEmail: actor.email, workspaceId: id.data, action: "workspace.status.update", target: `${data.slug} · ${next.data}` });
  done("/admin");
  return { ok: true };
}

export async function setWorkspacePlan(workspaceId: string, plan: PlanId): Promise<ActionResult> {
  const actor = await superadmin("workspace.plan.update", workspaceId);
  if (!isSession(actor)) return actor;
  const id = uuid.safeParse(workspaceId);
  const next = planId.safeParse(plan);
  if (!id.success || !next.success) return { ok: false, error: "Pick a workspace and a valid plan." };
  const { data, error } = await createAdminClient().from("workspaces").update({ plan: next.data }).eq("id", id.data).select("slug").maybeSingle();
  if (error) return { ok: false, error: "We could not change the plan. Try again." };
  if (!data) return { ok: false, error: "That workspace no longer exists." };
  await audit({ actorUserId: actor.uid, actorEmail: actor.email, workspaceId: id.data, action: "workspace.plan.update", target: `${data.slug} · ${next.data}` });
  done("/admin");
  return { ok: true };
}

export async function setTenantWhiteLabel(tenantId: string, whiteLabel: boolean): Promise<ActionResult> {
  const actor = await superadmin("tenant.whitelabel.update", tenantId);
  if (!isSession(actor)) return actor;
  const id = uuid.safeParse(tenantId);
  if (!id.success || typeof whiteLabel !== "boolean") return { ok: false, error: "Pick a tenant." };
  const { data, error } = await createAdminClient().from("tenants").update({ white_label: whiteLabel }).eq("id", id.data).select("name").maybeSingle();
  if (error) return { ok: false, error: "We could not change white-label. Try again." };
  if (!data) return { ok: false, error: "That tenant no longer exists." };
  await audit({ actorUserId: actor.uid, actorEmail: actor.email, action: whiteLabel ? "tenant.whitelabel.grant" : "tenant.whitelabel.revoke", target: data.name });
  done("/admin");
  done("/tenant");
  return { ok: true };
}

export async function updateTenantBranding(tenantId: string, branding: BrandingInput): Promise<ActionResult> {
  const actor = await superadmin("tenant.branding.update", tenantId);
  if (!isSession(actor)) return actor;
  const id = uuid.safeParse(tenantId);
  if (!id.success) return { ok: false, error: "Pick a tenant." };
  const parsed = brandingSchema.safeParse(branding);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the branding fields.", field: issue?.path[0]?.toString() };
  }
  const admin = createAdminClient();
  if (parsed.data.domain) {
    const clash = await admin.from("tenants").select("id").eq("branding->>domain", parsed.data.domain).neq("id", id.data).limit(1);
    if ((clash.data ?? []).length) return { ok: false, field: "domain", error: "Another tenant already uses that domain." };
  }
  const { data, error } = await admin.from("tenants").update({ branding: parsed.data }).eq("id", id.data).select("name").maybeSingle();
  if (error) return { ok: false, error: "We could not save the branding. Try again." };
  if (!data) return { ok: false, error: "That tenant no longer exists." };
  await audit({ actorUserId: actor.uid, actorEmail: actor.email, action: "tenant.branding.update", target: data.name, meta: { domain: parsed.data.domain ?? null } });
  done("/admin");
  done("/tenant");
  return { ok: true };
}

/**
 * The super admin opens the tenant portal for one tenant (to support it): the choice is kept in a
 * cookie that only the super admin's portal reads. The caller then navigates to /tenant.
 */
export async function viewTenantPortal(tenantId: string): Promise<ActionResult> {
  const actor = await superadmin("tenant.portal.view", tenantId);
  if (!isSession(actor)) return actor;
  const id = uuid.safeParse(tenantId);
  if (!id.success) return { ok: false, error: "Pick a tenant." };
  const { data, error } = await createAdminClient().from("tenants").select("id").eq("id", id.data).maybeSingle();
  if (error) return { ok: false, error: "We could not open that tenant's portal. Try again." };
  if (!data) return { ok: false, error: "That tenant no longer exists." };
  (await cookies()).set(PORTAL_TENANT_COOKIE, id.data, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 8 * 60 * 60 });
  done("/tenant");
  return { ok: true };
}

export async function decideTenantApplication(applicationId: string, decision: Exclude<TenantApplicationStatus, "pending">): Promise<ActionResult> {
  const actor = await superadmin("tenant.application.decide", applicationId);
  if (!isSession(actor)) return actor;
  const id = uuid.safeParse(applicationId);
  const next = z.enum(["approved", "declined"]).safeParse(decision);
  if (!id.success || !next.success) return { ok: false, error: "Pick an application and approve or decline it." };
  const { data, error } = await createAdminClient().from("tenant_applications").update({ status: next.data }).eq("id", id.data).select("company, email").maybeSingle();
  if (error) return { ok: false, error: "We could not record the decision. Try again." };
  if (!data) return { ok: false, error: "That application no longer exists." };
  await audit({ actorUserId: actor.uid, actorEmail: actor.email, action: `tenant.application.${next.data === "approved" ? "approve" : "decline"}`, target: `${data.company} · ${data.email}` });
  done("/admin");
  return { ok: true };
}

const createTenantSchema = z.object({
  name: z.string().trim().min(2, "Enter the tenant's name").max(80, "Keep the name under 80 characters"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "Use 3 to 40 lowercase letters, numbers and hyphens"),
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,24}$/, "Codes are 3 to 24 letters, numbers or hyphens")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  commissionPct: z.number().min(0, "Commission is 0% or more").max(100, "Commission is at most 100%").optional(),
  whiteLabel: z.boolean().optional(),
  /** An existing member who becomes the tenant's login (role "tenant"). They must have signed up already. */
  ownerEmail: z.email("Enter a valid owner email").optional().or(z.literal("").transform(() => undefined)),
});
export type CreateTenantInput = z.input<typeof createTenantSchema>;

/**
 * Creates a tenant. With `ownerEmail`, the member with that email becomes its login: a trader or
 * tenant user becomes role "tenant" (tenant portal only) and leaves their trading workspace, which
 * stays in the console without members; the super admin keeps their role and is only recorded as
 * owner. A tenant login has no broker connections (the app and the broker service refuse the role),
 * so a person whose workspace still has a broker connected is refused until they disconnect it:
 * otherwise their connections, and the E*TRADE key stored for them, would be left with no way to
 * remove them.
 */
export async function createTenant(input: CreateTenantInput): Promise<ActionResult<{ tenantId: string }>> {
  const actor = await superadmin("tenant.create", input?.slug);
  if (!isSession(actor)) return actor;
  const parsed = createTenantSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form and try again.", field: issue?.path[0]?.toString() };
  }
  const v = parsed.data;
  const admin = createAdminClient();

  type Owner = { user_id: string; role: string; email: string; tenant_id: string | null; workspace_id: string | null };
  const liveConnections = async (workspaceId: string) => {
    const r = await admin.from("broker_connections").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).neq("status", "disconnected");
    return r.error ? null : (r.count ?? 0);
  };
  let owner: Owner | null = null;
  if (v.ownerEmail) {
    const found = await admin.from("members").select("user_id, role, email, tenant_id, workspace_id").eq("email", v.ownerEmail.toLowerCase()).maybeSingle();
    if (found.error) return { ok: false, error: "We could not look up that owner. Try again." };
    if (!found.data) return { ok: false, field: "ownerEmail", error: "No account uses that email yet. Ask them to sign up first, then create the tenant." };
    if (found.data.role === "tenant") return { ok: false, field: "ownerEmail", error: "That person already runs a tenant." };
    owner = found.data as Owner;
    if (owner.role !== "superadmin" && owner.workspace_id) {
      const live = await liveConnections(owner.workspace_id);
      if (live === null) return { ok: false, error: "We could not check that person's broker connections. Try again." };
      if (live > 0) {
        return {
          ok: false,
          field: "ownerEmail",
          error: "That person still has a broker connected. A tenant login has no terminal, so ask them to disconnect every broker on their Brokers page first, then create the tenant.",
        };
      }
    }
  }

  const created = await admin
    .from("tenants")
    .insert({
      name: v.name,
      slug: v.slug,
      status: "active",
      ...(v.commissionPct !== undefined ? { commission_pct: v.commissionPct } : {}),
      white_label: v.whiteLabel ?? false,
      referral_code: v.referralCode ?? null,
      owner_id: owner?.user_id ?? null,
    })
    .select("id")
    .single();
  if (created.error || !created.data) {
    if (created.error?.code === "23505") return { ok: false, error: "That slug or referral code is already used by another tenant." };
    return { ok: false, error: "We could not create the tenant. Try again." };
  }
  const tenantId = created.data.id as string;

  if (owner && owner.role !== "superadmin") {
    // A tenant login works in the tenant portal only: it leaves its trading workspace.
    const member = await admin.from("members").update({ role: "tenant", tenant_id: tenantId, workspace_id: null }).eq("user_id", owner.user_id);
    if (member.error) {
      await admin.from("tenants").delete().eq("id", tenantId);
      return { ok: false, error: "We could not make that person the tenant's login. Nothing was created." };
    }
    // A broker connected between the check above and the role change would be left unmanageable.
    if (owner.workspace_id && (await liveConnections(owner.workspace_id)) !== 0) {
      const undo = await admin.from("members").update({ role: owner.role, tenant_id: owner.tenant_id ?? null, workspace_id: owner.workspace_id }).eq("user_id", owner.user_id);
      if (!undo.error) {
        await admin.from("tenants").delete().eq("id", tenantId);
        return { ok: false, field: "ownerEmail", error: "That person connected a broker just now. Ask them to disconnect it on their Brokers page, then create the tenant." };
      }
      console.error(`[console] member rollback failed: ${undo.error.code ?? "unknown error"}`);
    }
    // The members row is authoritative (layouts and RLS read it); app_metadata is the proxy's copy.
    // Keep the two in step: if the copy cannot be written, undo the change instead of leaving them apart.
    const meta = await admin.auth.admin.updateUserById(owner.user_id, { app_metadata: { role: "tenant", tenant_id: tenantId, workspace_id: null } });
    if (meta.error) {
      console.error(`[console] app_metadata update failed: ${meta.error.code ?? "unknown error"}`);
      const undo = await admin.from("members").update({ role: owner.role, tenant_id: owner.tenant_id ?? null, workspace_id: owner.workspace_id ?? null }).eq("user_id", owner.user_id);
      if (!undo.error) {
        await admin.from("tenants").delete().eq("id", tenantId);
        return { ok: false, error: "We could not make that person the tenant's login. Nothing was created." };
      }
      // Undo failed too: the tenant and the members row stand, and the members row is what the app
      // obeys (the proxy lets a stale claim through to the layout), so report the tenant as created.
      console.error(`[console] member rollback failed: ${undo.error.code ?? "unknown error"}`);
    }
  }

  await audit({
    actorUserId: actor.uid,
    actorEmail: actor.email,
    action: "tenant.create",
    target: v.name,
    meta: {
      slug: v.slug,
      referral_code: v.referralCode ?? null,
      owner: owner?.email ?? null,
      ...(owner && owner.role !== "superadmin" && owner.workspace_id ? { left_workspace_id: owner.workspace_id } : {}),
    },
  });
  done("/admin");
  return { ok: true, tenantId };
}
