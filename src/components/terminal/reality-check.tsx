import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BACKTEST, ENGINE_DEFAULTS, LIFETIME_RECORD } from "@/lib/engine";
import { clsxNum, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className={cn("font-heading text-lg font-semibold tabular", tone)}>{v}</p>
    </div>
  );
}

/**
 * The engine's walk-forward backtest as recorded in src/lib/engine.ts. These are the engine's own
 * statistics, not the user's results and not live signals; the card says so.
 */
export function RealityCheck({ className }: { className?: string }) {
  const stats = BACKTEST;
  const lifetime = LIFETIME_RECORD;
  const lifetimeTotal = lifetime.wins + lifetime.losses + lifetime.scratches;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Engine backtest</CardTitle>
        <CardDescription>
          TradeScope&apos;s walk-forward backtest from the engine&apos;s own record: {stats.symbols} symbols, {ENGINE_DEFAULTS.timeframe} bars, {stats.riskPerTrade}% risk per trade. These are the engine&apos;s numbers, not your account and not from your broker. The engine is a filter, not a promise.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <Stat k="Trades" v={`${stats.trades}`} />
        <Stat k="Win rate" v={fmtPct(stats.winRate, 1, false)} />
        <Stat k="Profit factor" v={stats.profitFactor.toFixed(2)} />
        <Stat k="Expectancy" v={`${stats.expectancyR > 0 ? "+" : ""}${stats.expectancyR.toFixed(3)} R`} tone={clsxNum(stats.expectancyR)} />
        <Stat k="Max drawdown" v={`-${stats.maxDrawdownPct.toFixed(1)}%`} />
        <Stat k="Signal record" v={`${lifetime.wins}-${lifetime.losses}-${lifetime.scratches}`} />
      </CardContent>
      <CardContent className="text-xs text-muted-foreground">
        {stats.wins} wins at +{stats.avgWinR} R, {stats.losses} losses at -{stats.avgLossR} R, {stats.scratches} scratches at breakeven; total return {fmtPct(stats.totalReturnPct, 1)}; longest losing streak {stats.maxConsecLosses}. Signal record (wins-losses-scratches) over {lifetimeTotal} signals.
      </CardContent>
    </Card>
  );
}
