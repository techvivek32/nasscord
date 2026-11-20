"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { fmtAmount } from "@/components/brokers/money";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Pnl } from "@/components/pnl";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "sonner";
import { ChevronDownIcon } from "lucide-react";
import { getBroker } from "@/lib/brokers";
import { clsxNum, fmtMoney, fmtNum, fmtPrice } from "@/lib/format";
import { ORDER_COPY } from "@/lib/order-entry";
import { isStockPosition, prefillFromPosition } from "@/lib/order-ticket";
import type { BrokerId, Position } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BrokerErrors, brokerGate, BrokerGateState } from "@/components/terminal/broker-health";
import { useAccountScope, useScopedPositions } from "@/components/terminal/hooks";
import { UnconfirmedOrders, useOrderEntry } from "@/components/terminal/order-entry";
import { StatRowSkeleton, TableSkeleton } from "@/components/terminal/skeletons";

type Row = Position & { masked: string; value?: number; unrealized?: number };

const NA = <span className="text-xs text-muted-foreground">n/a</span>;


/** Pnl for USD; a position in another currency keeps its own currency code instead of a "$". */
function SignedAmount({ value, currency }: { value: number; currency?: string }) {
  if (!currency || currency.toUpperCase() === "USD") return <Pnl value={value} />;
  return <span className={cn("font-medium tabular", value > 0 ? "text-gain-foreground" : value < 0 ? "text-loss-foreground" : "text-muted-foreground")}>{fmtAmount(value, currency, { sign: true })}</span>;
}

function sum(values: Array<number | undefined>) {
  const v = values.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
}

/** The "Trade" menu of a stock or ETF row: Buy (Buy to cover on a short), Sell (a long only) and Close. */
function TradeMenu({ row, onAction }: { row: Row; onAction: (row: Row, action: "buy" | "sell" | "close") => void }) {
  const broker = getBroker(row.brokerId).short;
  const fractional = !Number.isInteger(row.qty);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="xs" variant="outline" aria-label={`Trade ${row.symbol}`} />}>
        Trade
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onAction(row, "buy")}>{row.qty < 0 ? "Buy to cover" : "Buy"}</DropdownMenuItem>
          {row.qty > 0 ? <DropdownMenuItem onClick={() => onAction(row, "sell")}>Sell</DropdownMenuItem> : null}
          {fractional ? (
            <DropdownMenuItem disabled title={`Close fractional positions in ${broker}`}>
              Close fractional positions in {broker}
            </DropdownMenuItem>
          ) : row.qty !== 0 ? (
            <DropdownMenuItem onClick={() => onAction(row, "close")}>Close</DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** /app/positions: open positions of the included accounts in scope, as the brokers report them, with Buy, Sell and Close where order entry is on. */
export function PositionsTable() {
  const scope = useAccountScope();
  const { rows: positions, errors, error, stale, coverage, isLoading } = useScopedPositions();
  const oe = useOrderEntry();
  const [broker, setBroker] = React.useState<"all" | BrokerId>("all");
  // Accounts this user can trade: only while order entry is on.
  const tradableKey = oe.state === "on" ? oe.tradable.map((a) => a.id).join(",") : "";
  const tradable = React.useMemo(() => new Set(tradableKey ? tradableKey.split(",") : []), [tradableKey]);
  const openTicket = oe.open;
  const onAction = React.useCallback(
    (row: Row, action: "buy" | "sell" | "close") => {
      const draft = prefillFromPosition(row, action, { now: new Date(), broker: getBroker(row.brokerId).short });
      if ("error" in draft) {
        toast.error(draft.error);
        return;
      }
      openTicket(draft);
    },
    [openTicket],
  );

  const brokers = React.useMemo(() => Array.from(new Set(positions.map((p) => p.brokerId))), [positions]);
  const filter = broker !== "all" && brokers.includes(broker) ? broker : "all";

  const rows = React.useMemo<Row[]>(
    () =>
      positions
        .filter((p) => filter === "all" || p.brokerId === filter)
        .map((p) => ({ ...p, masked: scope.accounts.find((a) => a.id === p.accountId)?.masked ?? "", value: p.marketValue, unrealized: p.unrealizedPnl })),
    [positions, filter, scope.accounts],
  );

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "broker",
        header: "Account",
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
      {
        accessorKey: "symbol",
        header: "Symbol",
        cell: ({ row }) => (
          <span className="flex items-center gap-1.5">
            <span className="font-mono font-semibold">{row.original.symbol}</span>
            {row.original.secType && row.original.secType !== "STK" && row.original.secType !== "EQ" ? <span className="text-[10px] text-muted-foreground uppercase">{row.original.secType}</span> : null}
          </span>
        ),
      },
      { accessorKey: "qty", header: "Qty", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtNum(getValue<number>())}</span> },
      {
        accessorKey: "avgCost",
        header: "Avg cost",
        meta: { align: "right" },
        cell: ({ row }) => (row.original.avgCost !== undefined ? <span className="font-mono">{fmtPrice(row.original.avgCost)}</span> : NA),
      },
      { accessorKey: "last", header: "Last", meta: { align: "right" }, cell: ({ row }) => (row.original.last !== undefined ? <span className="font-mono">{fmtPrice(row.original.last)}</span> : NA) },
      {
        accessorKey: "value",
        header: "Market value",
        meta: { align: "right" },
        cell: ({ row }) =>
          row.original.value !== undefined ? (
            <span className="font-mono">{fmtAmount(row.original.value, row.original.currency)}</span>
          ) : (
            NA
          ),
      },
      { accessorKey: "dayPnl", header: "Day P&L", meta: { align: "right" }, cell: ({ row }) => (row.original.dayPnl !== undefined ? <SignedAmount value={row.original.dayPnl} currency={row.original.currency} /> : NA) },
      { accessorKey: "unrealized", header: "Unrealized", meta: { align: "right" }, cell: ({ row }) => (row.original.unrealized !== undefined ? <SignedAmount value={row.original.unrealized} currency={row.original.currency} /> : NA) },
      ...(tradable.size > 0
        ? [
            {
              id: "actions",
              header: "",
              meta: { align: "right" },
              enableSorting: false,
              cell: ({ row }) => (tradable.has(row.original.accountId) && isStockPosition(row.original) ? <TradeMenu row={row.original} onAction={onAction} /> : null),
            } satisfies ColumnDef<Row>,
          ]
        : []),
    ],
    [tradable, onAction],
  );

  const gate = brokerGate(scope);
  if (gate === "loading" || (isLoading && positions.length === 0)) {
    return (
      <>
        <StatRowSkeleton />
        <TableSkeleton />
      </>
    );
  }
  // A dropped session or a disconnect leaves exactly these states: unconfirmed orders stay listed (D15).
  if (gate) {
    return (
      <>
        <UnconfirmedOrders />
        <BrokerGateState gate={gate} scope={scope} />
      </>
    );
  }

  const alerts = <BrokerErrors errors={errors} error={error} stale={stale} connections={scope.connections} />;
  // Nothing was read: no counts, no sums and no "no positions", only the reasons.
  if (coverage === "none") {
    return (
      <>
        <UnconfirmedOrders />
        {alerts}
      </>
    );
  }

  const partial = coverage === "partial";
  // Only USD values are added up; a position in another currency stays in the table.
  const usd = rows.filter((r) => !r.currency || r.currency === "USD");
  const mv = sum(usd.map((r) => r.value));
  const unr = sum(usd.map((r) => r.unrealized));
  const day = scope.totals.dayPnl.value;
  const foreign = rows.length - usd.length;
  const scopeNote = (usdOnly: boolean) =>
    [partial ? "accounts that answered" : null, usdOnly && foreign > 0 ? `USD positions only, ${foreign} in other currencies` : null].filter(Boolean).join("; ") || undefined;

  return (
    <>
      {positions.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Positions" value={rows.length} delta={partial ? "accounts that answered" : `${brokers.length} ${brokers.length === 1 ? "broker" : "brokers"}`} />
          <StatCard label="Market value" value={mv !== null ? fmtMoney(mv, { digits: 0 }) : "Not reported"} delta={scopeNote(true)} />
          <StatCard label="Unrealized" value={unr !== null ? <span className={clsxNum(unr)}>{fmtMoney(unr, { sign: true, digits: 0 })}</span> : "Not reported"} delta={scopeNote(true)} />
          <StatCard
            label="Day P&L, accounts"
            value={day !== null ? <span className={clsxNum(day)}>{fmtAmount(day, scope.totals.currency, { sign: true, digits: 0 })}</span> : scope.totals.mixedCurrency ? "Mixed currencies" : "Not reported"}
            delta={scope.totals.dayPnlPct ?? undefined}
            deltaLabel={scope.totals.dayPnlPct !== null ? "% today" : undefined}
          />
        </div>
      ) : null}

      <UnconfirmedOrders />
      {alerts}

      {positions.length === 0 ? (
        <EmptyState
          title={partial ? "No open positions in the accounts that answered" : "No open positions"}
          description={partial ? "The connections listed above could not be read, so they may still hold positions." : "The included accounts in view hold no positions right now."}
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          searchPlaceholder="Search symbol or account"
          pageSize={15}
          emptyMessage="No positions at this broker."
          toolbar={
            brokers.length > 1 ? (
              <ToggleGroup value={[filter]} onValueChange={(v) => v[0] && setBroker(v[0] as "all" | BrokerId)} variant="outline" size="sm" spacing={0} aria-label="Filter by broker" className="ml-auto">
                <ToggleGroupItem value="all">All</ToggleGroupItem>
                {brokers.map((b) => (
                  <ToggleGroupItem key={b} value={b} className="gap-1.5">
                    <BrokerMark id={b} size="xs" />
                    {getBroker(b).short}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : undefined
          }
        />
      )}
      {positions.some((p) => p.brokerId === "ibkr") ? (
        <p className="text-xs text-muted-foreground">IBKR usually reports day P&L for the whole account rather than per position; an IBKR row without its own value shows n/a. The account total is in the tile above.</p>
      ) : null}
      {oe.state === "on" ? <p className="text-xs text-muted-foreground">{ORDER_COPY.readOnlyBrokers}</p> : null}
    </>
  );
}
