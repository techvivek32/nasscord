import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, BookOpenCheck, Eye, Handshake, Landmark, LineChart, Scale, Store } from "lucide-react";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { brokerNames, publicBrokers, type PublicAvailability, type PublicBroker } from "@/lib/server/broker-availability";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

interface Feature {
  title: string;
  body: string;
  /** "today" works in this release; "request" works once Nasscord switches it on for a workspace; "later" is not switched on yet and says why. */
  status: "today" | "request" | "later";
  href?: string;
}

const STATUS_LABEL: Record<Feature["status"], string> = { today: "Today", request: "On request", later: "Not yet" };

/** What connecting each broker means, for the brokers with a line of their own. Others use their connect spec's summary. */
const BROKER_LINE: Partial<Record<PublicBroker["id"], string>> = {
  ibkr: "Log in on IBKR's own page, live or paper. Nasscord runs a dedicated gateway session for your connection.",
  etrade: "Use your own E*TRADE developer key and approve Nasscord on E*TRADE. Sessions end at midnight Eastern.",
};

/** At most this many brokers get a "Connect <broker>" row of their own; the rest share one. */
const MAX_BROKER_ROWS = 3;

/**
 * What the product does in this release, and what it does not do yet. The broker rows follow what connects for
 * everyone today (publicBrokers). Engine numbers come from lib/engine.
 */
function features(a: PublicAvailability): Feature[] {
  const own = a.direct.slice(0, MAX_BROKER_ROWS);
  const others = a.direct.slice(MAX_BROKER_ROWS);
  const brokerRows: Feature[] = own.map((b) => ({
    status: "today",
    title: `Connect ${b.short}`,
    body: BROKER_LINE[b.id] ?? `${b.open[0]?.summary ?? ""}`.trim(),
    href: "/brokers#how",
  }));
  if (others.length) {
    brokerRows.push({ status: "today", title: "More direct brokers", body: `${brokerNames(others)} connect directly too.`, href: "/brokers#live" });
  }
  if (a.sync.length) {
    brokerRows.push({
      status: "today",
      title: "Read-only through SnapTrade",
      body: `${brokerNames(a.sync)}: log in on the broker's own page through SnapTrade, a data intermediary. The data follows SnapTrade's sync.`,
      href: "/brokers#sync",
    });
  }
  const later: Feature[] = a.soon.length
    ? [
        {
          status: "later",
          title: "More brokers",
          body: `${brokerNames(a.soon, { max: 3 })} ${a.soon.length === 1 ? "is" : "are"} listed and ${a.soon.length === 1 ? "waits" : "wait"} for an approval from the broker or from SnapTrade.`,
          href: "/brokers#soon",
        },
      ]
    : [];
  return [
    ...brokerRows,
    { status: "today", title: "One combined book", body: "Accounts, balances and positions from every connected account in one view, with the broker on every row.", href: "/signup" },
    { status: "today", title: "Orders and executions", body: "Your orders and executions straight from your brokers, next to the account they belong to.", href: "/signup" },
    { status: "today", title: "Risk sizing", body: "The order ticket works out a quantity from your stop and your net liquidation.", href: "#try-it" },
    {
      status: "request",
      title: "Order entry",
      body: "Preview and confirm Market and Limit orders at IBKR, E*TRADE and Alpaca (API key), plus Stop, Stop limit and brackets where the broker and Nasscord support them; the ticket shows what each account takes. Nasscord switches order entry on per workspace; it is off by default.",
    },
    {
      status: "later",
      title: "TradeScope alerts",
      body: `The alert engine (${ENGINE_DEFAULTS.universeSize} large caps on ${ENGINE_DEFAULTS.timeframe} bars, scores of ${ENGINE_DEFAULTS.minScore} and up) is not served in this release.`,
    },
    { status: "later", title: "Prices, scanner and options ideas", body: "These need a market data feed, which this release does not have." },
    ...later,
  ];
}

/** Features as ruled rows: mono code and status, serif title, one line, an arrow that slides on hover when it links. */
export async function FeaturesGrid({ className }: { className?: string }) {
  const list = features(await publicBrokers());
  const row = "grid grid-cols-[4.5rem_1fr_auto] items-baseline gap-x-4 gap-y-1 border-b border-border py-6 md:grid-cols-[6rem_minmax(0,22rem)_1fr_auto] md:gap-x-8";
  return (
    <ul className={cn("border-t border-foreground", className)}>
      {list.map((f, i) => {
        const code = `F/${String(i + 1).padStart(2, "0")}`;
        const inner = (
          <>
            <span className="row-span-2 grid content-start gap-1.5 md:row-span-1">
              <span className="font-mono text-xs text-site-accent-ink">{code}</span>
              <span className={cn("site-caption w-fit border px-1.5 py-px", f.status === "today" ? "border-site-accent text-site-accent-ink" : f.status === "request" ? "border-border text-site-accent-ink" : "border-border text-muted-foreground")}>
                {STATUS_LABEL[f.status]}
              </span>
            </span>
            <span
              className={cn(
                "font-serif text-3xl leading-tight transition-transform duration-300 sm:text-4xl",
                f.status === "later" ? "text-muted-foreground" : "text-foreground",
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
          <li key={code} {...reveal(i * 60)}>
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
  { icon: Landmark, label: "Custody stays put", body: "Your money never leaves your broker. Nasscord stores no broker password, has no way to move funds, and sends an order only when you confirm it.", link: { label: "How connections work", href: "/brokers#how" } },
  { icon: Eye, label: "Honest numbers", body: "Every balance, position, order and execution in the terminal comes from your broker. Where there is no source yet, the page says so instead of filling in numbers.", link: { label: "What works today", href: "/#features" } },
  { icon: BookOpenCheck, label: "One book, every account", body: "Every account you include, at every broker you connect, rolls up into one set of positions, with the broker on every row.", link: { label: "Browse brokers", href: "/brokers" } },
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
    body: "Sign up, connect the brokers you hold, and see your accounts, balances, positions, orders and executions in one place.",
    link: { label: "Sign up", href: "/signup" },
  },
  {
    icon: Handshake,
    label: "Tenants",
    title: <>Bring traders with your own <em>code</em>.</>,
    body: "Newsletters, educators, communities and advisory firms give traders their own code. The traders who sign up with it join their tenant and show up in the tenant portal. Tenants can apply for white-label on top.",
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
