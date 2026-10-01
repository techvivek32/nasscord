import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TenantsPage } from "@/components/console/tenants-page";
import { COMMISSION_PCT } from "@/lib/plans";

export const metadata: Metadata = { title: "Tenants · Console" };

export default function TenantsAdminPage() {
  return (
    <>
      <PageHeader title="Tenants" description={`Distributors who bring traders and earn ${COMMISSION_PCT}% commission: their applications and monthly payouts.`} />
      <TenantsPage />
    </>
  );
}
