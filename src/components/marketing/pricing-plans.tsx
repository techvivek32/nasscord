"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PLANS } from "@/lib/plans";
import type { Plan } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

export type Billing = "monthly" | "yearly";

/** Monthly / Yearly as a square segmented control (radio semantics). */
export function PricingToggle({ value, onChange, className }: { value: Billing; onChange: (b: Billing) => void; className?: string }) {
  const options: Array<{ v: Billing; label: string }> = [
    { v: "monthly", label: "Monthly" },
    { v: "yearly", label: "Yearly" },
  ];
  return (
    <div className={cn("flex flex-wrap items-center gap-4", className)}>
      <div role="radiogroup" aria-label="Billing period" className="inline-flex border border-foreground">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              "px-4 py-2 font-mono text-xs tracking-wide uppercase transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              value === o.v ? "bg-foreground text-background" : "hover:bg-site-band",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="site-caption border border-site-accent px-2 py-1 text-site-accent-ink">Save about 20% on yearly</span>
    </div>
  );
}

/** Billing is not switched on in this release: paid prices are list prices and nothing is charged. */
function priceHint(plan: Plan, billing: Billing) {
  const price = billing === "yearly" ? plan.yearly : plan.monthly;
  if (price === null) return "Annual agreement";
  if (price === 0) return "Free, no card required";
  if (billing === "yearly") return `List price, $${(price * 12).toLocaleString("en-US")} a year. Not charged in this release`;
  return "List price. Not charged in this release";
}

const PLANNED = "Planned: ";

export function PlanCard({ plan, billing, className }: { plan: Plan; billing: Billing; className?: string }) {
  const price = billing === "yearly" ? plan.yearly : plan.monthly;
  // Enterprise is a contract, so its button starts a conversation; every other plan starts the signup.
  const href = plan.id === "enterprise" ? "mailto:sales@nasscord.com?subject=Nasscord%20Enterprise" : "/signup";

  return (
    <div className={cn("group/plan flex h-full flex-col gap-7 p-6 transition-colors duration-300 sm:p-7", plan.featured ? "bg-site-band" : "hover:bg-site-band/50", className)}>
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-4xl">{plan.name}</h3>
          {plan.featured ? <span className="site-caption border border-site-accent px-2 py-0.5 text-site-accent-ink">Recommended</span> : null}
        </div>
        <p className="text-sm text-muted-foreground">{plan.tagline}</p>
      </div>
      <div>
        {price === null ? (
          <div className="font-serif text-6xl leading-none italic">Custom</div>
        ) : (
          <div className="flex items-baseline gap-1.5">
            <span key={`${plan.id}-${billing}`} className="inline-block animate-site-rise text-6xl leading-none tracking-[-0.04em] tabular">
              ${price}
            </span>
            <span className="text-sm text-muted-foreground">/mo</span>
          </div>
        )}
        <p className="mt-3 font-mono text-[0.7rem] text-muted-foreground">{priceHint(plan, billing)}</p>
      </div>
      <Button
        variant={plan.featured ? "default" : "outline"}
        size="lg"
        className={cn("group/cta h-11 w-full rounded-[2px]", !plan.featured && "border-foreground bg-transparent hover:bg-foreground hover:text-background")}
        render={href.startsWith("mailto:") ? <a href={href} /> : <Link href={href} />}
      >
        {plan.cta}
        <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-0.5" />
      </Button>
      {plan.id === "pro" || plan.id === "desk" ? (
        <p className="-mt-4 font-mono text-[0.7rem] text-muted-foreground">You pick {plan.name} when you set up your workspace.</p>
      ) : null}
      <ul className="grid gap-2.5 border-t border-border pt-5 text-sm">
        {plan.features.map((f) =>
          f.startsWith(PLANNED) ? (
            <li key={f} className="flex gap-2.5 text-muted-foreground">
              <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 border border-muted-foreground/60" />
              <span>
                <span className="site-caption mr-1.5 tracking-wide">Planned</span>
                {f.slice(PLANNED.length)}
              </span>
            </li>
          ) : (
            <li key={f} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 bg-site-accent" />
              <span>{f}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/** Toggle + the four plans as ruled columns + footnote. Used on the home page and /pricing. */
export function PricingPlans({ className, footnote = true }: { className?: string; footnote?: boolean }) {
  const [billing, setBilling] = React.useState<Billing>("monthly");

  return (
    <div className={cn("grid gap-8", className)}>
      <PricingToggle value={billing} onChange={setBilling} />
      <div className="grid border-t border-b border-foreground sm:grid-cols-2 xl:grid-cols-4 [&>*]:border-border max-sm:[&>*+*]:border-t sm:[&>*:nth-child(even)]:border-l xl:[&>*+*]:border-l sm:max-xl:[&>*:nth-child(n+3)]:border-t">
        {PLANS.map((p, i) => (
          <div key={p.id} {...reveal(i * 90)}>
            <PlanCard plan={p} billing={billing} />
          </div>
        ))}
      </div>
      {footnote ? (
        <p className="max-w-2xl font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
          Prices in USD. Billing is not switched on in this release, so no plan is charged and no card is asked for; the prices are what each plan
          costs once it is. Plan limits, such as one broker connection on Starter, are not enforced until then either. Items marked Planned are not
          in this release. Broker commissions and fees are charged by your broker, never by Nasscord.
          Want the terminal under your own brand? That is white-label, part of the tenant program.
        </p>
      ) : null}
    </div>
  );
}
