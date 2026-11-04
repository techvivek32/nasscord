import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TenantOverview } from "@/components/tenant/overview";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal, referralLink } from "@/components/tenant/scope";
import { listTenantMembers, listTenantWorkspaces } from "@/lib/server/tenant";

export const metadata: Metadata = { title: "Overview · Tenant portal" };

export default async function TenantOverviewPage() {
  const { session, tenant } = await loadPortal();
  const header = <PageHeader title="Overview" description="The traders who came through your code, your commission rate and your referral link." />;
  if (!tenant) {
    return (
      <>
        {header}
        <NoTenant session={session} />
      </>
    );
  }
  const [workspaces, members, link] = await Promise.all([listTenantWorkspaces(tenant.id), listTenantMembers(tenant.id), referralLink(tenant)]);
  return (
    <>
      {header}
      <TenantOverview tenant={tenant} workspaces={workspaces} members={members} link={link} />
    </>
  );
}
