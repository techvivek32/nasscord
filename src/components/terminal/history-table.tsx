"use client";

import * as React from "react";
import { ArchiveIcon } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useExecutions } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Pnl } from "@/components/pnl";
import { StatCard } from "@/components/stat-card";
import { TONE_BADGE } from "@/components/status-dot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getBroker } from "@/lib/brokers";
import { DEMO_NOW } from "@/lib/demo-clock";
import { clsxNum, etDayKey, fmtMoney, fmtNum, fmtPrice, fmtTimeET } from "@/lib/format";
import type { Execution } from "@/lib/types";
import { useAccountScope } from "@/components/terminal/hooks";
import { StatRowSkeleton, TableSkeleton } from "@/components/terminal/skeletons";

type Range = "today" | "7d" | "30d" | "all";

function etDayLabel(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function HistoryTable() {
  const { data, isLoading } = useExecutions();
  const scope = useAccountScope();
  const [range, setRange] = React.useState<Range>("7d");

  const rows = React.useMemo(() => {
    // Ranges are measured from the demo clock: the executions are pinned to it, so the wall clock would empty "Today" and "7d" a day later.
    const todayKey = etDayKey(DEMO_NOW.toISOString());
    const cutoff = range === "7d" ? DEMO_NOW.getTime() - 7 * 86_400_000 : range === "30d" ? DEMO_NOW.getTime() - 30 * 86_400_000 : 0;
    return (data ?? [])
      .filter((e) => scope.inScope(e.accountId))
      .filter((e) => (range === "today" ? etDayKey(e.tradedAt) === todayKey : range === "all" ? true : new Date(e.tradedAt).getTime() >= cutoff))
      .sort((a, b) => b.tradedAt.localeCompare(a.tradedAt));
  }, [data, scope, range]);

  const totals = rows.reduce((t, e) => ({ net: t.net + e.net, comm: t.comm + e.commission, prov: t.prov + (e.provisional ? 1 : 0) }), { net: 0, comm: 0, prov: 0 });

  const columns = React.useMemo<ColumnDef<Execution>[]>(
    () => [
      {
        id: "day",
        header: "ET day",
        accessorFn: (e) => etDayKey(e.tradedAt),
        cell: ({ getValue }) => <span className="text-xs">{etDayLabel(getValue<string>())}</span>,
      },
      { accessorKey: "tradedAt", header: "Time", cell: ({ getValue }) => <span className="font-mono text-xs">{fmtTimeET(getValue<string>(), { second: "2-digit" })}</span> },
      {
        id: "broker",
        header: "Broker",
        accessorFn: (e) => getBroker(e.brokerId).short,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <BrokerMark id={row.original.brokerId} size="sm" />
            <span className="text-xs">{getBroker(row.original.brokerId).short}</span>
          </span>
        ),
      },
      { accessorKey: "symbol", header: "Symbol", cell: ({ getValue }) => <span className="font-mono font-semibold">{getValue<string>()}</span> },
      {
        accessorKey: "side",
        header: "Side",
        cell: ({ getValue }) => {
          const side = getValue<Execution["side"]>();
          return (
            <Badge variant="secondary" className={`font-mono tracking-wide ${side === "BUY" ? TONE_BADGE.good : TONE_BADGE.bad}`}>
              {side}
            </Badge>
          );
        },
      },
      { accessorKey: "qty", header: "Qty", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtNum(getValue<number>())}</span> },
      { accessorKey: "price", header: "Price", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtPrice(getValue<number>())}</span> },
      { accessorKey: "commission", header: "Commission", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono text-muted-foreground">{fmtMoney(getValue<number>())}</span> },
      { accessorKey: "net", header: "Net", meta: { align: "right" }, cell: ({ getValue }) => <Pnl value={getValue<number>()} /> },
      {
        id: "flags",
        header: "",
        enableSorting: false,
        accessorFn: (e) => (e.provisional ? "provisional" : ""),
        cell: ({ row }) =>
          row.original.provisional ? (
            <Badge variant="secondary" className={TONE_BADGE.warn} title="Reported by the terminal; the broker statement has not confirmed it yet">
              Provisional
            </Badge>
          ) : null,
      },
    ],
    [],
  );

  if (isLoading || scope.isLoading) {
    return (
      <>
        <StatRowSkeleton count={3} />
        <TableSkeleton rows={8} />
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Executions" value={rows.length} delta={totals.prov > 0 ? `${totals.prov} provisional` : "all confirmed"} />
        <StatCard label="Net cash flow" value={<span className={clsxNum(totals.net)}>{fmtMoney(totals.net, { sign: true })}</span>} delta="buys negative, sells positive" />
        <StatCard label="Commissions" value={fmtMoney(totals.comm)} delta={rows.length ? `${fmtMoney(totals.comm / rows.length)} per fill` : "no fills"} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup value={[range]} onValueChange={(v) => v[0] && setRange(v[0] as Range)} variant="outline" size="sm" spacing={0} aria-label="Date range">
          <ToggleGroupItem value="today">Today</ToggleGroupItem>
          <ToggleGroupItem value="7d">7d</ToggleGroupItem>
          <ToggleGroupItem value="30d">30d</ToggleGroupItem>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={range === "today" ? "No fills today" : "No executions in this range"} description="Fills arrive here seconds after the broker reports them and are reconciled against the statement overnight." />
      ) : (
        <DataTable columns={columns} data={rows} searchPlaceholder="Search symbol or broker" pageSize={15} />
      )}

      <Alert>
        <ArchiveIcon />
        <AlertTitle>Archive and provisional fills</AlertTitle>
        <AlertDescription>
          Brokers keep 30 to 90 days of executions in their APIs. Nasscord stores every fill it sees, so this history keeps growing past the broker window. A fill is Provisional until the overnight statement reconciliation
          confirms quantity, price and commission; a mismatch shows up as a correction, never a silent edit.
        </AlertDescription>
      </Alert>
    </>
  );
}
