import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { WhiteLabelPage } from "@/components/console/white-label-page";
import { listTenantApplications, listTenants } from "@/lib/server/console";
import { listWorkspaceRefs } from "@/lib/server/console-extra";
import { APP_DOMAIN, whiteLabelBranding } from "@/lib/branding";
import { fmtNum } from "@/lib/format";

export const metadata: Metadata = { title: "White-label · Console" };

/** The super admin's white-label switch. The console layout already limits this route to CONSOLE_ROLES. */
export default async function WhiteLabelAdminPage() {
  const [tenants, workspaces, pending] = await Promise.all([listTenants(), listWorkspaceRefs({ withTenant: true }), listTenantApplications("pending")]);
  const branded = new Set(tenants.filter((t) => whiteLabelBranding(t)).map((t) => t.id));
  const brandedWorkspaces = workspaces.filter((w) => w.tenantId && branded.has(w.tenantId));
  // The oldest workspace of each tenant (refs come oldest first), so the preview can show a real subdomain.
  const firstSlugByTenant: Record<string, string> = {};
  for (const w of workspaces) if (w.tenantId && !firstSlugByTenant[w.tenantId]) firstSlugByTenant[w.tenantId] = w.slug;

  return (
    <>
      <PageHeader title="White-label" description="Turn white-label on for a tenant and set the name, colors and domain their traders see. Only the super admin can do this." />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="White-label tenants" value={fmtNum(tenants.filter((t) => t.whiteLabel).length)} hint={<span className="text-[11px] text-muted-foreground">of {fmtNum(tenants.length)}</span>} />
        <StatCard label="Traders on a tenant brand" value={fmtNum(brandedWorkspaces.length)} hint={<span className="text-[11px] text-muted-foreground">workspaces</span>} />
        <StatCard label="Custom domains" value={fmtNum(tenants.filter((t) => whiteLabelBranding(t)?.domain).length)} />
        <StatCard label="Applications asking for it" value={fmtNum(pending.filter((a) => a.wantsWhiteLabel).length)} hint={<span className="text-[11px] text-muted-foreground">pending</span>} />
      </div>
      <WhiteLabelPage tenants={tenants} appDomain={APP_DOMAIN} firstSlugByTenant={firstSlugByTenant} />
    </>
  );
}
