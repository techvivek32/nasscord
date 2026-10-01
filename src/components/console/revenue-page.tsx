"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePlatformOverview, useTenants } from "@/hooks/queries";
import { fmtMoney, fmtNum } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import { PlanBadge } from "./badges";
import { MoneyTooltip, moneyAxis } from "./chart-bits";
import { ChartCardSkeleton, TableSkeleton } from "./primitives";
import { applyTenantOverrides, useTenantOverrides } from "./store";

const COST_CONFIG: ChartConfig = {
  mrr: { label: "MRR", color: "var(--chart-1)" },
  infra: { label: "Infrastructure cost", color: "var(--chart-2)" },
};
const PLAN_CONFIG: ChartConfig = {
  starter: { label: "Starter", color: "var(--chart-4)" },
  pro: { label: "Pro", color: "var(--chart-1)" },
  desk: { label: "Desk", color: "var(--chart-3)" },
  enterprise: { label: "Enterprise", color: "var(--chart-5)" },
};
const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export function RevenuePage() {
  const overview = usePlatformOverview();
  const tenants = useTenants();
  const overrides = useTenantOverrides();
  const d = overview.data;

  const mix = React.useMemo(() => {
    const list = (tenants.data ?? []).map((t) => applyTenantOverrides(t, overrides));
    const total = list.reduce((s, t) => s + t.mrr, 0);
    return {
      total,
      rows: PLANS.map((p) => {
        const inPlan = list.filter((t) => t.plan === p.id);
        const mrr = inPlan.reduce((s, t) => s + t.mrr, 0);
        return { plan: p.id, tenants: inPlan.length, mrr, share: total ? (mrr / total) * 100 : 0, arpt: inPlan.length ? mrr / inPlan.length : 0 };
      }),
      count: list.length,
    };
  }, [tenants.data, overrides]);

  const latest = d?.mrrHistory[d.mrrHistory.length - 1];
  const margin = latest ? ((latest.mrr - latest.infra) / latest.mrr) * 100 : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 lg:grid-cols-2">
        {d ? (
          <Card>
            <CardHeader>
              <CardTitle>MRR vs infrastructure cost</CardTitle>
              <CardDescription>
                Gateway pools, proxies, database and mail, monthly. {margin !== null ? `Gross margin ${margin.toFixed(0)}% in ${latest?.label}.` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={COST_CONFIG} className="aspect-[16/9] w-full">
                <LineChart data={d.mrrHistory} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={moneyAxis} />
                  <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<MoneyTooltip config={COST_CONFIG} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line type="monotone" dataKey="mrr" stroke="var(--color-mrr)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} />
                  <Line type="monotone" dataKey="infra" stroke="var(--color-infra)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>
        ) : (
          <ChartCardSkeleton title="MRR vs infrastructure cost" />
        )}

        {d ? (
          <Card>
            <CardHeader>
              <CardTitle>Revenue by plan</CardTitle>
              <CardDescription>Monthly revenue per plan, last six months. Starter is free, so it stays flat at zero.</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={PLAN_CONFIG} className="aspect-[16/9] w-full">
                <BarChart data={d.revenueByPlan} margin={{ left: 4, right: 4, top: 8, bottom: 0 }} barCategoryGap="22%" barGap={2}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={moneyAxis} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<MoneyTooltip config={PLAN_CONFIG} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="starter" fill="var(--color-starter)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="pro" fill="var(--color-pro)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="desk" fill="var(--color-desk)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="enterprise" fill="var(--color-enterprise)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        ) : (
          <ChartCardSkeleton title="Revenue by plan" />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Plan mix</CardTitle>
          <CardDescription>Computed from the tenant list as it stands right now, including any plan changes made in this session.</CardDescription>
        </CardHeader>
        <CardContent>
          {tenants.isLoading ? (
            <TableSkeleton rows={4} cols={5} />
          ) : mix.count === 0 ? (
            <EmptyState title="No tenants" description="Plan mix appears once tenants exist." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Plan</TableHead>
                    <TableHead className={`${TH} text-right`}>Tenants</TableHead>
                    <TableHead className={`${TH} text-right`}>MRR</TableHead>
                    <TableHead className={`${TH} text-right`}>Share</TableHead>
                    <TableHead className={`${TH} text-right`}>Avg revenue per tenant</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mix.rows.map((r) => (
                    <TableRow key={r.plan}>
                      <TableCell>
                        <PlanBadge plan={r.plan} />
                      </TableCell>
                      <TableCell className="text-right tabular">{fmtNum(r.tenants)}</TableCell>
                      <TableCell className="text-right font-medium tabular">{fmtMoney(r.mrr, { digits: 0 })}</TableCell>
                      <TableCell className="text-right tabular">{r.share.toFixed(1)}%</TableCell>
                      <TableCell className="text-right tabular">{r.arpt ? fmtMoney(r.arpt, { digits: 0 }) : <span className="text-muted-foreground">Free</span>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell>Total</TableCell>
                    <TableCell className="text-right tabular">{fmtNum(mix.count)}</TableCell>
                    <TableCell className="text-right tabular">{fmtMoney(mix.total, { digits: 0 })}</TableCell>
                    <TableCell className="text-right tabular">100%</TableCell>
                    <TableCell className="text-right tabular">{fmtMoney(mix.count ? mix.total / mix.count : 0, { digits: 0 })}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
