import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { HistoryTable } from "@/components/terminal/history-table";

export const metadata: Metadata = { title: "History" };

export default function Page() {
  return (
    <>
      <PageHeader title="History" description="Executions your brokers report for the included accounts in view, keyed to the US Eastern trading day." />
      <HistoryTable />
    </>
  );
}
