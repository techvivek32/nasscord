import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Options" };

export default function Page() {
  return (
    <>
      <PageHeader title="Options" description="Call ideas on TradeScope alerts, sized against your net liquidation, once TradeScope and an option-chain feed are connected." />
      <EmptyState
        title="No option ideas yet"
        description="Option ideas are built from TradeScope alerts and live option chains. Neither is connected to this workspace yet, so there is nothing to show."
        action={
          <Button variant="outline" size="sm" render={<Link href="/app/positions" />}>
            See your positions
          </Button>
        }
      />
    </>
  );
}
