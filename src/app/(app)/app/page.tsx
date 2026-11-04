import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { AlertsPage } from "@/components/terminal/alerts-page";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { getMySettings } from "@/lib/server/workspace";

export const metadata: Metadata = { title: "Alerts" };

export default async function Page() {
  const settings = await getMySettings();
  return (
    <>
      <PageHeader
        title="Alerts"
        description={`Setups will come from TradeScope, which scans ${ENGINE_DEFAULTS.universeSize} symbols on ${ENGINE_DEFAULTS.timeframe} bars for scores of ${ENGINE_DEFAULTS.minScore} or higher, once it is connected to this workspace. It is not connected yet. The account totals come from your brokers.`}
      />
      <AlertsPage riskPct={settings.riskPct} />
    </>
  );
}
