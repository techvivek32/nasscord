"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Pnl } from "@/components/pnl";
import { StatCard } from "@/components/stat-card";
import { TONE_BADGE } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getBroker } from "@/lib/brokers";
import { clsxNum, etDayKey, fmtMoney, fmtNum, fmtPrice, fmtTimeET } from "@/lib/format";
import type { Execution } from "@/lib/types";
import { SideBadge } from "@/components/terminal/badges";
import { BrokerErrors, brokerGate, BrokerGateState } from "@/components/terminal/broker-health";
import { useAccountScope, useMinuteClock, useScopedExecutions } from "@/components/terminal/hooks";
import { StatRowSkeleton, TableSkeleton } from "@/components/terminal/skeletons";

type Range = "today" | "7d" | "all";

function etDayLabel(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** /app/history: executions the brokers report for the included accounts in scope, by US Eastern trading day. */
export function HistoryTable() {
  const scope = useAccountScope();
  const { rows: executions, errors, error, stale, coverage, isLoading } = useScopedExecutions();
  const [range, setRange] = React.useState<Range>("7d");

  // The real clock, once a minute (null on the server; the data only arrives in the browser anyway).
  const clock = useMinuteClock();

  const rows = React.useMemo(() => {
    const now = clock?.getTime() ?? null;
    const todayKey = now === null ? null : etDayKey(new Date(now).toISOString());
    const cutoff = now === null ? 0 : now - 7 * 86_400_000;
    return executions
      .filter((e) => (range === "today" ? etDayKey(e.tradedAt) === todayKey : range === "7d" ? new Date(e.tradedAt).getTime() >= cutoff : true))
      .sort((a, b) => b.tradedAt.localeCompare(a.tradedAt));
  }, [executions, range, clock]);

  const totals = rows.reduce((t, e) => ({ net: t.net + e.net, comm: t.comm + e.commission, prov: t.prov + (e.provisional ? 1 : 0) }), { net: 0, comm: 0, prov: 0 });

  const columns = React.useMemo<ColumnDef<Execution>[]>(
    () => [
      { id: "day", header: "ET day", accessorFn: (e) => etDayKey(e.tradedAt), cell: ({ getValue }) => <span className="text-xs whitespace-nowrap">{etDayLabel(getValue<string>())}</span> },
      { accessorKey: "tradedAt", header: "Time", cell: ({ getValue }) => <span className="font-mono text-xs">{fmtTimeET(getValue<string>(), { second: "2-digit" })}</span> },
      {
        id: "broker",
        header: "Account",
        accessorFn: (e) => `${getBroker(e.brokerId).short} ${scope.accounts.find((a) => a.id === e.accountId)?.masked ?? ""}`,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <BrokerMark id={row.original.brokerId} size="sm" />
            <span className="flex flex-col leading-tight">
              <span className="text-xs font-medium">{getBroker(row.original.brokerId).short}</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular">{scope.accounts.find((a) => a.id === row.original.accountId)?.masked ?? ""}</span>
            </span>
          </span>
        ),
      },
      { accessorKey: "symbol", header: "Symbol", cell: ({ getValue }) => <span className="font-mono font-semibold">{getValue<string>()}</span> },
      { accessorKey: "side", header: "Side", cell: ({ getValue }) => <SideBadge side={getValue<Execution["side"]>()} /> },
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
            <Badge variant="secondary" className={TONE_BADGE.warn} title="The commission is the broker's estimate until its statement confirms it">
              Provisional
            </Badge>
          ) : null,
      },
    ],
    [scope.accounts],
  );

  const gate = brokerGate(scope);
  if (gate === "loading" || (isLoading && executions.length === 0)) {
    return (
      <>
        <StatRowSkeleton count={3} />
        <TableSkeleton rows={8} />
      </>
    );
  }
  if (gate) return <BrokerGateState gate={gate} scope={scope} />;

  const footnote = (
    <p className="text-xs text-muted-foreground">
      Nasscord reads executions from the broker each time and does not keep its own archive yet. IBKR returns the last 7 days. E*TRADE executions come from filled orders and are marked Provisional, because their commission is E*TRADE&apos;s estimate.
    </p>
  );
  const alerts = <BrokerErrors errors={errors} error={error} stale={stale} connections={scope.connections} />;
  // Nothing was read: no counts, no sums and no "no fills", only the reasons.
  if (coverage === "none") {
    return (
      <>
        {alerts}
        {footnote}
      </>
    );
  }

  const partial = coverage === "partial";
  const answered = partial ? "accounts that answered" : null;

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Executions"
          value={rows.length}
          delta={answered ?? (totals.prov > 0 ? `${totals.prov} provisional` : rows.length ? "all confirmed by the broker" : "none in this range")}
        />
        <StatCard
          label="Net cash flow"
          value={rows.length ? <span className={clsxNum(totals.net)}>{fmtMoney(totals.net, { sign: true })}</span> : "No fills"}
          delta={answered ?? (rows.length ? "buys negative, sells positive" : undefined)}
        />
        <StatCard
          label="Commissions"
          value={rows.length ? fmtMoney(totals.comm) : "No fills"}
          delta={answered ?? (rows.length ? `${fmtMoney(totals.comm / rows.length)} per fill` : undefined)}
        />
      </div>

      {alerts}

      <ToggleGroup value={[range]} onValueChange={(v) => v[0] && setRange(v[0] as Range)} variant="outline" size="sm" spacing={0} aria-label="Date range" className="self-start">
        <ToggleGroupItem value="today">Today</ToggleGroupItem>
        <ToggleGroupItem value="7d">7 days</ToggleGroupItem>
        <ToggleGroupItem value="all">All returned</ToggleGroupItem>
      </ToggleGroup>

      {rows.length === 0 ? (
        <EmptyState
          title={`${range === "today" ? "No fills today" : "No executions in this range"}${partial ? " in the accounts that answered" : ""}`}
          description={partial ? "The connections listed above could not be read, so they may still have fills." : "Fills show up here once the broker reports them, on the next refresh."}
        />
      ) : (
        <DataTable columns={columns} data={rows} searchPlaceholder="Search symbol or broker" pageSize={15} />
      )}

      {footnote}
    </>
  );
}
