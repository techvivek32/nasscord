import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { AnalysisCharts } from "@/components/terminal/analysis-charts";

export const metadata: Metadata = { title: "Analysis" };

export default function Page() {
  return (
    <>
      <PageHeader title="Analysis" description="Combined equity and daily P&L across included accounts, next to the engine's measured statistics." actions={<DemoFlag />} />
      <AnalysisCharts />
    </>
  );
}
