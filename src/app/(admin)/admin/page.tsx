import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Overview } from "@/components/console/overview";

export const metadata: Metadata = { title: "Overview · Console" };

export default function ConsoleOverviewPage() {
  return (
    <>
      <PageHeader title="Overview" description="Revenue, customers and broker health across the platform, refreshed every 30 seconds." />
      <Overview />
    </>
  );
}
