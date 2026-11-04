import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/page-header";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal } from "@/components/tenant/scope";

export const metadata: Metadata = { title: "Plans · Tenant portal" };

export default async function TenantPlansPage() {
  const { session, tenant } = await loadPortal();
  return (
    <>
      <PageHeader title="Plans" description="The plans and prices your traders see." />
      {tenant ? (
        <EmptyState title="Custom plans are not available yet" description="Your traders see Nasscord's standard plans. Setting your own plans and prices needs billing, which is not connected yet." />
      ) : (
        <NoTenant session={session} />
      )}
    </>
  );
}
