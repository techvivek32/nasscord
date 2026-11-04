import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TradersTable, type TraderRow } from "@/components/console/traders-table";
import { workspaceHostFor } from "@/components/console/lib";
import { listTenants, listWorkspaces } from "@/lib/server/console";

export const metadata: Metadata = { title: "Traders · Console" };

export default async function TradersPage() {
  const [workspaces, tenants] = await Promise.all([listWorkspaces(), listTenants()]);
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const rows: TraderRow[] = workspaces.map((w) => {
    const tenant = w.tenantId ? (tenantById.get(w.tenantId) ?? null) : null;
    return { ...w, tenantName: tenant?.name ?? null, tenantWhiteLabel: Boolean(tenant?.whiteLabel), host: workspaceHostFor(w, tenant) };
  });
  return (
    <>
      <PageHeader title="Traders" description="Every trading workspace, organic or through a tenant. Open one to see its members and broker connections, or to change its plan or status." />
      <TradersTable rows={rows} />
    </>
  );
}
