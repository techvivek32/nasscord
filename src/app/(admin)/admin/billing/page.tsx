import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { InvoicesCard, PlanCatalogCard } from "@/components/console/billing-page";
import { platformCounts } from "@/lib/server/console";

export const metadata: Metadata = { title: "Plans & Billing · Console" };

export default async function BillingPage() {
  const counts = await platformCounts();
  return (
    <>
      <PageHeader title="Plans & Billing" description="The plan catalog and how many workspaces are on each plan. Payments appear once Stripe is connected." />
      <PlanCatalogCard workspacesByPlan={counts.workspacesByPlan} />
      <InvoicesCard />
    </>
  );
}
