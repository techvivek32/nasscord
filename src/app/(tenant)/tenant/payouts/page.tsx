import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { PayoutsPage } from "@/components/tenant/payouts";

export const metadata: Metadata = { title: "Payouts · Tenant portal" };

export default function TenantPayoutsPage() {
  return (
    <>
      <PageHeader title="Payouts" description="Monthly commission statements, the account they are sent to and when." actions={<DemoFlag />} />
      <PayoutsPage />
    </>
  );
}
