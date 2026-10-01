"use client";

import { useBacktest } from "@/hooks/queries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtPct } from "@/lib/format";
import { clsxNum } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CardSkeleton } from "@/components/terminal/skeletons";

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className={cn("font-heading text-lg font-semibold tabular", tone)}>{v}</p>
    </div>
  );
}

/** The engine's own out-of-sample numbers, shown as measured. */
export function RealityCheck() {
  const { data, isLoading } = useBacktest();
  if (isLoading || !data) return <CardSkeleton lines={2} />;
  const { stats, lifetime, params } = data;
  const lifetimeTotal = lifetime.wins + lifetime.losses + lifetime.scratches;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reality check</CardTitle>
        <CardDescription>
          Walk-forward backtest, {stats.symbols} symbols, {params.timeframe} bars, {stats.riskPerTrade}% risk per trade. Published unchanged; the engine is a filter, not a promise.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat k="Trades" v={`${stats.trades}`} />
        <Stat k="Win rate" v={fmtPct(stats.winRate, 1, false)} />
        <Stat k="Profit factor" v={stats.profitFactor.toFixed(2)} tone={stats.profitFactor >= 1 ? "text-gain-foreground" : "text-loss-foreground"} />
        <Stat k="Expectancy" v={`${stats.expectancyR > 0 ? "+" : ""}${stats.expectancyR.toFixed(3)} R`} tone={clsxNum(stats.expectancyR)} />
        <Stat k="Max drawdown" v={`-${stats.maxDrawdownPct.toFixed(1)}%`} tone="text-loss-foreground" />
        <Stat k="Lifetime record" v={`${lifetime.wins}-${lifetime.losses}-${lifetime.scratches}`} />
      </CardContent>
      <CardContent className="text-xs text-muted-foreground">
        {stats.wins} wins at +{stats.avgWinR} R, {stats.losses} losses at -{stats.avgLossR} R, {stats.scratches} scratches at breakeven; total return {fmtPct(stats.totalReturnPct, 1)}; longest losing streak {stats.maxConsecLosses}. Lifetime {lifetimeTotal} signals.
      </CardContent>
    </Card>
  );
}
