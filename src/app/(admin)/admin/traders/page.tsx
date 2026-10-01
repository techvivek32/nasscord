import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TradersTable } from "@/components/console/traders-table";

export const metadata: Metadata = { title: "Traders · Console" };

export default function TradersPage() {
  return (
    <>
      <PageHeader title="Traders" description="Every trading workspace, organic or through a tenant. Click a row to change limits, flags and billing." />
      <TradersTable />
    </>
  );
}
