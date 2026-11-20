"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getBroker } from "@/lib/brokers";
import { fmtDateTime, fmtNum, fmtPrice, fmtTimeET, etDayKey } from "@/lib/format";
import { CANCELLABLE, ORDER_COPY, formatOrderPrice, isNasscordOrder } from "@/lib/order-entry";
import type { Order } from "@/lib/types";
import { OrderStatusBadge, SideBadge } from "@/components/terminal/badges";
import { BrokerErrors, brokerGate, BrokerGateState } from "@/components/terminal/broker-health";
import { CancelOrderDialog } from "@/components/terminal/cancel-order-dialog";
import { useAccountScope, useMinuteClock, useScopedOrders } from "@/components/terminal/hooks";
import { RequestOrderEntryButton, UnconfirmedOrders, useOrderEntry } from "@/components/terminal/order-entry";
import { TableSkeleton } from "@/components/terminal/skeletons";

type Tab = "working" | "filled" | "all";

/** Working tab: open at the broker, a requested cancel included (the order can still fill). */
const WORKING = new Set<Order["status"]>(["submitted", "verifying", "working", "verified", "cancel_requested"]);

function priceLabel(o: Order) {
  if (o.type === "MKT") return "MKT";
  if (o.type === "TRAIL") return o.trailPct !== undefined ? `${o.trailPct.toFixed(1)}%` : "trail";
  if (o.type === "STP_LMT") return `stop ${o.stopPrice !== undefined ? formatOrderPrice(o.stopPrice) : "?"} limit ${o.price !== undefined ? formatOrderPrice(o.price) : "?"}`;
  return o.price !== undefined ? formatOrderPrice(o.price) : "";
}

/** The off footnote: its first sentence names why order entry is not available here. */
function offFootnote(reason: string | null | undefined, message: string | null) {
  if (reason === "off" || !message) return "Order entry is not switched on for this workspace, so orders cannot be placed or cancelled from Nasscord. Use your broker's app.";
  return /broker's own app/.test(message) ? message : `${message} Use your broker's app.`;
}

/** Time today, date and time on earlier days (Eastern). */
function placedLabel(iso: string, todayKey: string | null) {
  return todayKey !== null && etDayKey(iso) === todayKey ? fmtTimeET(iso) : fmtDateTime(iso);
}

/** /app/orders: the brokers' order books for the included accounts in scope, with Cancel where order entry is on. */
export function OrdersTable() {
  const scope = useAccountScope();
  const { rows: orders, errors, error, stale, coverage, isLoading } = useScopedOrders();
  const oe = useOrderEntry();
  const [tab, setTab] = React.useState<Tab>("working");
  const [cancelling, setCancelling] = React.useState<{ order: Order; open: boolean } | null>(null);
  // Accounts this user can cancel on: only while order entry is on.
  const tradableKey = oe.state === "on" ? oe.tradable.map((a) => a.id).join(",") : "";
  const tradable = React.useMemo(() => new Set(tradableKey ? tradableKey.split(",") : []), [tradableKey]);
  const parents = React.useMemo(() => new Set(orders.map((o) => o.parentId).filter((p): p is string => !!p)), [orders]);
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
            {isNasscordOrder(row.original.clientId) ? <span className="text-[10px] tracking-wide text-muted-foreground uppercase">Nasscord</span> : null}
            {row.original.legRole === "stop_loss" ? (
              <span className="text-[10px] text-muted-foreground uppercase">stop</span>
            ) : row.original.legRole === "take_profit" ? (
              <span className="text-[10px] text-muted-foreground uppercase">target</span>
            ) : row.original.parentId ? (
              <span className="text-[10px] text-muted-foreground uppercase">bracket</span>
            ) : null}
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
      {
        id: "actions",
        header: "",
        meta: { align: "right" },
        enableSorting: false,
        cell: ({ row }) =>
          tradable.has(row.original.accountId) && CANCELLABLE.has(row.original.status) ? (
            <Button size="xs" variant="outline" onClick={() => setCancelling({ order: row.original, open: true })}>
              Cancel
            </Button>
          ) : null,
      },
    ],
    [scope.accounts, todayKey, tradable],
  );

  const footnote =
    oe.state === "loading" ? null : oe.state === "on" ? (
      <p className="text-xs text-muted-foreground">
        Orders you place or cancel here go to IBKR, E*TRADE or Alpaca (API key) after you confirm them. Change or cancel orders at other brokers in the broker&apos;s own app.
      </p>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-muted-foreground">{offFootnote(oe.caps?.reason, oe.message ?? ORDER_COPY.unavailable)}</p>
        <RequestOrderEntryButton />
      </div>
    );

  const cancelOrder = cancelling?.order ?? null;
  // One dialog at one place in the tree, whatever the table shows: a cancel in flight keeps its dialog (and its
  // outcome, cancel_unknown included) when a refresh turns the table into the skeleton, a gate or "nothing read".
  const cancelDialog = (
    <CancelOrderDialog
      order={cancelOrder}
      account={cancelOrder ? (scope.accounts.find((a) => a.id === cancelOrder.accountId) ?? null) : null}
      hasChildren={!!cancelOrder && parents.has(cancelOrder.id)}
      open={!!cancelling?.open}
      onOpenChange={(o) => setCancelling((c) => (c ? { ...c, open: o } : c))}
    />
  );
  const withDialog = (content: React.ReactNode) => (
    <>
      {content}
      {cancelDialog}
    </>
  );

  const gate = brokerGate(scope);
  if (gate === "loading" || (isLoading && orders.length === 0)) return withDialog(<TableSkeleton rows={8} />);
  // A dropped session or a disconnect leaves exactly these states: unconfirmed orders stay listed (D15).
  if (gate) {
    return withDialog(
      <>
        <UnconfirmedOrders />
        <BrokerGateState gate={gate} scope={scope} />
        {footnote}
      </>,
    );
  }

  const alerts = <BrokerErrors errors={errors} error={error} stale={stale} connections={scope.connections} />;
  // Nothing was read: no counts and no "no orders", only the reasons.
  if (coverage === "none") {
    return withDialog(
      <>
        <UnconfirmedOrders />
        {alerts}
        {footnote}
      </>,
    );
  }

  const partial = coverage === "partial";
  const table = (rows: Order[], empty: string) =>
    rows.length === 0 ? (
      <EmptyState
        title={partial ? `${empty} in the accounts that answered` : empty}
        description={
          partial
            ? "The connections listed above could not be read, so they may still have orders."
            : oe.state === "on"
              ? "Orders you place here or in your broker's app show up on the next refresh, every 10 seconds."
              : "Orders you place in your broker's app show up here on the next refresh, every 10 seconds."
        }
      />
    ) : (
      <DataTable columns={columns} data={rows} searchPlaceholder="Search symbol, ref or status" pageSize={15} />
    );

  return withDialog(
    <>
      <UnconfirmedOrders />
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
    </>,
  );
}
