import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { PayoutsPage } from "@/components/partner/payouts";

export const metadata: Metadata = { title: "Payouts · Partners" };

export default function PartnerPayoutsPage() {
  return (
    <>
      <PageHeader title="Payouts" description="Monthly commission statements, the account they are sent to and when." actions={<DemoFlag />} />
      <PayoutsPage />
    </>
  );
}
