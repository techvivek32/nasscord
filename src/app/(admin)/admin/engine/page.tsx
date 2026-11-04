import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { EnginePage } from "@/components/console/engine-page";

export const metadata: Metadata = { title: "Alert Engine · Console" };

export default function EngineAdminPage() {
  return (
    <>
      <PageHeader title="Alert Engine" description="TradeScope's scan parameters and published backtest, read-only. Live scan status appears once the scanner reports to this app." />
      <EnginePage />
    </>
  );
}
