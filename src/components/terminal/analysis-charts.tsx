"use client";

import * as React from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { useBacktest, useEquityCurve } from "@/hooks/queries";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { clsxNum, fmtCompact, fmtMoney, fmtPct } from "@/lib/format";
import { ChartSkeleton, StatRowSkeleton } from "@/components/terminal/skeletons";

const equityConfig = { equity: { label: "Equity", color: "var(--chart-1)" } } satisfies ChartConfig;
const pnlConfig = { pnl: { label: "Daily P&L", color: "var(--chart-3)" } } satisfies ChartConfig;

export function AnalysisCharts() {
  const { data, isLoading } = useEquityCurve();
  const { data: bt } = useBacktest();

  if (isLoading || !data) {
    return (
      <>
        <StatRowSkeleton />
        <ChartSkeleton />
        <ChartSkeleton />
      </>
    );
  }

  const equity = data.equity;
  const daily = data.daily;
  const realised30 = daily.reduce((s, d) => s + d.pnl, 0);
  const first = equity[0]?.equity ?? 0;
  const last = equity[equity.length - 1]?.equity ?? 0;
  const periodPct = first > 0 ? ((last - first) / first) * 100 : 0;
  const upDays = daily.filter((d) => d.pnl > 0).length;
  const best = daily.reduce((m, d) => (d.pnl > m.pnl ? d : m), daily[0]);
  const worst = daily.reduce((m, d) => (d.pnl < m.pnl ? d : m), daily[0]);
  const stats = bt?.stats;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Realised P&L, 30d" value={<span className={clsxNum(realised30)}>{fmtMoney(realised30, { sign: true, digits: 0 })}</span>} delta={`${upDays} of ${daily.length} days up`} />
        <StatCard label="Win rate" value={stats ? fmtPct(stats.winRate, 1, false) : "…"} delta={stats ? `${stats.wins}W ${stats.losses}L ${stats.scratches}S` : ""} />
        <StatCard label="Avg R" value={stats ? `+${stats.avgWinR.toFixed(2)} / -${stats.avgLossR.toFixed(2)}` : "…"} delta={stats ? `expectancy ${stats.expectancyR.toFixed(3)} R` : ""} />
        <StatCard label="Max drawdown" value={stats ? <span className="text-loss-foreground">-{stats.maxDrawdownPct.toFixed(1)}%</span> : "…"} delta={stats ? `${stats.maxConsecLosses} losses in a row, worst` : ""} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Equity curve</CardTitle>
          <CardDescription>
            Combined net liquidation across included accounts, {equity.length} trading days. {fmtMoney(first, { digits: 0 })} to {fmtMoney(last, { digits: 0 })} ({fmtPct(periodPct, 1)}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={equityConfig} className="aspect-auto h-64 w-full">
            <AreaChart data={equity} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={32} tickMargin={8} />
              <YAxis width={52} tickLine={false} axisLine={false} domain={["dataMin - 2000", "dataMax + 2000"]} tickFormatter={(v: number) => `$${fmtCompact(v, 0)}`} />
              <ChartTooltip cursor={{ stroke: "var(--border)" }} content={<ChartTooltipContent indicator="line" formatter={(value) => <span className="ml-auto font-mono font-medium tabular">{fmtMoney(Number(value), { digits: 0 })}</span>} />} />
              <Area type="monotone" dataKey="equity" stroke="var(--color-equity)" strokeWidth={2} fill="var(--color-equity)" fillOpacity={0.12} dot={false} activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Daily P&L</CardTitle>
          <CardDescription>
            Last {daily.length} trading days. Best {best.label} {fmtMoney(best.pnl, { sign: true, digits: 0 })}, worst {worst.label} {fmtMoney(worst.pnl, { sign: true, digits: 0 })}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={pnlConfig} className="aspect-auto h-56 w-full">
            <BarChart data={daily} margin={{ left: 4, right: 8, top: 8, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tickMargin={8} />
              <YAxis width={52} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v < 0 ? "-" : ""}$${fmtCompact(Math.abs(v), 1)}`} />
              <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<ChartTooltipContent hideIndicator formatter={(value) => <span className={`ml-auto font-mono font-medium tabular ${clsxNum(Number(value))}`}>{fmtMoney(Number(value), { sign: true, digits: 0 })}</span>} />} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                {daily.map((d) => (
                  <Cell key={d.label} fill={d.pnl >= 0 ? "var(--chart-3)" : "var(--chart-2)"} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
          <p className="mt-2 text-xs text-muted-foreground">Green bars are up days, orange bars are down days. Values are realised plus unrealised change in combined equity for the session.</p>
        </CardContent>
      </Card>
    </>
  );
}
