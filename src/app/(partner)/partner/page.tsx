import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { PartnerOverview } from "@/components/partner/overview";

export const metadata: Metadata = { title: "Overview · Partners" };

export default function PartnerOverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Referred accounts, attributed revenue and your next payout at a glance." actions={<DemoFlag />} />
      <PartnerOverview />
    </>
  );
}
