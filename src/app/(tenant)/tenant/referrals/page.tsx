import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { ReferralsPage } from "@/components/tenant/referrals";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal, referralLink } from "@/components/tenant/scope";

export const metadata: Metadata = { title: "Referrals · Tenant portal" };

export default async function TenantReferralsPage() {
  const { session, tenant } = await loadPortal();
  const header = <PageHeader title="Referrals" description="Your referral code and link, and how many traders signed up with them." />;
  if (!tenant) {
    return (
      <>
        {header}
        <NoTenant session={session} />
      </>
    );
  }
  return (
    <>
      {header}
      <ReferralsPage tenant={tenant} link={await referralLink(tenant)} traders={tenant.workspaces} />
    </>
  );
}
