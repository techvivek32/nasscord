import { AppShell } from "@/components/layout/app-shell";
import { TenantHeader } from "@/components/tenant/tenant-header";
import { TenantSidebarFooter } from "@/components/tenant/sidebar-footer";
import { requireRole } from "@/lib/auth";
import { ROLE_LABEL, TENANT_PORTAL_ROLES, areasForRole } from "@/lib/roles";

/** Tenant portal: commission for every tenant, white-label pages when the super admin has granted it. The super admin may enter to support a tenant. */
export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(TENANT_PORTAL_ROLES, "/tenant");
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };

  return (
    <AppShell nav="tenant" brandSub="Tenants" brandHref="/tenant" areas={areasForRole(session.role)} header={<TenantHeader user={user} />} sidebarFooter={<TenantSidebarFooter user={user} />}>
      {children}
    </AppShell>
  );
}
