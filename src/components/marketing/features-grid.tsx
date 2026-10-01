import type { LucideIcon } from "lucide-react";
import { BellRing, BookOpenCheck, Layers, Scale, ShieldCheck, Smartphone } from "lucide-react";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  detail: string;
}

/** Feature copy reads its numbers from lib/engine so the site never drifts from the terminal. */
const FEATURES: Feature[] = [
  {
    icon: BellRing,
    title: "TradeScope alerts",
    body: `Scans ${ENGINE_DEFAULTS.universeSize} US large caps on ${ENGINE_DEFAULTS.timeframe} bars. Only setups that clear the score gate of ${ENGINE_DEFAULTS.minScore} reach you, and never more than ${ENGINE_DEFAULTS.maxOpen} open at once.`,
    detail: 'Every alert explains itself: "Strong uptrend (ADX 31)", "Volume 1.4x average", "Breaking out".',
  },
  {
    icon: ShieldCheck,
    title: "Verified order engine",
    body: "Answers the broker's confirmation prompts for you, then reads the order back from the order book before it tells you the order is working.",
    detail: "One-cancels-all brackets on every entry. Working orders are cancelled before a position is closed.",
  },
  {
    icon: BookOpenCheck,
    title: "Every broker in one book",
    body: "Positions, P&L, cash and buying power from every connected account roll up into one view, with the broker mark on every row.",
    detail: "Include or exclude an account from the combined book with one switch.",
  },
  {
    icon: Scale,
    title: "Risk sizing",
    body: `Quantity is sized so a stop-out costs about 1% of net liquidation, with the stop at ${ENGINE_DEFAULTS.atrStopMultiple}x ATR and a ${ENGINE_DEFAULTS.rewardToRisk} reward-to-risk target.`,
    detail: "Options use fixed capital-risk presets of 0.10, 0.15 or 0.20% of net liquidation.",
  },
  {
    icon: Layers,
    title: "Options desk",
    body: "Chains, greeks and spreads from the brokers that support options, with the same verified order flow and bracket logic as equities.",
    detail: "Contracts are sized from the premium at risk, not from notional.",
  },
  {
    icon: Smartphone,
    title: "Mobile and notifications",
    body: "Alerts arrive by push and email with the entry, stop and target already computed, so acting on one takes two taps.",
    detail: "Extended-hours detection forces limit orders outside 09:30 to 16:00 ET.",
  },
];

export function FeaturesGrid({ className }: { className?: string }) {
  return (
    <ul className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)}>
      {FEATURES.map((f) => (
        <li key={f.title}>
          <Card className="h-full gap-4">
            <CardHeader className="gap-3">
              <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-brand-soft text-primary">
                <f.icon className="size-4.5" />
              </span>
              <CardTitle className="text-base font-semibold">{f.title}</CardTitle>
              <CardDescription className="leading-relaxed">{f.body}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">{f.detail}</p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}
