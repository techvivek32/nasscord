import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { RealityCheck } from "@/components/terminal/reality-check";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Analysis" };

export default function Page() {
  return (
    <>
      <PageHeader title="Analysis" description="Your equity curve and daily P&L will appear here once Nasscord keeps your balance history. Below are the engine's own backtest statistics, not your account." />
      <EmptyState
        title="No account history yet"
        description="Nasscord does not store your balances over time yet, so there is no equity curve or daily P&L to chart. Recent executions are under History."
        action={
          <Button variant="outline" size="sm" render={<Link href="/app/history" />}>
            Open History
          </Button>
        }
      />
      <RealityCheck />
    </>
  );
}
