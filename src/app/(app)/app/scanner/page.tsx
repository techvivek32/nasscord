import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/page-header";
import { ENGINE_DEFAULTS } from "@/lib/engine";

export const metadata: Metadata = { title: "Scanner" };

export default function Page() {
  return (
    <>
      <PageHeader title="Scanner" description={`The TradeScope filters over the ${ENGINE_DEFAULTS.universeSize}-symbol universe on ${ENGINE_DEFAULTS.timeframe} bars, once Nasscord has a market data feed.`} />
      <EmptyState title="The scanner is not available yet" description="Scanning needs live bars for every symbol, and Nasscord has no market data feed yet. No indicator values are shown until it does." />
    </>
  );
}
