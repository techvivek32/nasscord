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
  /** "today" works in this release; "later" is not switched on yet and says why. */
  status: "today" | "later";
  href?: string;
}

const STATUS_LABEL: Record<Feature["status"], string> = { today: "Today", later: "Not yet" };

/** What the product does in this release, and what it does not do yet. Engine numbers come from lib/engine. */
const FEATURES: Feature[] = [
  { code: "F/01", status: "today", title: "Connect IBKR", body: "Log in on IBKR's own page, live or paper. Nasscord runs a dedicated gateway session for your connection.", href: "/brokers#how" },
  { code: "F/02", status: "today", title: "Connect E*TRADE", body: "Use your own E*TRADE developer key and approve Nasscord on E*TRADE. Sessions end at midnight Eastern.", href: "/brokers#how" },
  { code: "F/03", status: "today", title: "One combined book", body: "Accounts, balances and positions from every connected account in one view, with the broker on every row.", href: "/signup" },
  { code: "F/04", status: "today", title: "Orders and executions", body: "Your orders and executions straight from your brokers, read-only, next to the account they belong to.", href: "/signup" },
  { code: "F/05", status: "today", title: "Risk sizing", body: "The order ticket works out a quantity from your stop and your net liquidation. It does not place the order.", href: "#try-it" },
  { code: "F/06", status: "later", title: "Order entry", body: "Placing orders from Nasscord is switched off in this release. Use your broker's own app for now." },
  {
    code: "F/07",
    status: "later",
    title: "TradeScope alerts",
    body: `The alert engine (${ENGINE_DEFAULTS.universeSize} large caps on ${ENGINE_DEFAULTS.timeframe} bars, scores of ${ENGINE_DEFAULTS.minScore} and up) is not served in this release.`,
  },
  { code: "F/08", status: "later", title: "Prices, scanner and options ideas", body: "These need a market data feed, which this release does not have." },
  { code: "F/09", status: "later", title: "More brokers", body: "Schwab, tastytrade and the rest of the registry are listed but do not connect yet.", href: "/brokers#soon" },
];

/** Features as ruled rows: mono code and status, serif title, one line, an arrow that slides on hover when it links. */
export function FeaturesGrid({ className }: { className?: string }) {
  const row = "grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-x-4 gap-y-1 border-b border-border py-6 md:grid-cols-[6rem_minmax(0,22rem)_1fr_auto] md:gap-x-8";
  return (
    <ul className={cn("border-t border-foreground", className)}>
      {FEATURES.map((f, i) => {
        const inner = (
          <>
            <span className="row-span-2 grid content-start gap-1.5 md:row-span-1">
              <span className="font-mono text-xs text-site-accent-ink">{f.code}</span>
              <span className={cn("site-caption w-fit border px-1.5 py-px", f.status === "today" ? "border-site-accent text-site-accent-ink" : "border-border text-muted-foreground")}>
                {STATUS_LABEL[f.status]}
              </span>
            </span>
            <span
              className={cn(
                "font-serif text-3xl leading-tight transition-transform duration-300 sm:text-4xl",
                f.status === "today" ? "text-foreground" : "text-muted-foreground",
                f.href && "group-hover/f:translate-x-1.5",
              )}
            >
              {f.title}
            </span>
            <span className="col-start-2 text-muted-foreground md:col-start-3 md:row-start-1">{f.body}</span>
            {f.href ? (
              <ArrowRight aria-hidden="true" className="col-start-3 row-start-1 size-5 self-center text-foreground transition-transform duration-300 group-hover/f:translate-x-1.5 md:col-start-4 md:row-start-1" />
            ) : null}
          </>
        );
        return (
          <li key={f.code} {...reveal(i * 60)}>
            {f.href ? (
              <Link href={f.href} className={cn("group/f transition-colors hover:bg-site-band/60 hover:no-underline", row)}>
                {inner}
              </Link>
            ) : (
              <div className={row}>{inner}</div>
            )}
          </li>
        );
      })}
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
  { icon: Landmark, label: "Custody stays put", body: "Your money never leaves your broker. Nasscord stores no broker password, has no way to move funds and, in this release, places no orders.", link: { label: "How connections work", href: "/brokers#how" } },
  { icon: Eye, label: "Honest numbers", body: "Every balance, position, order and execution in the terminal comes from your broker. Where there is no source yet, the page says so instead of filling in numbers.", link: { label: "What works today", href: "/#features" } },
  { icon: BookOpenCheck, label: "One book, every account", body: "Every account you include at IBKR and E*TRADE rolls up into one set of positions, with the broker on every row.", link: { label: "Browse brokers", href: "/brokers" } },
  { icon: Scale, label: "Risk first", body: "The order ticket starts from the stop. Quantity follows from what you are willing to lose, not from a hunch.", link: { label: "Try the sizing", href: "#try-it" } },
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
    title: <>See every account on <em>one</em> screen.</>,
    body: "Sign up, connect Interactive Brokers or E*TRADE, and see your accounts, balances, positions, orders and executions in one place. Starter is free.",
    link: { label: "Start free", href: "/signup" },
  },
  {
    icon: Handshake,
    label: "Tenants",
    title: <>Bring traders, earn <em>{COMMISSION_PCT}%</em> for life.</>,
    body: `Newsletters, educators, communities and advisory firms give traders their own code. Once billing is on, they earn ${COMMISSION_PCT}% of those traders' subscriptions for as long as they stay, and can apply for white-label on top.`,
    link: { label: "The tenant program", href: "/tenants" },
  },
  {
    icon: Store,
    label: "Their traders",
    title: <>The same terminal, in the tenant&apos;s <em>brand</em>.</>,
    body: "Traders who join with a tenant's code get the same terminal. When Nasscord has turned on white-label for the tenant, they see its name and accent colors.",
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
