import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { HealthPage } from "@/components/console/health-page";

export const metadata: Metadata = { title: "System Health · Console" };

export default function HealthAdminPage() {
  return (
    <>
      <PageHeader title="System Health" description="Service fleet, the maintenance gate and the incident timeline." />
      <HealthPage />
    </>
  );
}
