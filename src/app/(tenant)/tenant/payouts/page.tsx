import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/page-header";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal } from "@/components/tenant/scope";

export const metadata: Metadata = { title: "Payouts · Tenant portal" };

export default async function TenantPayoutsPage() {
  const { session, tenant } = await loadPortal();
  return (
    <>
      <PageHeader title="Payouts" description="Commission statements and payouts on your traders' subscriptions." />
      {tenant ? (
        <EmptyState title="Payouts are not connected yet" description={`Billing is not connected, so no commission has been earned or paid. Your rate is ${tenant.commissionPct}% of your traders' subscriptions.`} />
      ) : (
        <NoTenant session={session} />
      )}
    </>
  );
}
