import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, BookOpenCheck, Eye, Handshake, Landmark, LineChart, Scale, Store } from "lucide-react";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { COMMISSION_PCT } from "@/lib/plans";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

interface Feature {
  code: string;
  title: string;
  body: string;
  href: string;
}

/** Feature copy reads its numbers from lib/engine so the site never drifts from the terminal. */
const FEATURES: Feature[] = [
  { code: "F/01", title: "TradeScope alerts", body: `${ENGINE_DEFAULTS.universeSize} large caps on ${ENGINE_DEFAULTS.timeframe} bars. Only scores of ${ENGINE_DEFAULTS.minScore} and up, never more than ${ENGINE_DEFAULTS.maxOpen} open.`, href: "/app" },
  { code: "F/02", title: "Verified orders", body: "Prompts answered, then found in the broker's order book before it is called working.", href: "/security#control-verify" },
  { code: "F/03", title: "Risk sizing", body: `Stop at ${ENGINE_DEFAULTS.atrStopMultiple}x ATR, target at ${ENGINE_DEFAULTS.rewardToRisk} R, about 1% of the account at risk.`, href: "#try-it" },
  { code: "F/04", title: "One combined book", body: "Positions, P&L, cash and buying power from every account in one view.", href: "/app/positions" },
  { code: "F/05", title: "Options desk", body: "Call ideas on the top alerts, sized from the premium at risk.", href: "/app/options" },
  { code: "F/06", title: "Scanner and watchlist", body: `Your own ADX, RSI and volume filters across the ${ENGINE_DEFAULTS.universeSize}-symbol universe, and the symbols you follow with any open alert.`, href: "/app/scanner" },
  { code: "F/07", title: "Paper mode", body: "Practice against a paper account before real money. Leaving paper mode asks you to confirm.", href: "/app" },
  { code: "F/08", title: "History and analysis", body: "Every execution by trading day, the equity curve, daily P&L and the engine's full backtest.", href: "/app/analysis" },
  { code: "F/09", title: "On your phone", body: "The terminal works on a phone, and alerts arrive by push and email with entry, stop and target already worked out.", href: "/app" },
];

/** Features as ruled rows: mono code, serif title, one line, an arrow that slides on hover. */
export function FeaturesGrid({ className }: { className?: string }) {
  return (
    <ul className={cn("border-t border-foreground", className)}>
      {FEATURES.map((f, i) => (
        <li key={f.code} {...reveal(i * 60)}>
          <Link
            href={f.href}
            className="group/f grid grid-cols-[3.5rem_1fr_auto] items-baseline gap-x-4 gap-y-1 border-b border-border py-6 transition-colors hover:bg-site-band/60 hover:no-underline md:grid-cols-[4.5rem_minmax(0,22rem)_1fr_auto] md:gap-x-8"
          >
            <span className="font-mono text-xs text-site-accent-ink">{f.code}</span>
            <span className="font-serif text-3xl leading-tight text-foreground transition-transform duration-300 group-hover/f:translate-x-1.5 sm:text-4xl">{f.title}</span>
            <span className="col-start-2 text-muted-foreground md:col-start-3 md:row-start-1">{f.body}</span>
            <ArrowRight aria-hidden="true" className="col-start-3 row-start-1 size-5 self-center text-foreground transition-transform duration-300 group-hover/f:translate-x-1.5 md:col-start-4 md:row-start-1" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

interface Principle {
  icon: LucideIcon;
  label: string;
  body: string;
  link: { label: string; href: string };
}

const PRINCIPLES: Principle[] = [
  { icon: Landmark, label: "Custody stays put", body: "Your money never leaves your broker. Nasscord holds a scoped token, never a password, and cannot move funds.", link: { label: "How connections work", href: "/brokers" } },
  { icon: Eye, label: "Honest numbers", body: "The backtest is published as measured, losing streaks and drawdown included, before you turn a single alert on.", link: { label: "See the engine", href: "/#platform" } },
  { icon: BookOpenCheck, label: "One book, every broker", body: "Every account at every broker rolls up into one set of positions and one P&L, with the broker on every row.", link: { label: "Browse brokers", href: "/brokers" } },
  { icon: Scale, label: "Risk first", body: "Every ticket starts from the stop. Quantity follows from what you are willing to lose, not from a hunch.", link: { label: "Try the sizing", href: "#try-it" } },
];

/** Four principles: a large icon, a ruled uppercase label, a short paragraph and a link. */
export function Principles({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8", className)}>
      {PRINCIPLES.map((p, i) => (
        <div key={p.label} className="group/p grid content-start gap-5" {...reveal(i * 90)}>
          <p.icon aria-hidden="true" strokeWidth={1.6} className="size-12 transition-transform duration-500 group-hover/p:-rotate-6" />
          <h3 className="site-label border-b border-foreground pb-3 font-sans">{p.label}</h3>
          <p className="leading-relaxed text-muted-foreground">{p.body}</p>
          <Link href={p.link.href} className="site-link w-fit text-sm">
            {p.link.label}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      ))}
    </div>
  );
}

interface Audience {
  icon: LucideIcon;
  label: string;
  title: React.ReactNode;
  body: string;
  link: { label: string; href: string };
}

/** Who the product is for, in the words of its roles: traders, tenants, and the traders a tenant brings. */
const AUDIENCES: Audience[] = [
  {
    icon: LineChart,
    label: "Traders",
    title: <>Trade every account from <em>one</em> screen.</>,
    body: "Sign up directly, connect your brokers and trade from one terminal with alerts, verified orders and one combined book. Starter is free.",
    link: { label: "Start free", href: "/signup" },
  },
  {
    icon: Handshake,
    label: "Tenants",
    title: <>Bring traders, earn <em>{COMMISSION_PCT}%</em> for life.</>,
    body: `Newsletters, educators, communities and advisory firms that bring traders earn ${COMMISSION_PCT}% of their subscriptions for as long as they stay, and can apply for white-label on top.`,
    link: { label: "The tenant program", href: "/tenants" },
  },
  {
    icon: Store,
    label: "Their traders",
    title: <>The same terminal, in the tenant&apos;s <em>brand</em>.</>,
    body: "Traders who join with a tenant's code get the full terminal. When the tenant has white-label, they sign in at the tenant's domain and see its name and colors.",
    link: { label: "How white-label works", href: "/tenants#white-label" },
  },
];

/** Three ruled columns: who Nasscord is for. */
export function Audiences({ className }: { className?: string }) {
  return (
    <div className={cn("grid border-t border-foreground md:grid-cols-3", className)}>
      {AUDIENCES.map((a, i) => (
        <div key={a.label} className={cn("group/aud grid content-start gap-5 py-8 md:py-10", i > 0 ? "border-t border-border md:border-t-0 md:border-l md:pl-8" : "md:pr-8", i === 1 && "md:pr-8")} {...reveal(i * 100)}>
          <div className="flex items-center gap-3">
            <a.icon aria-hidden="true" strokeWidth={1.6} className="size-7 text-site-accent transition-transform duration-500 group-hover/aud:-rotate-6" />
            <span className="site-label">{a.label}</span>
          </div>
          <h3 className="text-4xl leading-[1.02] [&_em]:italic">{a.title}</h3>
          <p className="leading-relaxed text-muted-foreground">{a.body}</p>
          <Link href={a.link.href} className="site-link w-fit text-sm">
            {a.link.label}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </div>
      ))}
    </div>
  );
}
