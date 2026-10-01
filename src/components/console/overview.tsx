"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { StatCard } from "@/components/stat-card";
import { StatusDot } from "@/components/status-dot";
import { EmptyState } from "@/components/page-header";
import { BrokerMark, BrokerMarks } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePlatformOverview, useTenants } from "@/hooks/queries";
import { getBroker } from "@/lib/brokers";
import { fmtMoney, fmtNum, fmtPct, timeAgo } from "@/lib/format";
import { PlanBadge, SeverityBadge } from "./badges";
import { CountTooltip, MoneyTooltip, moneyAxis } from "./chart-bits";
import { DEMO_NOW, INCIDENT_STATUS } from "./lib";
import { ChartCardSkeleton, ListSkeleton, StatGridSkeleton, TableSkeleton } from "./primitives";
import { applyTenantOverrides, useTenantOverrides } from "./store";

const MRR_CONFIG: ChartConfig = { mrr: { label: "MRR", color: "var(--chart-1)" } };
const SIGNUP_CONFIG: ChartConfig = {
  starter: { label: "Starter", color: "var(--chart-1)" },
  pro: { label: "Pro", color: "var(--chart-2)" },
  desk: { label: "Desk", color: "var(--chart-3)" },
};

/* Twelve-week trails for the KPI tiles. Endpoints match PLATFORM_KPIS. */
const SPARK = {
  tenants: [241, 248, 254, 261, 266, 272, 279, 285, 291, 298, 305, 312],
  accounts: [902, 928, 951, 977, 1004, 1031, 1058, 1082, 1109, 1136, 1161, 1184],
  trial: [27.1, 27.6, 28.0, 28.4, 28.6, 29.1, 29.5, 29.8, 30.2, 30.5, 30.8, 31.0],
  alerts: [1720, 1810, 1890, 1960, 2010, 2080, 2120, 2170, 2210, 2250, 2280, 2310],
  churn: [2.9, 2.8, 2.8, 2.7, 2.6, 2.5, 2.4, 2.4, 2.3, 2.2, 2.2, 2.1],
};

export function Overview() {
  const overview = usePlatformOverview();
  const tenants = useTenants();
  const overrides = useTenantOverrides();

  const recent = React.useMemo(
    () =>
      (tenants.data ?? [])
        .map((t) => applyTenantOverrides(t, overrides))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6),
    [tenants.data, overrides],
  );

  const d = overview.data;
  const k = d?.kpis;
  const openIncidents = (d?.incidents ?? []).filter((i) => i.status !== "resolved");

  return (
    <div className="flex flex-col gap-5">
      {k ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatCard label="MRR" value={fmtMoney(k.mrr, { digits: 0 })} delta={fmtPct(k.mrrDeltaPct, 1)} deltaLabel="MoM" spark={d.mrrHistory.map((m) => m.mrr)} sparkColor="var(--chart-1)" />
          <StatCard label="Active tenants" value={fmtNum(k.activeTenants)} delta={`+${k.newTenantsThisMonth}`} deltaLabel="this month" spark={SPARK.tenants} sparkColor="var(--chart-1)" />
          <StatCard label="Connected broker accounts" value={fmtNum(k.connectedAccounts)} spark={SPARK.accounts} sparkColor="var(--chart-1)" />
          <StatCard label="Trial to paid" value={`${k.trialToPaidPct}%`} delta={k.trialToPaidDeltaPts} deltaLabel="pts" spark={SPARK.trial} sparkColor="var(--chart-1)" />
          <StatCard label="Alerts sent today" value={fmtNum(k.alertsSentToday)} spark={SPARK.alerts} sparkColor="var(--chart-1)" hint={<span className="text-[11px] text-muted-foreground">15m scan</span>} />
          <StatCard label="Churn" value={`${k.churnPct}%`} delta={k.churnDeltaPts} deltaLabel="pts" upIsGood={false} spark={SPARK.churn} sparkColor="var(--chart-1)" />
        </div>
      ) : (
        <StatGridSkeleton />
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        {d ? (
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>MRR, last 12 months</CardTitle>
              <CardDescription>Monthly recurring revenue at month end, all plans and partner-billed seats.</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={MRR_CONFIG} className="aspect-[16/7] w-full">
                <AreaChart data={d.mrrHistory} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mrr-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-mrr)" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="var(--color-mrr)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={moneyAxis} />
                  <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={<MoneyTooltip config={MRR_CONFIG} />} />
                  <Area type="monotone" dataKey="mrr" stroke="var(--color-mrr)" strokeWidth={2} fill="url(#mrr-fill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }} />
                </AreaChart>
              </ChartContainer>
            </CardContent>
          </Card>
        ) : (
          <ChartCardSkeleton title="MRR, last 12 months" className="lg:col-span-3" />
        )}

        {d ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>New tenants by plan, last 12 weeks</CardTitle>
              <CardDescription>Signups per ISO week. Enterprise deals are contracted and excluded.</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={SIGNUP_CONFIG} className="aspect-[16/9] w-full">
                <BarChart data={d.signupsByPlan} margin={{ left: 4, right: 4, top: 8, bottom: 0 }} barCategoryGap="28%">
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={1} />
                  <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<CountTooltip config={SIGNUP_CONFIG} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="starter" stackId="a" fill="var(--color-starter)" stroke="var(--card)" strokeWidth={1} />
                  <Bar dataKey="pro" stackId="a" fill="var(--color-pro)" stroke="var(--card)" strokeWidth={1} />
                  <Bar dataKey="desk" stackId="a" fill="var(--color-desk)" stroke="var(--card)" strokeWidth={1} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        ) : (
          <ChartCardSkeleton title="New tenants by plan, last 12 weeks" className="lg:col-span-2" />
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Broker connection health</CardTitle>
          <CardDescription>Connected accounts per broker and the share that refreshed on the last cycle.</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" render={<Link href="/admin/brokers" />}>
              View brokers
              <ArrowRight data-icon="inline-end" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {d ? (
            d.brokerHealth.length === 0 ? (
              <EmptyState title="No broker connections yet" description="Health appears once the first tenant connects an account." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">Broker</TableHead>
                    <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">Accounts</TableHead>
                    <TableHead className="w-56 text-xs tracking-wide text-muted-foreground uppercase">Healthy</TableHead>
                    <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">Failing</TableHead>
                    <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">Last incident</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.brokerHealth.map((h) => (
                    <TableRow key={h.brokerId}>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <BrokerMark id={h.brokerId} size="sm" />
                          <span className="font-medium">{getBroker(h.brokerId).name}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular">{fmtNum(h.accounts)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-3">
                          <Progress value={h.healthyPct} aria-label={`${h.healthyPct}% healthy`} className="flex-1 flex-nowrap" />
                          <span className="w-12 text-right text-xs tabular">{h.healthyPct.toFixed(1)}%</span>
                        </span>
                      </TableCell>
                      <TableCell className={`text-right tabular ${h.failing > 0 ? "text-warn-foreground" : "text-muted-foreground"}`}>{h.failing}</TableCell>
                      <TableCell className="text-muted-foreground">{h.lastIncidentAt ? timeAgo(h.lastIncidentAt, DEMO_NOW) : "None in 30 d"}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="xs" render={<Link href="/admin/brokers" />}>
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          ) : (
            <TableSkeleton rows={5} cols={5} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent signups</CardTitle>
            <CardDescription>Newest workspaces across all plans.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/admin/tenants" />}>
                All tenants
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {tenants.isLoading ? (
              <ListSkeleton rows={5} />
            ) : recent.length === 0 ? (
              <EmptyState title="No signups yet" description="New workspaces appear here as soon as someone completes onboarding." />
            ) : (
              <ul className="divide-y divide-border">
                {recent.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link href={`/admin/tenants/${t.id}`} className="block truncate text-sm font-medium hover:underline">
                        {t.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {t.owner.name} · {timeAgo(t.createdAt, DEMO_NOW)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <BrokerMarks ids={t.brokers} max={3} />
                      <PlanBadge plan={t.plan} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open incidents</CardTitle>
            <CardDescription>Anything not yet resolved. Full timeline under System Health.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/admin/health" />}>
                System health
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {!d ? (
              <ListSkeleton rows={3} />
            ) : openIncidents.length === 0 ? (
              <EmptyState title="No open incidents" description="All services are reporting healthy." />
            ) : (
              <ul className="divide-y divide-border">
                {openIncidents.map((i) => (
                  <li key={i.id} className="grid gap-1.5 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{i.title}</p>
                      <SeverityBadge severity={i.severity} />
                    </div>
                    <p className="text-xs text-muted-foreground">{i.summary}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <StatusDot tone={INCIDENT_STATUS[i.status].tone} label={INCIDENT_STATUS[i.status].label} pulse={i.status === "open"} className="text-xs" />
                      <span>Started {timeAgo(i.startedAt, DEMO_NOW)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
