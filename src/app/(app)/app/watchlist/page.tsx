import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { Watchlist } from "@/components/terminal/watchlist";

export const metadata: Metadata = { title: "Watchlist" };

export default function Page() {
  return (
    <>
      <PageHeader title="Watchlist" description="Symbols you follow, with today's move and whether TradeScope has an alert on them. Saved on this device." actions={<DemoFlag />} />
      <Watchlist />
    </>
  );
}
