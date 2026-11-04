import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { HealthPage } from "@/components/console/health-page";
import { getBrokerServiceStatus } from "@/lib/server/console";
import { checkDatabase } from "@/lib/server/console-extra";

export const metadata: Metadata = { title: "System Health · Console" };

export default async function HealthAdminPage() {
  const [database, service] = await Promise.all([checkDatabase(), getBrokerServiceStatus()]);
  const checkedAt = new Date().toISOString();
  return (
    <>
      <PageHeader title="System Health" description="Whether the database and the broker service answer, checked when this page loads. Reload to check again." />
      <HealthPage database={database} service={service} checkedAt={checkedAt} />
    </>
  );
}
