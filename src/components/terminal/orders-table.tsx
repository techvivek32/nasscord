"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getBroker } from "@/lib/brokers";
import { fmtNum, fmtPrice, fmtTimeET } from "@/lib/format";
import type { Order } from "@/lib/types";
import { OrderStatusBadge, SideBadge } from "@/components/terminal/badges";
import { useMergedOrders } from "@/components/terminal/hooks";
import { TableSkeleton } from "@/components/terminal/skeletons";
import { useTerminalStore } from "@/components/terminal/store";

type Tab = "working" | "filled" | "all";

const WORKING = new Set<Order["status"]>(["submitted", "verifying", "working", "verified"]);

function priceLabel(o: Order) {
  if (o.type === "MKT") return "MKT";
  if (o.type === "TRAIL") return o.trailPct !== undefined ? `${o.trailPct.toFixed(1)}%` : "trail";
  return o.price !== undefined ? fmtPrice(o.price) : "";
}

export function OrdersTable() {
  const { orders, isLoading } = useMergedOrders();
  const cancelOrder = useTerminalStore((s) => s.cancelOrder);
  const [tab, setTab] = React.useState<Tab>("working");
  const [cancelling, setCancelling] = React.useState<Order | null>(null);

  const working = orders.filter((o) => WORKING.has(o.status));
  const filled = orders.filter((o) => o.status === "filled");

  const columns = React.useMemo<ColumnDef<Order>[]>(
    () => [
      { accessorKey: "placedAt", header: "Time", cell: ({ getValue }) => <span className="font-mono text-xs">{fmtTimeET(getValue<string>())}</span> },
      {
        id: "broker",
        header: "Broker",
        accessorFn: (o) => getBroker(o.brokerId).short,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <BrokerMark id={row.original.brokerId} size="sm" />
            <span className="text-xs">{getBroker(row.original.brokerId).short}</span>
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
            {row.original.filledQty !== undefined && row.original.filledQty !== row.original.qty ? `${row.original.filledQty}/` : ""}
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
      { accessorKey: "brokerRef", header: "Broker ref", cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue<string | undefined>() ?? "pending"}</span> },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) =>
          WORKING.has(row.original.status) && row.original.status !== "submitted" && row.original.status !== "verifying" ? (
            <Button variant="ghost" size="sm" onClick={() => setCancelling(row.original)}>
              Cancel
            </Button>
          ) : null,
      },
    ],
    [],
  );

  const confirmCancel = () => {
    if (!cancelling) return;
    // A parent takes its working bracket legs with it; a single leg leaves the other one working.
    const legs = orders.filter((o) => o.parentId === cancelling.id && WORKING.has(o.status));
    cancelOrder(cancelling.id);
    legs.forEach((o) => cancelOrder(o.id));
    toast.success(`Cancelled ${cancelling.side} ${cancelling.qty} ${cancelling.symbol}`, {
      description: `${getBroker(cancelling.brokerId).short} confirmed the cancel${cancelling.brokerRef ? ` for #${cancelling.brokerRef}` : ""}${legs.length ? ` and ${legs.length} bracket ${legs.length === 1 ? "leg" : "legs"}` : ""}.`,
    });
    setCancelling(null);
  };

  if (isLoading) return <TableSkeleton rows={8} />;

  const table = (rows: Order[], empty: string) =>
    rows.length === 0 ? <EmptyState title={empty} description="Orders you place from the ticket appear here the moment they are sent, then move to Verified once the broker order book confirms them." /> : <DataTable columns={columns} data={rows} searchPlaceholder="Search symbol, ref or status" pageSize={12} />;

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="working">Working ({working.length})</TabsTrigger>
          <TabsTrigger value="filled">Filled ({filled.length})</TabsTrigger>
          <TabsTrigger value="all">All ({orders.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="working">{table(working, "No working orders")}</TabsContent>
        <TabsContent value="filled">{table(filled, "No fills yet today")}</TabsContent>
        <TabsContent value="all">{table(orders, "No orders in scope")}</TabsContent>
      </Tabs>

      <Dialog open={cancelling !== null} onOpenChange={(o) => !o && setCancelling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this order?</DialogTitle>
            <DialogDescription>
              {cancelling ? (
                <>
                  <span className="font-mono text-foreground">
                    {cancelling.side} {cancelling.qty} {cancelling.symbol} {cancelling.type} {priceLabel(cancelling)}
                  </span>{" "}
                  at {getBroker(cancelling.brokerId).short}. {cancelling.parentId ? "The other leg of the bracket stays working." : "Attached bracket legs are cancelled with it."}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelling(null)}>
              Keep order
            </Button>
            <Button variant="destructive" onClick={confirmCancel}>
              Cancel order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
