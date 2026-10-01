"use client";

import * as React from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { ArrowRight, Check, Copy, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { EmptyState } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { DEMO_NOW } from "@/lib/demo-clock";
import { fmtDate, fmtMoney, fmtNum, fmtPct, timeAgo } from "@/lib/format";
import { copyText } from "./clipboard";
import { REFERRAL_BASE_URL, useCurrentPartner } from "./current";
import { MoneyTooltip, moneyAxis } from "./chart-bits";
import { conversionShare, maskName, payoutDateFor, periodShort, PROGRAM, sortByPeriod } from "./program";
import { ChartCardSkeleton, ErrorState, KV, MODEL_LABEL, PlanBadge, StatGridSkeleton } from "./primitives";

const PAYOUT_CONFIG: ChartConfig = { amount: { label: "Payout", color: "var(--chart-1)" } };

export function PartnerOverview() {
  const { partner, program, payouts, isLoading, isError } = useCurrentPartner();

  if (isError) return <ErrorState />;
  if (isLoading || !partner || !program) {
    return (
      <div className="flex flex-col gap-5">
        <StatGridSkeleton count={4} />
        <div className="grid gap-4 lg:grid-cols-3">
          <ChartCardSkeleton title="Payouts, last 6 months" className="lg:col-span-2" />
          <ChartCardSkeleton title="Referral link" />
        </div>
      </div>
    );
  }

  const ordered = sortByPeriod(payouts);
  const last6 = ordered.slice(-6);
  const next = ordered.find((p) => p.status === "scheduled") ?? null;
  const nextDate = next ? payoutDateFor(next.period) : null;
  const previous = ordered.filter((p) => p.status === "paid").at(-1);
  const payoutDelta = next && previous ? Math.round(((next.amount - previous.amount) / previous.amount) * 1000) / 10 : undefined;
  const link = `${REFERRAL_BASE_URL}${partner.referralCode}`;
  const conversionRate = program.funnel.signups ? Math.round((program.funnel.paid / program.funnel.signups) * 1000) / 10 : 0;
  const chartData = last6.map((p) => ({ label: periodShort(p.period), amount: p.amount, status: p.status }));

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Referred accounts" value={fmtNum(program.funnel.signups)} delta={`${fmtNum(program.funnel.trials)} in trial`} />
        <StatCard label="Active paid accounts" value={fmtNum(program.funnel.paid)} delta={`${conversionRate}%`} deltaLabel="of signups" />
        <StatCard label="MRR attributed" value={fmtMoney(program.attributedMrr, { digits: 0 })} delta={`${program.share}%`} deltaLabel="is yours" />
        <StatCard
          label="Next payout"
          value={next ? fmtMoney(next.amount) : "None scheduled"}
          delta={payoutDelta !== undefined ? fmtPct(payoutDelta, 1) : undefined}
          deltaLabel={payoutDelta !== undefined && previous ? `vs ${periodShort(previous.period)}` : undefined}
          hint={nextDate ? <span className="text-xs text-muted-foreground tabular">{fmtDate(nextDate)}</span> : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Payouts, last 6 months</CardTitle>
            <CardDescription>Commission on referred subscriptions, paid by ACH on the {PROGRAM.payoutDay}th of the following month.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/partner/payouts" />}>
                All payouts
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <EmptyState title="No payouts yet" description="Your first payout is scheduled once referred accounts have paid for a full month." />
            ) : (
              <ChartContainer config={PAYOUT_CONFIG} className="aspect-[16/9] w-full sm:aspect-[21/9]">
                <BarChart data={chartData} margin={{ left: 4, right: 4, top: 8, bottom: 0 }} barCategoryGap="28%" accessibilityLayer>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={moneyAxis} />
                  <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<MoneyTooltip config={PAYOUT_CONFIG} />} />
                  <Bar dataKey="amount" fill="var(--color-amount)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <ReferralLinkCard link={link} code={partner.referralCode} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent conversions</CardTitle>
            <CardDescription>Referred traders who chose a plan this week. Names are masked.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/partner/referrals" />}>
                Referrals
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {program.conversions.length === 0 ? (
              <EmptyState title="No conversions yet" description="Share your referral link. Conversions appear here the moment a referred trader picks a plan." />
            ) : (
              <ul className="divide-y divide-border">
                {program.conversions.slice(0, 6).map((c) => {
                  const share = conversionShare(c, program.share);
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="font-mono text-sm font-medium">{maskName(c.name)}</span>
                        <PlanBadge plan={c.plan} />
                        <span className="hidden text-xs text-muted-foreground sm:inline">{c.billing === "yearly" ? "billed yearly" : "billed monthly"}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-right">
                        <span className="text-xs text-muted-foreground tabular">{timeAgo(c.at, DEMO_NOW)}</span>
                        <span className="w-16 font-medium tabular">{share > 0 ? `${fmtMoney(share)}/mo` : "$0.00"}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Program terms</CardTitle>
            <CardDescription>What applies to {partner.name} under the {MODEL_LABEL[partner.model].toLowerCase()} agreement.</CardDescription>
          </CardHeader>
          <CardContent>
            <KV
              items={[
                { label: "Model", value: MODEL_LABEL[partner.model] },
                { label: "Revenue share", value: `${program.share}% of referred subscriptions, lifetime` },
                { label: "Payout day", value: `${PROGRAM.payoutDay}th of each month, ACH` },
                { label: "Minimum payout", value: `${fmtMoney(PROGRAM.minimumPayout, { digits: 0 })}, smaller balances roll over` },
                { label: "Attribution", value: "First visit to paid plan, 90-day window" },
                { label: "Partner since", value: fmtDate(partner.createdAt) },
              ]}
            />
            <Button variant="outline" size="sm" className="mt-3" render={<Link href="/partner/settings?tab=legal" />}>
              Read the agreement summary
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ReferralLinkCard({ link, code }: { link: string; code: string }) {
  const [copied, setCopied] = React.useState(false);

  async function onCopy() {
    const ok = await copyText(link);
    if (ok) {
      setCopied(true);
      toast.success("Referral link copied", { description: link });
      window.setTimeout(() => setCopied(false), 1800);
    } else {
      toast.error("Could not copy automatically", { description: "Select the link text and copy it by hand." });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Referral link</CardTitle>
        <CardDescription>Every visit through this link is attributed to code {code} for 90 days.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-xs" title={link}>
            {link}
          </code>
          <Button variant="outline" size="icon" aria-label="Copy referral link" onClick={onCopy}>
            {copied ? <Check className="text-gain-foreground" /> : <Copy />}
          </Button>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-dashed border-input p-3">
          <div aria-hidden="true" className="grid size-16 shrink-0 place-items-center rounded-md border border-input bg-card text-muted-foreground">
            <QrCode className="size-7" />
          </div>
          <div className="grid gap-0.5 text-xs">
            <p className="text-sm font-medium">QR code</p>
            <p className="text-muted-foreground">Print-ready PNG and SVG for decks and event signage.</p>
            <Button variant="link" size="xs" className="h-auto justify-start px-0" onClick={() => toast.success("QR code downloaded", { description: `${code}-qr.svg, 1024 x 1024` })}>
              Download SVG
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
