import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { AlertsPage } from "@/components/terminal/alerts-page";
import { ENGINE_DEFAULTS } from "@/lib/engine";

export const metadata: Metadata = { title: "Alerts" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Alerts"
        description={`TradeScope watches ${ENGINE_DEFAULTS.universeSize} symbols on ${ENGINE_DEFAULTS.timeframe} bars and publishes setups scoring ${ENGINE_DEFAULTS.minScore} or higher, up to ${ENGINE_DEFAULTS.maxOpen} open at once.`}
        actions={<DemoFlag />}
      />
      <AlertsPage />
    </>
  );
}
