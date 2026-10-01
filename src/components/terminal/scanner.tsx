"use client";

import * as React from "react";
import { toast } from "sonner";
import { RadarIcon, RotateCcwIcon } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { useAlerts } from "@/hooks/queries";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { PctChange } from "@/components/pnl";
import { TONE_BADGE } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ENGINE_DEFAULTS, UNIVERSE } from "@/lib/engine";
import { fmtPrice } from "@/lib/format";
import { between, hashSeed, pseudoChangePct, pseudoPrice } from "@/components/terminal/pseudo";
import { TableSkeleton } from "@/components/terminal/skeletons";

interface ScanRow {
  symbol: string;
  last: number;
  changePct: number;
  adx: number;
  rsi: number;
  relVol: number;
  atrPct: number;
  score: number;
  alertId?: number;
}

const DEFAULT_FILTERS = { adxMin: 20, rsiMin: 50, rsiMax: 70, relVolMin: 1.0, atrPctMin: 0.6 };
type Filters = typeof DEFAULT_FILTERS;

/** Indicator values seeded by the symbol's index in the universe; open alerts override with their real numbers. */
function buildRows(alertsBySymbol: Map<string, { id: number; adx: number; rsi: number; relVol: number; atrPct: number; score: number; last: number }>, pass: number): ScanRow[] {
  return UNIVERSE.map((symbol, i) => {
    const a = alertsBySymbol.get(symbol);
    const seed = hashSeed(symbol) + i * 0.013 + pass * 0.0007;
    const adx = a?.adx ?? between(seed, 1, 12, 36, 1);
    const rsi = a?.rsi ?? between(seed, 2, 36, 72, 1);
    const relVol = a?.relVol ?? between(seed, 3, 0.5, 2.2, 1);
    const atrPct = a?.atrPct ?? between(seed, 4, 0.4, 3.2, 2);
    const score = a?.score ?? Math.round(Math.max(0, (adx - 10) * 2.2 + (rsi - 40) * 1.1 + (relVol - 0.8) * 22 + atrPct * 4));
    return { symbol, last: a?.last ?? pseudoPrice(symbol), changePct: pseudoChangePct(symbol), adx, rsi, relVol, atrPct, score, alertId: a?.id };
  });
}

function NumField({ id, label, value, onChange, step = 1, min, max, suffix }: { id: string; label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input id={id} type="number" inputMode="decimal" step={step} min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="font-mono tabular pr-8" />
        {suffix ? <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span> : null}
      </div>
    </div>
  );
}

export function Scanner() {
  const { data, isLoading } = useAlerts();
  const [filters, setFilters] = React.useState<Filters>(DEFAULT_FILTERS);
  const [applied, setApplied] = React.useState<Filters>(DEFAULT_FILTERS);
  const [pass, setPass] = React.useState(0);
  const [scanning, setScanning] = React.useState(false);
  const [scannedAt, setScannedAt] = React.useState<Date | null>(null);
  const id = React.useId();

  const rows = React.useMemo(() => {
    const map = new Map((data?.open ?? []).map((a) => [a.symbol, a] as const));
    return buildRows(map, pass)
      .filter((r) => r.adx >= applied.adxMin && r.rsi >= applied.rsiMin && r.rsi <= applied.rsiMax && r.relVol >= applied.relVolMin && r.atrPct >= applied.atrPctMin)
      .sort((a, b) => b.score - a.score);
  }, [data, applied, pass]);

  const scan = () => {
    setScanning(true);
    window.setTimeout(() => {
      setApplied(filters);
      setPass((p) => p + 1);
      setScanning(false);
      setScannedAt(new Date());
      toast.success("Scan complete", { description: `${UNIVERSE.length} symbols on ${ENGINE_DEFAULTS.timeframe} bars. Results sorted by score.` });
    }, 700);
  };

  const columns = React.useMemo<ColumnDef<ScanRow>[]>(
    () => [
      {
        accessorKey: "score",
        header: "Score",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className={`inline-flex min-w-9 justify-center rounded-md px-1.5 py-0.5 font-mono text-xs font-semibold tabular ${row.original.score >= 100 ? TONE_BADGE.good : row.original.score >= ENGINE_DEFAULTS.minScore ? TONE_BADGE.brand : "bg-muted text-muted-foreground"}`}>{row.original.score}</span>
        ),
      },
      { accessorKey: "symbol", header: "Symbol", cell: ({ getValue }) => <span className="font-mono font-semibold">{getValue<string>()}</span> },
      { accessorKey: "last", header: "Last", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{fmtPrice(getValue<number>())}</span> },
      { accessorKey: "changePct", header: "Change", meta: { align: "right" }, cell: ({ getValue }) => <PctChange value={getValue<number>()} /> },
      { accessorKey: "adx", header: "ADX", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{getValue<number>().toFixed(1)}</span> },
      { accessorKey: "rsi", header: "RSI", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{getValue<number>().toFixed(1)}</span> },
      { accessorKey: "relVol", header: "Rel vol", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{getValue<number>().toFixed(1)}x</span> },
      { accessorKey: "atrPct", header: "ATR %", meta: { align: "right" }, cell: ({ getValue }) => <span className="font-mono">{getValue<number>().toFixed(2)}%</span> },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => (r.alertId ? 1 : 0),
        cell: ({ row }) =>
          row.original.alertId ? (
            <Badge variant="secondary" className={TONE_BADGE.brand}>
              Alert #{row.original.alertId}
            </Badge>
          ) : row.original.score >= ENGINE_DEFAULTS.minScore ? (
            <span className="text-xs text-muted-foreground">Above min score · awaiting breakout</span>
          ) : (
            <span className="text-xs text-muted-foreground">Below {ENGINE_DEFAULTS.minScore}</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>The published engine uses ADX 20+, RSI 50 to 70, relative volume 1.0x and a minimum score of {ENGINE_DEFAULTS.minScore}.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <NumField id={`${id}-adx`} label="ADX minimum" value={filters.adxMin} min={0} max={60} onChange={(v) => setFilters((f) => ({ ...f, adxMin: v }))} />
          <div className="grid grid-cols-2 gap-2">
            <NumField id={`${id}-rsimin`} label="RSI from" value={filters.rsiMin} min={0} max={100} onChange={(v) => setFilters((f) => ({ ...f, rsiMin: v }))} />
            <NumField id={`${id}-rsimax`} label="RSI to" value={filters.rsiMax} min={0} max={100} onChange={(v) => setFilters((f) => ({ ...f, rsiMax: v }))} />
          </div>
          <NumField id={`${id}-rv`} label="Relative volume minimum" value={filters.relVolMin} step={0.1} min={0} max={5} suffix="x" onChange={(v) => setFilters((f) => ({ ...f, relVolMin: v }))} />
          <NumField id={`${id}-atr`} label="ATR % minimum" value={filters.atrPctMin} step={0.1} min={0} max={10} suffix="%" onChange={(v) => setFilters((f) => ({ ...f, atrPctMin: v }))} />
          <div className="flex items-center gap-2 pt-1">
            <Button className="flex-1" onClick={scan} disabled={scanning}>
              <RadarIcon className={scanning ? "animate-pulse" : undefined} />
              {scanning ? "Scanning…" : "Scan"}
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Reset filters"
              onClick={() => {
                setFilters(DEFAULT_FILTERS);
                setApplied(DEFAULT_FILTERS);
                toast("Filters reset to engine defaults");
              }}
            >
              <RotateCcwIcon />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {scannedAt ? `Last scan ${scannedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : "Filters apply when you scan."} · {rows.length} of {UNIVERSE.length} pass
          </p>
        </CardContent>
      </Card>

      {isLoading ? (
        <TableSkeleton rows={10} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing passes these filters" description="Loosen a threshold and scan again. The engine itself publishes only setups scoring 70 or higher." className="self-start" />
      ) : (
        <DataTable columns={columns} data={rows} searchPlaceholder="Search symbol" pageSize={15} />
      )}
    </div>
  );
}
