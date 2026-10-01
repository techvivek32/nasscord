"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ColumnDef } from "@tanstack/react-table";
import { useAlerts } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Pnl } from "@/components/pnl";
import { StatCard } from "@/components/stat-card";
import { TONE_BADGE } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getBroker } from "@/lib/brokers";
import { clsxNum, fmtMoney, fmtNum, fmtPrice } from "@/lib/format";
import type { Alert, BrokerId, Order, Position } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountScope, useMergedOrders, useScopedPositions } from "@/components/terminal/hooks";
import { StatRowSkeleton, TableSkeleton } from "@/components/terminal/skeletons";
import { useTerminalStore } from "@/components/terminal/store";

type Row = Position & { masked: string; unrealized: number; alert?: Alert };

function alertState(p: Position, alert?: Alert): { label: string; tone: keyof typeof TONE_BADGE } | null {
  if (!alert) return null;
  if (alert.movedBE || Math.abs(p.last - alert.entry) < 0.005) return { label: "At breakeven", tone: "neutral" };
  if (p.last > alert.entry) return { label: "Above entry", tone: "good" };
  return { label: "Below entry", tone: "bad" };
}

export function PositionsTable() {
  const { positions, isLoading } = useScopedPositions();
  const scope = useAccountScope();
  const { data: alerts } = useAlerts();
  const { orders } = useMergedOrders();
  const closePosition = useTerminalStore((s) => s.closePosition);
  const cancelOrder = useTerminalStore((s) => s.cancelOrder);
  const addLocalOrders = useTerminalStore((s) => s.addLocalOrders);
  const [broker, setBroker] = React.useState<"all" | BrokerId>("all");
  const [closing, setClosing] = React.useState<Row | null>(null);
  const [busy, setBusy] = React.useState(false);

  const rows = React.useMemo<Row[]>(() => {
    const byId = new Map((alerts?.all ?? []).map((a) => [a.id, a] as const));
    return positions
      .filter((p) => broker === "all" || p.brokerId === broker)
      .map((p) => ({ ...p, masked: scope.accounts.find((a) => a.id === p.accountId)?.masked ?? "", unrealized: (p.last - p.avgCost) * p.qty, alert: p.alertId ? byId.get(p.alertId) : undefined }));
  }, [positions, broker, scope.accounts, alerts]);

  const brokers = Array.from(new Set(positions.map((p) => p.brokerId)));
  const totals = rows.reduce((t, r) => ({ mv: t.mv + r.qty * r.last, day: t.day + r.dayPnl, unr: t.unr + r.unrealized, cost: t.cost + r.qty * r.avgCost }), { mv: 0, day: 0, unr: 0, cost: 0 });

  const confirmClose = async () => {
    if (!closing) return;
    setBusy(true);
    const working = orders.filter((o) => o.symbol === closing.symbol && o.accountId === closing.accountId && (o.status === "working" || o.status === "verified"));
    const b = getBroker(closing.brokerId).short;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    if (working.length) {
      toast(`Cancelling ${working.length} working ${working.length === 1 ? "order" : "orders"} at ${b}`);
      working.forEach((o) => cancelOrder(o.id));
      await wait(600);
    }
    const ts = Date.now();
    const order: Order = {
      id: `loc_${ts}`,
      clientId: `nova-${Math.floor(ts / 1000)}-${Math.random().toString(16).slice(2, 6)}`,
      accountId: closing.accountId,
      brokerId: closing.brokerId,
      symbol: closing.symbol,
      side: "SELL",
      qty: closing.qty,
      type: "MKT",
      tif: "DAY",
      status: "verifying",
      placedAt: new Date(ts).toISOString(),
    };
    addLocalOrders([order]);
    toast(`Sent to ${b}: SELL ${closing.qty} ${closing.symbol} MKT`);
    await wait(700);
    const ref = String(Math.floor(1000 + Math.random() * 8999));
    useTerminalStore.getState().updateLocalOrder(order.id, { status: "filled", filledQty: closing.qty, avgFill: closing.last, brokerRef: ref });
    closePosition(closing.id);
    toast.success(`Closed ${closing.symbol} at ${b} · #${ref}`, { description: `${closing.qty} shares filled near ${fmtPrice(closing.last)}. Realised ${fmtMoney(closing.unrealized, { sign: true })}.` });
    setBusy(false);
    setClosing(null);
  };

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "broker",
        header: "Broker",
        accessorFn: (r) => `${getBroker(r.brokerId).short} ${r.masked}`,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <BrokerMark id={row.original.brokerId} size="sm" />
            <span className="flex flex-col leading-tight">
              <span className="text-xs font-medium">{getBroker(row.original.brokerId).short}</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular">{row.original.masked}</span>
            </span>
          </span>
        ),
      },
      { accessorKey: "symbol", header: "Symbol", cell: ({ getValue }) => <span className="font-mono font-semibold">{getValue<string>()}</span> },
      { accessorKey: "qty", header: "Qty", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtNum(getValue<number>())}</span> },
      { accessorKey: "avgCost", header: "Avg cost", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtPrice(getValue<number>())}</span> },
      { accessorKey: "last", header: "Last", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtPrice(getValue<number>())}</span> },
      { id: "mv", header: "Market value", meta: { align: "right" }, accessorFn: (r) => r.qty * r.last, cell: ({ getValue }) => <span className="font-mono">{fmtMoney(getValue<number>())}</span> },
      { accessorKey: "dayPnl", header: "Day P&L", meta: { align: "right" }, cell: ({ getValue }) => <Pnl value={getValue<number>()} /> },
      {
        accessorKey: "unrealized",
        header: "Unrealized",
        meta: { align: "right" },
        cell: ({ row }) => <Pnl value={row.original.unrealized} pct={((row.original.last - row.original.avgCost) / row.original.avgCost) * 100} />,
      },
      {
        id: "alert",
        header: "Alert",
        enableSorting: false,
        accessorFn: (r) => alertState(r, r.alert)?.label ?? "",
        cell: ({ row }) => {
          const s = alertState(row.original, row.original.alert);
          return s ? (
            <Badge variant="secondary" className={TONE_BADGE[s.tone]}>
              {s.label}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">Manual</span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => (
          <Button variant="outline" size="sm" onClick={() => setClosing(row.original)}>
            Close
          </Button>
        ),
      },
    ],
    [],
  );

  if (isLoading) {
    return (
      <>
        <StatRowSkeleton />
        <TableSkeleton />
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Positions" value={rows.length} delta={`${brokers.length} ${brokers.length === 1 ? "broker" : "brokers"}`} />
        <StatCard label="Market value" value={fmtMoney(totals.mv, { digits: 0 })} delta={`${fmtMoney(totals.cost, { digits: 0, compact: true })} cost basis`} />
        <StatCard label="Day P&L" value={<span className={clsxNum(totals.day)}>{fmtMoney(totals.day, { sign: true })}</span>} delta={totals.cost > 0 ? Math.round((totals.day / totals.cost) * 10000) / 100 : 0} deltaLabel="% of cost" />
        <StatCard label="Unrealized" value={<span className={clsxNum(totals.unr)}>{fmtMoney(totals.unr, { sign: true })}</span>} delta={totals.cost > 0 ? Math.round((totals.unr / totals.cost) * 10000) / 100 : 0} deltaLabel="% of cost" />
      </div>

      {positions.length === 0 ? (
        <EmptyState title="No open positions" description="Positions from every included account show up here as soon as a fill is confirmed in the broker order book." />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          searchPlaceholder="Search symbol or account"
          pageSize={12}
          emptyMessage="No positions at this broker."
          toolbar={
            <ToggleGroup value={[broker]} onValueChange={(v) => v[0] && setBroker(v[0] as "all" | BrokerId)} variant="outline" size="sm" spacing={0} aria-label="Filter by broker" className="ml-auto">
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              {brokers.map((b) => (
                <ToggleGroupItem key={b} value={b} className="gap-1.5">
                  <BrokerMark id={b} size="xs" />
                  {getBroker(b).short}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        />
      )}

      <Dialog open={closing !== null} onOpenChange={(o) => !o && !busy && setClosing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close {closing?.symbol}?</DialogTitle>
            <DialogDescription>
              {closing ? (
                <>
                  Cancel working orders, then <span className="font-mono text-foreground">SELL {closing.qty} {closing.symbol}</span> at market in {getBroker(closing.brokerId).short} {closing.masked}? Current unrealized{" "}
                  <span className={cn("font-mono", clsxNum(closing.unrealized))}>{fmtMoney(closing.unrealized, { sign: true })}</span>.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setClosing(null)}>
              Keep position
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void confirmClose()}>
              {busy ? "Closing…" : "Close at market"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
