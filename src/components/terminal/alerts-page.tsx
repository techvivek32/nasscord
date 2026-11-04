"use client";

import { EmptyState } from "@/components/page-header";
import { BrokerHealthCard, ConnectionsError, NoBrokerState } from "@/components/terminal/broker-health";
import { useAccountScope } from "@/components/terminal/hooks";
import { OrderTicket } from "@/components/terminal/order-ticket";
import { RealityCheck } from "@/components/terminal/reality-check";
import { TerminalStatRow } from "@/components/terminal/stat-row";

/**
 * /app: account totals from the brokers, the TradeScope alert feed (not connected to workspaces
 * yet, so an empty state), the published backtest, the read-only order ticket for sizing, and the
 * broker sessions.
 */
export function AlertsPage({ riskPct }: { riskPct: number }) {
  const scope = useAccountScope();
  const showNoBroker = !scope.isLoading && !scope.error && scope.connections.length === 0;

  return (
    <>
      {scope.error && scope.connections.length === 0 ? <ConnectionsError scope={scope} /> : null}
      {showNoBroker ? <NoBrokerState /> : <TerminalStatRow />}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <EmptyState
            title="No alerts yet"
            description="TradeScope is not connected to this workspace yet, so no setups are published here. Nothing on this page is a signal."
          />
          <RealityCheck />
        </div>
        <aside className="flex min-w-0 flex-col gap-4">
          <OrderTicket riskPct={riskPct} />
          <BrokerHealthCard />
        </aside>
      </div>
    </>
  );
}
