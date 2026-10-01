"use client";

import { StatCard } from "@/components/stat-card";
import { clsxNum, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAccountScope, useScopedPositions } from "@/components/terminal/hooks";
import { StatRowSkeleton } from "@/components/terminal/skeletons";

/** Deterministic little series so every stat tile has a trend line without inventing history. */
export function syntheticSpark(end: number, seed: number, n = 16, volatility = 0.004) {
  const out: number[] = [];
  let v = end;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Math.round(v * 100) / 100;
    v = v / (1 + Math.sin(seed * 3.1 + i * 0.9) * volatility + volatility * 0.35);
  }
  return out;
}

export function TerminalStatRow() {
  const scope = useAccountScope();
  const { positions, isLoading: posLoading } = useScopedPositions();
  if (scope.isLoading) return <StatRowSkeleton />;

  const { totals, scoped } = scope;
  const openValue = positions.reduce((s, p) => s + p.qty * p.last, 0);
  const label = scope.selected ? `${scoped.length} account` : `${scoped.length} accounts`;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Net liquidation" value={fmtMoney(totals.netLiq, { digits: 0 })} delta={label} spark={syntheticSpark(totals.netLiq, 1)} />
      <StatCard
        label="Day P&L"
        value={<span className={cn(clsxNum(totals.dayPnl))}>{fmtMoney(totals.dayPnl, { sign: true, digits: 0 })}</span>}
        delta={totals.dayPnlPct}
        deltaLabel="% today"
        spark={syntheticSpark(totals.dayPnl, 2, 16, 0.02)}
        sparkColor={totals.dayPnl >= 0 ? "var(--gain)" : "var(--loss)"}
      />
      <StatCard label="Open positions" value={posLoading ? "…" : positions.length} delta={posLoading ? "loading" : `${fmtMoney(openValue, { digits: 0, compact: true })} at market`} />
      <StatCard label="Buying power" value={fmtMoney(totals.buyingPower, { digits: 0 })} delta={`${fmtMoney(totals.cash, { digits: 0, compact: true })} cash`} />
    </div>
  );
}
