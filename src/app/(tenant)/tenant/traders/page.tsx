import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TenantMembersTable, TenantWorkspacesTable, type TenantMemberRow, type TenantTraderRow } from "@/components/tenant/traders";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal } from "@/components/tenant/scope";
import { hostFor } from "@/lib/branding";
import { listTenantMembers, listTenantWorkspaces } from "@/lib/server/tenant";

export const metadata: Metadata = { title: "Traders · Tenant portal" };

export default async function TenantTradersPage() {
  const { session, tenant } = await loadPortal();
  const header = <PageHeader title="Traders" description="The workspaces created with your code and the people who sign in to them." />;
  if (!tenant) {
    return (
      <>
        {header}
        <NoTenant session={session} />
      </>
    );
  }
  const [workspaces, members] = await Promise.all([listTenantWorkspaces(tenant.id), listTenantMembers(tenant.id)]);
  const workspaceName = new Map(workspaces.map((w) => [w.id, w.name]));
  const traders: TenantTraderRow[] = workspaces.map((w) => ({ ...w, host: hostFor(w, tenant) }));
  const people: TenantMemberRow[] = members.map((m) => ({ ...m, workspaceName: m.workspaceId ? (workspaceName.get(m.workspaceId) ?? null) : null }));

  return (
    <>
      {header}
      <Card>
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>{tenant.whiteLabel && tenant.branding ? `Their terminal shows ${tenant.branding.name}.` : "Their terminal shows the Nasscord brand."}</CardDescription>
        </CardHeader>
        <CardContent>
          <TenantWorkspacesTable rows={traders} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Your tenant users and your own login.</CardDescription>
        </CardHeader>
        <CardContent>
          <TenantMembersTable rows={people} />
        </CardContent>
      </Card>
    </>
  );
}
