import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Watchlist } from "@/components/terminal/watchlist";

export const metadata: Metadata = { title: "Watchlist" };

export default function Page() {
  return (
    <>
      <PageHeader title="Watchlist" description="Symbols you follow, saved in this browser, with what you hold in them at your brokers." />
      <Watchlist />
    </>
  );
}
