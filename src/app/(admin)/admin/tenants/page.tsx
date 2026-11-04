import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { TenantsPage } from "@/components/console/tenants-page";
import { listTenantApplications, listTenants } from "@/lib/server/console";
import { fmtNum } from "@/lib/format";

export const metadata: Metadata = { title: "Tenants · Console" };

export default async function TenantsAdminPage() {
  const [tenants, applications] = await Promise.all([listTenants(), listTenantApplications()]);
  const traders = tenants.reduce((n, t) => n + t.workspaces, 0);
  const pending = applications.filter((a) => a.status === "pending").length;
  return (
    <>
      <PageHeader title="Tenants" description="Distributors who bring traders through their referral code: the tenants on the platform and the applications to become one." />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Tenants" value={fmtNum(tenants.length)} hint={<span className="text-[11px] text-muted-foreground">{fmtNum(tenants.filter((t) => t.status === "active").length)} active</span>} />
        <StatCard label="With white-label" value={fmtNum(tenants.filter((t) => t.whiteLabel).length)} />
        <StatCard label="Traders through tenants" value={fmtNum(traders)} />
        <StatCard label="Pending applications" value={fmtNum(pending)} />
      </div>
      <TenantsPage tenants={tenants} applications={applications} />
    </>
  );
}
