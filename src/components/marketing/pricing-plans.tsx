"use client";

import * as React from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { PLANS } from "@/lib/plans";
import type { Plan } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export type Billing = "monthly" | "yearly";

/** Monthly / Yearly switch. Controlled, never lets the group become empty. */
export function PricingToggle({ value, onChange, className }: { value: Billing; onChange: (b: Billing) => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <ToggleGroup
        variant="outline"
        spacing={0}
        value={[value]}
        onValueChange={(next) => {
          const v = next[0];
          if (v === "monthly" || v === "yearly") onChange(v);
        }}
        aria-label="Billing period"
      >
        <ToggleGroupItem value="monthly" className="px-4 data-pressed:bg-muted aria-pressed:bg-muted">
          Monthly
        </ToggleGroupItem>
        <ToggleGroupItem value="yearly" className="px-4 data-pressed:bg-muted aria-pressed:bg-muted">
          Yearly
        </ToggleGroupItem>
      </ToggleGroup>
      <Badge variant="secondary" className="bg-brand-soft text-primary">
        Save about 20% on yearly
      </Badge>
    </div>
  );
}

function priceHint(plan: Plan, billing: Billing) {
  const price = billing === "yearly" ? plan.yearly : plan.monthly;
  if (price === null) return "Annual agreement, invoiced";
  if (price === 0) return "Free, no card required";
  if (billing === "yearly") return `Billed yearly at $${price * 12}`;
  return "Billed monthly, cancel anytime";
}

export function PlanCard({ plan, billing, className }: { plan: Plan; billing: Billing; className?: string }) {
  const price = billing === "yearly" ? plan.yearly : plan.monthly;
  const href = plan.id === "enterprise" ? "/tenants#white-label" : "/signup";

  return (
    <Card className={cn("relative h-full gap-5", plan.featured && "ring-2 ring-primary", className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-lg font-semibold">{plan.name}</CardTitle>
          {plan.featured ? <Badge>Most popular</Badge> : null}
        </div>
        <CardDescription>{plan.tagline}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div>
          {price === null ? (
            <div className="font-heading text-4xl font-semibold tracking-tight">Custom</div>
          ) : (
            <div className="flex items-baseline gap-1">
              <span className="font-heading text-4xl font-semibold tracking-tight tabular">${price}</span>
              <span className="text-sm text-muted-foreground">/mo</span>
            </div>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{priceHint(plan, billing)}</p>
        </div>
        <Button variant={plan.featured ? "default" : "outline"} size="lg" className="w-full" render={<Link href={href} />}>
          {plan.cta}
        </Button>
        <ul className="grid gap-2 text-sm">
          {plan.features.map((f) => (
            <li key={f} className="flex gap-2">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Toggle + the four plan cards + footnote. Used on the home page and /pricing. */
export function PricingPlans({ className, footnote = true }: { className?: string; footnote?: boolean }) {
  const [billing, setBilling] = React.useState<Billing>("monthly");

  return (
    <div className={cn("grid gap-8", className)}>
      <PricingToggle value={billing} onChange={setBilling} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {PLANS.map((p) => (
          <PlanCard key={p.id} plan={p} billing={billing} />
        ))}
      </div>
      {footnote ? (
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Prices in USD. Broker commissions, exchange fees and regulatory fees are charged by your broker, never by Nasscord. Paid plans include a
          14-day trial; Starter stays free.
        </p>
      ) : null}
    </div>
  );
}
