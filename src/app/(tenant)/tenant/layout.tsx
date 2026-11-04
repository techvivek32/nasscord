import { unstable_rethrow } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { TenantHeader } from "@/components/tenant/tenant-header";
import { TenantSidebarFooter } from "@/components/tenant/sidebar-footer";
import { loadPortal, tenantKindLabel } from "@/components/tenant/scope";
import { requireRole } from "@/lib/auth";
import { ROLE_LABEL, TENANT_PORTAL_ROLES, areasForRole } from "@/lib/roles";

/** Tenant portal: tenants, and the super admin when they belong to one. The pages show the tenant's own records. */
export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(TENANT_PORTAL_ROLES, "/tenant");
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };

  // The header only names the tenant. If the read fails, the page under it shows the error.
  let tenant: { name: string; kind: string } | null = null;
  try {
    const portal = await loadPortal();
    tenant = portal.tenant ? { name: portal.tenant.name, kind: tenantKindLabel(portal.tenant) } : null;
  } catch (err) {
    unstable_rethrow(err);
  }

  return (
    <AppShell nav="tenant" brandSub="Tenants" brandHref="/tenant" areas={areasForRole(session.role)} header={<TenantHeader user={user} tenant={tenant} />} sidebarFooter={<TenantSidebarFooter user={user} tenant={tenant} />}>
      {children}
    </AppShell>
  );
}
