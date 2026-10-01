import type { Metadata } from "next";
import { RadarIcon, ShieldCheckIcon, WalletIcon } from "lucide-react";
import { AuthHeader } from "@/app/(auth)/auth-header";
import { LoginForm, type DemoLogin } from "@/app/(auth)/login/login-form";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DEMO_IDENTITIES } from "@/lib/auth";
import { TRADING_BROKERS } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import type { Role } from "@/lib/types";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Nasscord terminal.",
};

/** The demo buttons, in this order. */
const DEMO_ORDER: Role[] = ["superadmin", "tenant", "trader", "tenant_user"];
const DEMOS: DemoLogin[] = DEMO_ORDER.map((role) => ({ role, name: DEMO_IDENTITIES[role].name, email: DEMO_IDENTITIES[role].email }));

const VALUE_LINES = [
  {
    icon: WalletIcon,
    title: "Every account, one book",
    body: `Combined positions, balances and P&L across Interactive Brokers, Schwab, E*TRADE and ${TRADING_BROKERS.length - 3} more.`,
  },
  {
    icon: RadarIcon,
    title: "Alerts you can act on",
    body: `TradeScope scans ${ENGINE_DEFAULTS.universeSize} symbols every ${ENGINE_DEFAULTS.timeframe.replace("m", " minutes")} and only surfaces scores of ${ENGINE_DEFAULTS.minScore} or higher.`,
  },
  {
    icon: ShieldCheckIcon,
    title: "Orders verified at the broker",
    body: `Brackets go out with the stop at ${ENGINE_DEFAULTS.atrStopMultiple}x ATR and are read back from the broker before they count.`,
  },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const safeNext = typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : undefined;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AuthHeader prompt="New to Nasscord?" linkLabel="Create your workspace" href="/signup" />
      <main className="flex flex-1 items-start px-4 py-8 sm:px-6 lg:items-center lg:px-10 lg:py-12">
        <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-center lg:gap-16">
          {/* key: a failed attempt re-renders the page with ?error=invalid and the form starts over on the credentials view */}
          <LoginForm key={error ?? "clean"} next={safeNext} invalid={error === "invalid"} demos={DEMOS} />

          <aside className="hidden lg:block" aria-label="About Nasscord">
            <div className="grid gap-8 border-l border-border pl-10">
              <div className="grid gap-3">
                <span className="text-xs font-semibold tracking-[0.1em] text-primary uppercase">The cord</span>
                <h2 className="text-3xl font-semibold tracking-tight">One cord to every broker.</h2>
                <p className="max-w-md text-base leading-relaxed text-muted-foreground">
                  Nasscord sits between you and your brokers: one login, every account, one order engine. Your money and your broker passwords never leave the broker.
                </p>
              </div>
              <ul className="grid gap-5">
                {VALUE_LINES.map((v) => (
                  <li key={v.title} className="flex gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-primary">
                      <v.icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="grid gap-0.5">
                      <span className="text-sm font-semibold">{v.title}</span>
                      <span className="text-sm leading-relaxed text-muted-foreground">{v.body}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="grid gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Trading through</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {TRADING_BROKERS.map((b) => (
                    <BrokerMark key={b.id} id={b.id} size="sm" />
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
