import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { ReferralsPage } from "@/components/tenant/referrals";

export const metadata: Metadata = { title: "Referrals · Tenant portal" };

export default function TenantReferralsPage() {
  return (
    <>
      <PageHeader title="Referrals" description="Clicks, signups, trials and paid conversions by referral code." actions={<DemoFlag />} />
      <ReferralsPage />
    </>
  );
}
