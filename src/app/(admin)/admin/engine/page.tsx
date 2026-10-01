import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { EnginePage } from "@/components/console/engine-page";

export const metadata: Metadata = { title: "Alert Engine · Console" };

export default function EngineAdminPage() {
  return (
    <>
      <PageHeader title="Alert Engine" description="TradeScope scan parameters, live status and the backtest that keeps the marketing honest." />
      <EnginePage />
    </>
  );
}
