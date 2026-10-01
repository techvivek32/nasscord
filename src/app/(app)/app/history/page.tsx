import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { HistoryTable } from "@/components/terminal/history-table";

export const metadata: Metadata = { title: "History" };

export default function Page() {
  return (
    <>
      <PageHeader title="History" description="Every execution across the accounts in scope, keyed to the US Eastern trading day and kept past the broker's own retention window." actions={<DemoFlag />} />
      <HistoryTable />
    </>
  );
}
