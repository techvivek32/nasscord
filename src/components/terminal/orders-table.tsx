"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getBroker } from "@/lib/brokers";
import { fmtDateTime, fmtNum, fmtPrice, fmtTimeET, etDayKey } from "@/lib/format";
import type { Order } from "@/lib/types";
import { OrderStatusBadge, SideBadge } from "@/components/terminal/badges";
import { BrokerErrors, brokerGate, BrokerGateState } from "@/components/terminal/broker-health";
import { useAccountScope, useMinuteClock, useScopedOrders } from "@/components/terminal/hooks";
import { TableSkeleton } from "@/components/terminal/skeletons";

type Tab = "working" | "filled" | "all";

const WORKING = new Set<Order["status"]>(["submitted", "verifying", "working", "verified"]);

function priceLabel(o: Order) {
  if (o.type === "MKT") return "MKT";
  if (o.type === "TRAIL") return o.trailPct !== undefined ? `${o.trailPct.toFixed(1)}%` : "trail";
  return o.price !== undefined ? fmtPrice(o.price) : "";
}

/** Time today, date and time on earlier days (Eastern). */
function placedLabel(iso: string, todayKey: string | null) {
  return todayKey !== null && etDayKey(iso) === todayKey ? fmtTimeET(iso) : fmtDateTime(iso);
}

/** /app/orders: the brokers' order books for the included accounts in scope. Read only: no cancel in this release. */
export function OrdersTable() {
  const scope = useAccountScope();
  const { rows: orders, errors, error, stale, coverage, isLoading } = useScopedOrders();
  const [tab, setTab] = React.useState<Tab>("working");
  const clock = useMinuteClock();
  const todayKey = clock ? etDayKey(clock.toISOString()) : null;

  const working = orders.filter((o) => WORKING.has(o.status));
  const filled = orders.filter((o) => o.status === "filled");

  const columns = React.useMemo<ColumnDef<Order>[]>(
    () => [
      { accessorKey: "placedAt", header: "Placed", cell: ({ getValue }) => <span className="font-mono text-xs whitespace-nowrap">{placedLabel(getValue<string>(), todayKey)}</span> },
      {
        id: "broker",
        header: "Account",
        accessorFn: (o) => `${getBroker(o.brokerId).short} ${scope.accounts.find((a) => a.id === o.accountId)?.masked ?? ""}`,
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
      {
        accessorKey: "symbol",
        header: "Symbol",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono font-semibold">{row.original.symbol}</span>
            {row.original.parentId ? <span className="text-[10px] text-muted-foreground uppercase">bracket</span> : null}
            {row.original.outsideRth ? <span className="text-[10px] text-muted-foreground uppercase">ext</span> : null}
          </span>
        ),
      },
      { accessorKey: "side", header: "Side", cell: ({ getValue }) => <SideBadge side={getValue<Order["side"]>()} /> },
      {
        accessorKey: "qty",
        header: "Qty",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="font-mono">
            {row.original.filledQty !== undefined && row.original.filledQty !== row.original.qty ? `${fmtNum(row.original.filledQty)}/` : ""}
            {fmtNum(row.original.qty)}
          </span>
        ),
      },
      { accessorKey: "type", header: "Type", cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span> },
      {
        id: "price",
        header: "Price",
        meta: { align: "right" },
        accessorFn: (o) => o.avgFill ?? o.price ?? 0,
        cell: ({ row }) => (
          <span className="font-mono">
            {priceLabel(row.original)}
            {row.original.avgFill !== undefined ? <span className="ml-1 text-xs text-muted-foreground">fill {fmtPrice(row.original.avgFill)}</span> : null}
          </span>
        ),
      },
      { accessorKey: "tif", header: "TIF", cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span> },
      { accessorKey: "status", header: "Status", cell: ({ getValue }) => <OrderStatusBadge status={getValue<Order["status"]>()} /> },
      { accessorKey: "brokerRef", header: "Broker ref", cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue<string | undefined>() ?? ""}</span> },
    ],
    [scope.accounts, todayKey],
  );

  const gate = brokerGate(scope);
  if (gate === "loading" || (isLoading && orders.length === 0)) return <TableSkeleton rows={8} />;
  if (gate) return <BrokerGateState gate={gate} scope={scope} />;

  const footnote = <p className="text-xs text-muted-foreground">Order entry is switched off in this release, so orders cannot be placed or cancelled from Nasscord. Use your broker&apos;s app for now.</p>;
  const alerts = <BrokerErrors errors={errors} error={error} stale={stale} connections={scope.connections} />;
  // Nothing was read: no counts and no "no orders", only the reasons.
  if (coverage === "none") {
    return (
      <>
        {alerts}
        {footnote}
      </>
    );
  }

  const partial = coverage === "partial";
  const table = (rows: Order[], empty: string) =>
    rows.length === 0 ? (
      <EmptyState
        title={partial ? `${empty} in the accounts that answered` : empty}
        description={partial ? "The connections listed above could not be read, so they may still have orders." : "Orders you place in your broker's app show up here on the next refresh, every 10 seconds."}
      />
    ) : (
      <DataTable columns={columns} data={rows} searchPlaceholder="Search symbol, ref or status" pageSize={15} />
    );

  return (
    <>
      {alerts}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="working">Working ({working.length})</TabsTrigger>
          <TabsTrigger value="filled">Filled ({filled.length})</TabsTrigger>
          <TabsTrigger value="all">All ({orders.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="working">{table(working, "No working orders")}</TabsContent>
        <TabsContent value="filled">{table(filled, "No filled orders")}</TabsContent>
        <TabsContent value="all">{table(orders, "No orders")}</TabsContent>
      </Tabs>
      {partial ? <p className="text-xs text-muted-foreground">The counts cover the accounts that answered.</p> : null}
      {footnote}
    </>
  );
}
