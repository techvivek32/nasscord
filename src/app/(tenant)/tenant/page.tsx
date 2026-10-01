import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { TenantOverview } from "@/components/tenant/overview";

export const metadata: Metadata = { title: "Overview · Tenant portal" };

export default function TenantOverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Traders you brought, the commission they earn you and your next payout at a glance." actions={<DemoFlag />} />
      <TenantOverview />
    </>
  );
}
