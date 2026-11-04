import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Overview } from "@/components/console/overview";
import { getBrokerServiceStatus, platformCounts } from "@/lib/server/console";
import { listRecentWorkspaces } from "@/lib/server/console-extra";

export const metadata: Metadata = { title: "Overview · Console" };

export default async function ConsoleOverviewPage() {
  const [counts, service, recent] = await Promise.all([platformCounts(), getBrokerServiceStatus(), listRecentWorkspaces(6)]);
  const checkedAt = new Date().toISOString();
  return (
    <>
      <PageHeader title="Overview" description="Traders, tenants, members and broker connections across the platform, read from the database when the page loads." />
      <Overview counts={counts} service={service} recent={recent} checkedAt={checkedAt} />
    </>
  );
}
