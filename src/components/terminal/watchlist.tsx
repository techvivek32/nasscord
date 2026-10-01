"use client";

import * as React from "react";
import { toast } from "sonner";
import { PlusIcon, XIcon } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useAlerts, useTickers } from "@/hooks/queries";
import { Sparkline } from "@/components/charts/sparkline";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { PctChange } from "@/components/pnl";
import { TONE_BADGE } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INDEX_ETFS, UNIVERSE } from "@/lib/engine";
import { fmtPrice, fmtTimeET } from "@/lib/format";
import type { Alert } from "@/lib/types";
import { pseudoChangePct, pseudoPrice, pseudoSpark } from "@/components/terminal/pseudo";
import { TableSkeleton } from "@/components/terminal/skeletons";
import { useTerminalStore } from "@/components/terminal/store";

const ALLOWED = new Set([...UNIVERSE, ...INDEX_ETFS]);

interface Row {
  symbol: string;
  last: number;
  changePct: number;
  spark: number[];
  alert?: Alert;
  inUniverse: boolean;
}

export function Watchlist() {
  const watchlist = useTerminalStore((s) => s.watchlist);
  const hydrated = useTerminalStore((s) => s.hydrated);
  const addWatch = useTerminalStore((s) => s.addWatch);
  const removeWatch = useTerminalStore((s) => s.removeWatch);
  const { data: tickers, isLoading } = useTickers();
  const { data: alerts } = useAlerts();
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  const rows = React.useMemo<Row[]>(() => {
    const quotes = new Map((tickers ?? []).map((t) => [t.symbol, t] as const));
    const bySymbol = new Map<string, Alert>();
    for (const a of alerts?.all ?? []) if (!bySymbol.has(a.symbol) || a.status === "open") bySymbol.set(a.symbol, a);
    return watchlist.map((symbol) => {
      const q = quotes.get(symbol);
      const a = bySymbol.get(symbol);
      return { symbol, last: q?.last ?? a?.last ?? pseudoPrice(symbol), changePct: q?.changePct ?? pseudoChangePct(symbol), spark: a?.spark ?? pseudoSpark(symbol), alert: a, inUniverse: UNIVERSE.includes(symbol) };
    });
  }, [watchlist, tickers, alerts]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const sym = draft.trim().toUpperCase();
    if (!sym) return;
    if (!ALLOWED.has(sym)) {
      setError(`${sym} is not in the TradeScope universe or the index ETFs. Ask for a symbol under Settings.`);
      return;
    }
    if (watchlist.includes(sym)) {
      setError(`${sym} is already on the list.`);
      return;
    }
    addWatch(sym);
    setDraft("");
    setError(null);
    toast.success(`${sym} added to the watchlist`);
  };

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        accessorKey: "symbol",
        header: "Symbol",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <span className="font-mono font-semibold">{row.original.symbol}</span>
            {!row.original.inUniverse ? <span className="text-[10px] text-muted-foreground uppercase">index</span> : null}
          </span>
        ),
      },
      { accessorKey: "last", header: "Last", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtPrice(getValue<number>())}</span> },
      { accessorKey: "changePct", header: "Change", meta: { align: "right" }, cell: ({ getValue }) => <PctChange value={getValue<number>()} /> },
      {
        id: "spark",
        header: "Today",
        enableSorting: false,
        cell: ({ row }) => <Sparkline data={row.original.spark} className="h-6 w-24" color={row.original.changePct >= 0 ? "var(--gain)" : "var(--loss)"} />,
      },
      {
        id: "alert",
        header: "Alert",
        accessorFn: (r) => (r.alert ? (r.alert.status === "open" ? 2 : 1) : 0),
        cell: ({ row }) => {
          const a = row.original.alert;
          if (!a) return <span className="text-xs text-muted-foreground">{row.original.inUniverse ? "Scanning" : "Not scanned"}</span>;
          if (a.status === "open")
            return (
              <Badge variant="secondary" className={TONE_BADGE.brand}>
                Open · score {a.score}
              </Badge>
            );
          return (
            <Badge variant="secondary" className={a.status === "target" ? TONE_BADGE.good : TONE_BADGE.neutral}>
              {a.status === "target" ? "Hit target" : "Stopped"} {a.closedAt ? fmtTimeET(a.closedAt, { month: "short", day: "numeric" }) : ""}
            </Badge>
          );
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${row.original.symbol}`}
            onClick={() => {
              removeWatch(row.original.symbol);
              toast(`${row.original.symbol} removed`, { action: { label: "Undo", onClick: () => addWatch(row.original.symbol) } });
            }}
          >
            <XIcon />
          </Button>
        ),
      },
    ],
    [removeWatch, addWatch],
  );

  if (isLoading || !hydrated) return <TableSkeleton rows={8} />;

  return (
    <>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="grid flex-1 gap-1.5 sm:max-w-xs">
          <Label htmlFor={`${id}-sym`}>Add symbol</Label>
          <Input
            id={`${id}-sym`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value.toUpperCase());
              setError(null);
            }}
            placeholder="e.g. AMD or QQQ"
            className="font-mono uppercase"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint`}
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={!draft.trim()}>
          <PlusIcon />
          Add
        </Button>
        <p id={`${id}-hint`} className={error ? "w-full text-xs text-destructive" : "w-full text-xs text-muted-foreground"}>
          {error ?? `Any of the ${UNIVERSE.length} TradeScope symbols plus ${INDEX_ETFS.join(", ")}.`}
        </p>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="Your watchlist is empty" description="Add a symbol above. Alerts on watched symbols show up here with their score and level." />
      ) : (
        <DataTable columns={columns} data={rows} searchable={false} pageSize={20} />
      )}
    </>
  );
}
