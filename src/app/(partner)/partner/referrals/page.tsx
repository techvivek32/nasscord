import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { ReferralsPage } from "@/components/partner/referrals";

export const metadata: Metadata = { title: "Referrals · Partners" };

export default function PartnerReferralsPage() {
  return (
    <>
      <PageHeader title="Referrals" description="Clicks, signups, trials and paid conversions by referral code." actions={<DemoFlag />} />
      <ReferralsPage />
    </>
  );
}
