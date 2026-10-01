import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { PositionsTable } from "@/components/terminal/positions-table";

export const metadata: Metadata = { title: "Positions" };

export default function Page() {
  return (
    <>
      <PageHeader title="Positions" description="Every open position across the accounts in scope, with the alert that opened it. Closing cancels working orders first, then sells at market." actions={<DemoFlag />} />
      <PositionsTable />
    </>
  );
}
