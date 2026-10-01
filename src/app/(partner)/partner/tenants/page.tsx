import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { TenantsPage } from "@/components/partner/tenants";

export const metadata: Metadata = { title: "Tenants · Partners" };

export default function PartnerTenantsPage() {
  return (
    <>
      <PageHeader title="Tenants" description="Branded workspaces running under your white-label agreement." actions={<DemoFlag />} />
      <TenantsPage />
    </>
  );
}
