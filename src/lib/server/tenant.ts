import { requireRole } from "@/lib/auth";
import { TENANT_PORTAL_ROLES } from "@/lib/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { hydrateTenants, hydrateWorkspaces } from "@/lib/server/directory";
import { MEMBER_COLUMNS, TENANT_COLUMNS, WORKSPACE_COLUMNS, toUser, type MemberRow, type TenantRow, type WorkspaceRow } from "@/lib/server/rows";
import { UUID_RE } from "@/lib/server/api";
import type { Session, Tenant, User, Workspace } from "@/lib/types";

/*
 * Tenant portal reads. Server only. A tenant login sees its own tenant; the super admin, who may
 * enter the portal to support a tenant, names the tenant with `tenantId` (picked on the console's
 * Tenants page with "View portal", kept in PORTAL_TENANT_COOKIE). Writes are in
 * src/lib/server/tenant-actions.ts.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

/** The tenant the super admin chose to view in the portal (an id; read only for the super admin). */
export const PORTAL_TENANT_COOKIE = "ns_portal_tenant";

/** The tenant this request may read, or null (a super admin who did not pick one). */
export async function tenantScope(tenantId?: string | null): Promise<{ session: Session; tenantId: string | null }> {
  const session = await requireRole(TENANT_PORTAL_ROLES, "/tenant");
  if (session.role === "tenant") return { session, tenantId: session.tenantId ?? null };
  return { session, tenantId: tenantId && UUID_RE.test(tenantId) ? tenantId : null };
}

function fail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}: ${error?.code ?? "read failed"}`);
}

export async function getMyTenant(tenantId?: string | null): Promise<Tenant | null> {
  const scope = await tenantScope(tenantId);
  if (!scope.tenantId) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.from("tenants").select(TENANT_COLUMNS).eq("id", scope.tenantId).maybeSingle();
  if (error) fail("tenants", error);
  if (!data) return null;
  const [tenant] = await hydrateTenants(admin, [data as TenantRow]);
  return tenant ?? null;
}

/** Workspaces that came through the tenant, newest first. */
export async function listTenantWorkspaces(tenantId?: string | null): Promise<Workspace[]> {
  const scope = await tenantScope(tenantId);
  if (!scope.tenantId) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspaces").select(WORKSPACE_COLUMNS).eq("tenant_id", scope.tenantId).order("created_at", { ascending: false });
  if (error) fail("workspaces", error);
  return hydrateWorkspaces(admin, (data ?? []) as WorkspaceRow[]);
}

/** Members who belong to the tenant (its tenant users, and its own login). */
export async function listTenantMembers(tenantId?: string | null): Promise<User[]> {
  const scope = await tenantScope(tenantId);
  if (!scope.tenantId) return [];
  const { data, error } = await createAdminClient().from("members").select(MEMBER_COLUMNS).eq("tenant_id", scope.tenantId).order("created_at", { ascending: false });
  if (error) fail("members", error);
  return ((data ?? []) as MemberRow[]).map((row) => toUser(row));
}
