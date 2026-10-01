"use client";

import * as React from "react";
import { getPlan, REFERRAL_SHARE_PCT } from "@/lib/plans";
import { fmtMoney } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Billing } from "@/components/marketing/pricing-plans";
import { cn } from "@/lib/utils";


const PRESETS = [10, 25, 50, 100, 250];

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Referral payout estimate: referred paid accounts x plan mix x plan price x 25%.
 * Prices come from lib/plans, so a price change updates the calculator automatically.
 */
export function RevenueCalculator({ className }: { className?: string }) {
  const [accounts, setAccounts] = React.useState(25);
  const [deskPct, setDeskPct] = React.useState(20);
  const [billing, setBilling] = React.useState<Billing>("monthly");
  const accountsId = React.useId();
  const mixId = React.useId();

  const pro = getPlan("pro");
  const desk = getPlan("desk");
  const proPrice = (billing === "yearly" ? pro.yearly : pro.monthly) ?? 0;
  const deskPrice = (billing === "yearly" ? desk.yearly : desk.monthly) ?? 0;

  const deskAccounts = Math.round((accounts * deskPct) / 100);
  const proAccounts = accounts - deskAccounts;
  const subscriptionRevenue = proAccounts * proPrice + deskAccounts * deskPrice;
  const payout = (subscriptionRevenue * REFERRAL_SHARE_PCT) / 100;

  return (
    <Card className={cn("gap-0 py-0", className)}>
      <div className="grid lg:grid-cols-[1fr_minmax(0,20rem)]">
        <div className="grid gap-6 p-5 sm:p-6">
          <CardHeader className="px-0">
            <CardTitle className="text-lg font-semibold">Estimate your referral payout</CardTitle>
            <CardDescription>Paid accounts you refer, the plan they land on, and how they bill. Starter accounts are free and earn nothing until they upgrade.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 px-0">
            <div className="grid gap-2">
              <Label htmlFor={accountsId}>Referred paid accounts</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={accountsId}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={10000}
                  value={accounts}
                  onChange={(e) => setAccounts(clamp(Number(e.target.value) || 0, 0, 10000))}
                  className="w-28 font-mono tabular"
                />
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick presets">
                  {PRESETS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setAccounts(n)}
                      aria-pressed={accounts === n}
                      className={cn(
                        "rounded-md border border-input px-2 py-1 font-mono text-xs tabular transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                        accounts === n && "border-primary bg-brand-soft text-primary",
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={mixId}>Plan mix</Label>
                <span className="text-xs text-muted-foreground tabular">
                  {100 - deskPct}% {pro.name} · {deskPct}% {desk.name}
                </span>
              </div>
              <input
                id={mixId}
                type="range"
                min={0}
                max={100}
                step={5}
                value={deskPct}
                onChange={(e) => setDeskPct(Number(e.target.value))}
                aria-valuetext={`${deskPct} percent on ${desk.name}`}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>All {pro.name}</span>
                <span>All {desk.name}</span>
              </div>
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium" id={`${mixId}-billing`}>
                Billing period
              </span>
              <ToggleGroup
                variant="outline"
                spacing={0}
                value={[billing]}
                onValueChange={(next) => {
                  const v = next[0];
                  if (v === "monthly" || v === "yearly") setBilling(v);
                }}
                aria-labelledby={`${mixId}-billing`}
              >
                <ToggleGroupItem value="monthly" className="px-4 data-pressed:bg-muted">
                  Monthly
                </ToggleGroupItem>
                <ToggleGroupItem value="yearly" className="px-4 data-pressed:bg-muted">
                  Yearly
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </CardContent>
        </div>

        <aside className="grid content-start gap-5 border-t border-border bg-muted/40 p-5 sm:p-6 lg:border-t-0 lg:border-l" aria-live="polite">
          <div className="grid gap-1">
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Monthly payout</span>
            <span className="font-heading text-4xl font-semibold tracking-tight tabular">{fmtMoney(payout, { digits: 0 })}</span>
            <span className="text-xs text-muted-foreground">{REFERRAL_SHARE_PCT}% of {fmtMoney(subscriptionRevenue, { digits: 0 })} in subscriptions</span>
          </div>
          <dl className="grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">
                {proAccounts} x {pro.name} at {fmtMoney(proPrice, { digits: 0 })}/mo
              </dt>
              <dd className="font-mono tabular">{fmtMoney(proAccounts * proPrice, { digits: 0 })}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">
                {deskAccounts} x {desk.name} at {fmtMoney(deskPrice, { digits: 0 })}/mo
              </dt>
              <dd className="font-mono tabular">{fmtMoney(deskAccounts * deskPrice, { digits: 0 })}</dd>
            </div>
            <div className="flex justify-between gap-3 border-t border-border pt-2 font-medium">
              <dt>Yearly payout</dt>
              <dd className="font-mono tabular">{fmtMoney(payout * 12, { digits: 0 })}</dd>
            </div>
          </dl>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Estimate only. Payouts follow collected revenue after refunds and are paid monthly by ACH once the balance reaches $100.
          </p>
        </aside>
      </div>
    </Card>
  );
}
