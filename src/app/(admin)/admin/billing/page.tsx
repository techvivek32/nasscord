import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { InvoicesCard, PlanMatrixCard } from "@/components/console/billing-page";

export const metadata: Metadata = { title: "Plans & Billing · Console" };

export default function BillingPage() {
  return (
    <>
      <PageHeader title="Plans & Billing" description="Plan entitlements, list prices and this cycle's invoices. Stripe is the source of truth for payments." />
      <PlanMatrixCard />
      <InvoicesCard />
    </>
  );
}
