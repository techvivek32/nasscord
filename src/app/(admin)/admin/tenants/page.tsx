import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TenantsTable } from "@/components/console/tenants-table";

export const metadata: Metadata = { title: "Tenants · Console" };

export default function TenantsPage() {
  return (
    <>
      <PageHeader title="Tenants" description="Every workspace on the platform. Click a row to edit branding, limits, flags and billing." />
      <TenantsTable />
    </>
  );
}
