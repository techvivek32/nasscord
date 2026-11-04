import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PositionsTable } from "@/components/terminal/positions-table";

export const metadata: Metadata = { title: "Positions" };

export default function Page() {
  return (
    <>
      <PageHeader title="Positions" description="Open positions in the included accounts in view, as your brokers report them. Refreshed every 15 seconds." />
      <PositionsTable />
    </>
  );
}
