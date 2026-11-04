import { EmptyState } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BACKTEST, ENGINE_DEFAULTS, UNIVERSE } from "@/lib/engine";
import { fmtNum } from "@/lib/format";
import { KV } from "./primitives";

const TIMEFRAME_LABEL = { "5m": "5 minutes", "15m": "15 minutes", "1h": "1 hour" } as const;

/** TradeScope parameters as defined in src/lib/engine, read-only, and the published backtest. */
export function EnginePage() {
  const p = ENGINE_DEFAULTS;
  const b = BACKTEST;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Live scan</CardTitle>
          <CardDescription>Last scan, open setups and alerts sent.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState title="The scanner is not connected" description="TradeScope does not report to this app yet, so there is no live scan status, alert count or last run to show." />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Parameters</CardTitle>
            <CardDescription>Defined in the code (src/lib/engine). Changing one is a code change and a deploy.</CardDescription>
          </CardHeader>
          <CardContent>
            <KV
              items={[
                { label: "Universe", value: `${fmtNum(p.universeSize)} symbols` },
                { label: "Timeframe", value: TIMEFRAME_LABEL[p.timeframe] },
                { label: "Minimum score", value: String(p.minScore) },
                { label: "Open setups at most", value: String(p.maxOpen) },
                { label: "Stop", value: `${p.atrStopMultiple} × ATR below entry` },
                { label: "Target", value: `${p.rewardToRisk} × the risk above entry` },
                { label: "Trail stop to breakeven", value: p.trailToBreakeven ? "Yes" : "No" },
                { label: "News model", value: p.newsModelMarketHoursOnly ? "Market hours only" : "Around the clock" },
                { label: "Order size", value: "Trader's risk per trade (1% of net liquidation by default), notional capped at 95% of net liquidation" },
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Engine backtest</CardTitle>
            <CardDescription>
              TradeScope&apos;s walk-forward backtest as recorded in the engine constants (src/lib/engine.ts): {fmtNum(b.trades)} trades across {fmtNum(b.symbols)} symbols at {b.riskPerTrade}% risk per trade. The terminal shows the same figures as the engine&apos;s own record; the marketing pages do not quote them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <KV
              items={[
                { label: "Wins, losses, scratches", value: `${b.wins} / ${b.losses} / ${b.scratches}` },
                { label: "Win rate", value: `${b.winRate}%` },
                { label: "Average win", value: `${b.avgWinR} R` },
                { label: "Average loss", value: `${b.avgLossR} R` },
                { label: "Profit factor", value: String(b.profitFactor) },
                { label: "Expectancy", value: `${b.expectancyR} R per trade` },
                { label: "Total return", value: `${b.totalReturnPct}%` },
                { label: "Max drawdown", value: `${b.maxDrawdownPct}%` },
                { label: "Most losses in a row", value: String(b.maxConsecLosses) },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Universe</CardTitle>
          <CardDescription>The {fmtNum(UNIVERSE.length)} large-cap US equities the scanner covers.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-1.5" aria-label="Scanned symbols">
            {UNIVERSE.map((s) => (
              <li key={s} className="rounded-md border border-border px-2 py-0.5 font-mono text-xs tabular">
                {s}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
