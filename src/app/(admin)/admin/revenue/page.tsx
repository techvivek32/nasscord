import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Revenue · Console" };

export default function RevenueAdminPage() {
  return (
    <>
      <PageHeader title="Revenue" description="Recurring revenue, churn and how revenue splits across plans and tenants." />
      <EmptyState
        title="Stripe is not connected yet"
        description="Revenue needs billing data, so there is no MRR, churn or revenue by plan to show. Plans and workspace counts are on Plans & Billing."
        action={
          <Button variant="outline" size="sm" render={<Link href="/admin/billing" />}>
            Open Plans & Billing
          </Button>
        }
      />
    </>
  );
}
