"use client";

import * as React from "react";
import { toast } from "sonner";
import { RadarIcon } from "lucide-react";
import { useAlerts } from "@/hooks/queries";
import { EmptyState } from "@/components/page-header";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { fmtTimeET } from "@/lib/format";
import type { Alert } from "@/lib/types";
import { AlertCard } from "@/components/terminal/alert-card";
import { AlertDetailsSheet } from "@/components/terminal/alert-details-sheet";
import { BrokerHealthCard } from "@/components/terminal/broker-health";
import { useAccountScope, usePaperMode, useScopedPositions } from "@/components/terminal/hooks";
import { OrderTicket } from "@/components/terminal/order-ticket";
import { RealityCheck } from "@/components/terminal/reality-check";
import { AlertCardSkeleton } from "@/components/terminal/skeletons";
import { TerminalStatRow } from "@/components/terminal/stat-row";
import { useTerminalStore } from "@/components/terminal/store";

type Filter = "all" | "90" | "held";

export function AlertsPage() {
  const { data, isLoading } = useAlerts();
  const { positions } = useScopedPositions();
  const scope = useAccountScope();
  const { paperMode } = usePaperMode();
  const loadTicketFromAlert = useTerminalStore((s) => s.loadTicketFromAlert);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [details, setDetails] = React.useState<Alert | null>(null);

  const heldSymbols = React.useMemo(() => new Set(positions.map((p) => p.symbol)), [positions]);
  const open = data?.open ?? [];
  const visible = open.filter((a) => (filter === "90" ? a.score >= 90 : filter === "held" ? heldSymbols.has(a.symbol) : true));

  const onBuy = (alert: Alert) => {
    const pool = paperMode ? scope.included.filter((a) => a.type === "paper") : scope.scoped.filter((a) => a.type !== "paper");
    const preferred = pool.sort((a, b) => b.netLiq - a.netLiq)[0];
    loadTicketFromAlert(alert, preferred?.id);
    toast(`Ticket loaded: ${alert.symbol}`, { description: `Entry ${alert.entry.toFixed(2)} · stop ${alert.stop.toFixed(2)} · target ${alert.target.toFixed(2)}${preferred ? ` · ${preferred.label} ${preferred.masked}` : ""}` });
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      document.getElementById("order-ticket")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <>
      <TerminalStatRow />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RadarIcon className="size-3.5 text-primary" aria-hidden="true" />
              TradeScope · {ENGINE_DEFAULTS.timeframe} · {data?.scanned ?? ENGINE_DEFAULTS.universeSize} symbols · min score {data?.minScore ?? ENGINE_DEFAULTS.minScore}
              {data ? <span> · last scan {fmtTimeET(data.scannedAt)}</span> : null}
            </p>
            <ToggleGroup value={[filter]} onValueChange={(v) => v[0] && setFilter(v[0] as Filter)} variant="outline" size="sm" spacing={0} aria-label="Filter alerts">
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="90">Score 90+</ToggleGroupItem>
              <ToggleGroupItem value="held">Held</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {isLoading ? (
            <div className="grid gap-3">
              <AlertCardSkeleton />
              <AlertCardSkeleton />
              <AlertCardSkeleton />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              title={filter === "all" ? "No open alerts" : filter === "90" ? "Nothing scoring 90 or higher" : "No alerts on symbols you hold"}
              description={filter === "all" ? "The scanner runs every 15 minutes during market hours and only publishes setups at or above the minimum score." : "Widen the filter to see every open alert."}
            />
          ) : (
            <div className="grid gap-3">
              {visible.map((a) => (
                <AlertCard key={a.id} alert={a} held={heldSymbols.has(a.symbol)} onBuy={onBuy} onDetails={setDetails} />
              ))}
            </div>
          )}

          <RealityCheck />
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          <OrderTicket />
          <BrokerHealthCard />
        </aside>
      </div>

      <AlertDetailsSheet alert={details} history={(data?.closed ?? []).filter((c) => c.symbol === details?.symbol)} open={details !== null} onOpenChange={(o) => !o && setDetails(null)} onBuy={onBuy} />
    </>
  );
}
