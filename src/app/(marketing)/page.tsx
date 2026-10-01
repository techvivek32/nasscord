import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { fetchAlerts, fetchConnections, fetchPositions, fetchTenant } from "@/lib/api";
import { BROKERS, PLANNED_BROKERS, SYNC_BROKERS, TRADING_BROKERS } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { COMMISSION_PCT, getPlan } from "@/lib/plans";
import { whiteLabelBranding } from "@/lib/tenant";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, Section, SectionHead } from "@/components/marketing/container";
import { BrokerGrid, BrokerLegend } from "@/components/marketing/broker-grid";
import { BrokerStrip } from "@/components/marketing/broker-strip";
import { CordDiagram } from "@/components/marketing/cord-diagram";
import { CtaBand } from "@/components/marketing/cta-band";
import { FaqList, type FaqItem } from "@/components/marketing/faq";
import { FeaturesGrid } from "@/components/marketing/features-grid";
import { PricingPlans } from "@/components/marketing/pricing-plans";
import { SecurityControlList, SOFTWARE_DISCLAIMER } from "@/components/marketing/security-controls";
import { NumberedSteps } from "@/components/marketing/steps";
import { TenantOfferCards } from "@/components/marketing/tenant-offers";
import { TerminalPreview } from "@/components/marketing/terminal-preview";

export const metadata: Metadata = {
  title: { absolute: "Nasscord · One terminal for every US broker" },
  description:
    "Connect Interactive Brokers, Schwab, E*TRADE and more in minutes. TradeScope alerts, a verified order engine, risk sizing and one combined account view.",
};

const TRUST = ["No broker passwords stored", "OAuth per broker", "Custody stays at your broker", "Setup in about 2 minutes"];

const STEPS = [
  { title: "Create your account", body: "Email and a password with 2FA. The Starter plan is free and needs no card." },
  { title: "Connect your brokers", body: "Each broker opens its own sign-in page and hands Nasscord a scoped token. Pick which accounts join the combined book." },
  { title: "Trade from one screen", body: "Alerts, orders, positions and P&L for every account in one terminal, on desktop and on your phone." },
];

const FOUR_SETUPS = [
  { was: "Broker gateway", now: "Started for you, one session per login, kept alive." },
  { was: "Proxy", now: "Sits between the browser and the gateway so both share one session." },
  { was: "Terminal", now: "The web terminal you see. Same components on mobile." },
  { was: "Alert engine", now: "TradeScope runs server-side and delivers to the terminal, push and email." },
];

function buildFaq(): FaqItem[] {
  const starter = getPlan("starter");
  const pro = getPlan("pro");
  const live = TRADING_BROKERS.filter((b) => b.status === "live").map((b) => b.name);
  const beta = TRADING_BROKERS.filter((b) => b.status === "beta").map((b) => b.name);
  return [
    {
      q: "Which brokers can place orders?",
      a: (
        <>
          Orders route through the broker API at {live.slice(0, -1).join(", ")} and {live.at(-1)}. {beta.join(", ")} is in beta with limit and market orders.{" "}
          {SYNC_BROKERS.map((b) => b.name).join(" and ")} publish no trading API, so their positions and balances sync read-only.{" "}
          {PLANNED_BROKERS.map((b) => b.name).join(" and ")} are planned. The{" "}
          <Link href="/brokers" className="text-primary hover:underline">
            brokers page
          </Link>{" "}
          has the capability matrix.
        </>
      ),
    },
    {
      q: "Do you store my broker password?",
      a: "No. Every broker connection is an OAuth grant made on the broker's own sign-in page; Nasscord receives a scoped token and stores it encrypted with a per-workspace key. Interactive Brokers additionally requires its own gateway login with a second factor, which you complete on IBKR's page each session. Revoking access at the broker ends the connection immediately.",
    },
    {
      q: "Can I use my own brand?",
      a: (
        <>
          Yes, as a tenant with white-label. It puts your name, domain, accent color and email templates on the terminal your traders use while Nasscord
          runs the engine and the broker connections, and you set the plans and prices they see. White-label is an add-on that Nasscord turns on after
          reviewing your application; every tenant earns {COMMISSION_PCT}% commission either way. See{" "}
          <Link href="/tenants#white-label" className="text-primary hover:underline">
            white-label for tenants
          </Link>
          .
        </>
      ),
    },
    {
      q: "What does the alert engine actually do?",
      a: `TradeScope scans ${ENGINE_DEFAULTS.universeSize} US large caps on ${ENGINE_DEFAULTS.timeframe} bars and scores each one on trend strength (ADX), momentum (RSI), relative volume and breakout structure. A setup becomes an alert only when its score clears ${ENGINE_DEFAULTS.minScore}, and never more than ${ENGINE_DEFAULTS.maxOpen} are open at once. Each alert carries an entry, a stop at ${ENGINE_DEFAULTS.atrStopMultiple}x ATR below entry and a target at ${ENGINE_DEFAULTS.rewardToRisk} times the risk, and the stop trails to breakeven once price moves in your favor. The terminal shows the full backtest, including drawdowns and losing streaks, before you turn alerts on.`,
    },
    {
      q: "Is there a free plan?",
      a: `Yes. ${starter.name} is $${starter.monthly} for as long as you like: ${starter.features[0].toLowerCase()}, ${starter.features[1].toLowerCase()} and ${starter.features[2].toLowerCase()}. ${pro.name} is $${pro.monthly}/mo (or $${pro.yearly}/mo billed yearly) with a 14-day trial, and it unlocks real-time alerts, the verified order engine and unlimited broker connections.`,
    },
    {
      q: "What happens if a broker session drops?",
      a: "The connection shows as Expiring or Disconnected in the terminal and you get a push notification. Working orders are not affected: they live in the broker's order book, not in Nasscord, so brackets keep protecting the position. Alerts keep flowing. Reconnect from Brokers in the terminal; for Interactive Brokers that means a fresh login with your second factor, because IBKR sessions renew daily by design.",
    },
  ];
}

export default async function HomePage() {
  const [alerts, positions, connections, acme] = await Promise.all([fetchAlerts(), fetchPositions(), fetchConnections(), fetchTenant("t_acme")]);
  const faq = buildFaq();

  return (
    <>
      {/* 1. Hero */}
      <Section className="pt-12 pb-12 sm:pt-20 sm:pb-16">
        <Container className="grid gap-12 lg:grid-cols-[1.05fr_1fr] lg:items-center">
          <div className="grid gap-6">
            <span className="text-xs font-semibold tracking-[0.1em] text-primary uppercase">One terminal. Every US broker.</span>
            <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">Trade every broker you hold from one terminal.</h1>
            <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
              Connect Interactive Brokers, Schwab, E*TRADE and more in minutes. Get TradeScope alerts, place verified orders with risk-sized quantities and see
              every position in one combined account view.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button size="lg" render={<Link href="/signup" />}>
                Start free
              </Button>
              <Button size="lg" variant="outline" render={<Link href="/app" />}>
                See the terminal
              </Button>
            </div>
            <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2" aria-label="Trust points">
              {TRUST.map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="dotgrid rounded-2xl bg-card p-3 ring-1 ring-foreground/10 sm:p-5">
            <CordDiagram />
          </div>
        </Container>
      </Section>
      <BrokerStrip />

      {/* 2. Platform */}
      <Section id="platform">
        <Container>
          <SectionHead eyebrow="Platform" title="One place, not four." lede="A broker gateway, a proxy, a terminal and an alert engine used to be four separate installs. Now they are one signup." />
          <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
            <NumberedSteps steps={STEPS} />
            <Card className="h-fit gap-4">
              <CardHeader>
                <CardTitle className="text-base font-semibold">What used to take four setups</CardTitle>
                <CardDescription>Each piece still exists. You just never install, configure or restart any of it.</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="divide-y divide-border">
                  {FOUR_SETUPS.map((row) => (
                    <div key={row.was} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[9rem_1fr] sm:gap-4">
                      <dt className="font-mono text-xs font-medium tracking-wide text-muted-foreground uppercase">{row.was}</dt>
                      <dd className="text-sm">{row.now}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          </div>
        </Container>
      </Section>

      {/* 3. Features */}
      <Section>
        <Container>
          <SectionHead eyebrow="What you get" title="Alerts, orders and risk in one loop." lede="Every number below comes from the same engine that runs the terminal, so what you read here is what you get." />
          <FeaturesGrid />
        </Container>
      </Section>

      {/* 4. Product preview */}
      <Section className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead eyebrow="The terminal" title="This is the screen you trade from." lede="Live alerts with their levels, and every position across every broker in one table." className="mb-0 sm:mb-0" />
          <TerminalPreview alerts={alerts.open.slice(0, 2)} positions={positions.slice(0, 5)} brokerCount={connections.length} />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-xl text-sm text-muted-foreground">
              Demo data from a three-broker workspace. Stops sit at {ENGINE_DEFAULTS.atrStopMultiple}x ATR below entry; targets at {ENGINE_DEFAULTS.rewardToRisk} times the risk.
            </p>
            <Button variant="outline" render={<Link href="/app" />}>
              Open the live demo
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </Container>
      </Section>

      {/* 5. Brokers */}
      <Section id="brokers">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Brokers" title="Every US broker you hold, one connection each." lede="Twelve brokers today. Status tells you exactly what each connection can do." className="mb-0 sm:mb-0" />
          <BrokerGrid brokers={BROKERS} />
          <BrokerLegend />
          <Link href="/brokers" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline">
            All brokers and capabilities
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </Container>
      </Section>

      {/* 6. Pricing */}
      <Section id="pricing" className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Pricing" title="Simple plans. Your broker bills the commissions." lede="Start free with one broker. Upgrade when you want real-time alerts and the order engine." className="mb-0 sm:mb-0" />
          <PricingPlans />
          <Link href="/pricing" className="inline-flex w-fit items-center gap-1 text-sm font-medium text-primary hover:underline">
            Compare every plan feature
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </Container>
      </Section>

      {/* 7. Tenants */}
      <Section id="tenants">
        <Container className="grid gap-8">
          <SectionHead
            eyebrow="Tenants"
            title="Bring traders. Earn on every one."
            lede={`Tenants earn ${COMMISSION_PCT}% of the subscriptions of the traders they bring, for as long as those traders stay. Add white-label to run the terminal under your own brand.`}
            className="mb-0 sm:mb-0"
          />
          <TenantOfferCards preview={whiteLabelBranding(acme)} />
          <div>
            <Button size="lg" render={<Link href="/tenants#apply" />}>
              Apply as a tenant
            </Button>
          </div>
        </Container>
      </Section>

      {/* 8. Security */}
      <Section id="security" className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Security" title="Built like infrastructure." lede="Plain statements about how the system behaves. No badges, no vague promises." className="mb-0 sm:mb-0" />
          <SecurityControlList />
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6">
            <p className="max-w-xl text-sm font-medium">{SOFTWARE_DISCLAIMER}</p>
            <Link href="/security" className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
              Read the security overview
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
        </Container>
      </Section>

      {/* 9. FAQ */}
      <Section id="faq">
        <Container className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
          <SectionHead eyebrow="FAQ" title="Questions traders ask before connecting." className="mb-0 sm:mb-0" />
          <FaqList items={faq} />
        </Container>
      </Section>

      {/* 10. Final CTA */}
      <CtaBand />
    </>
  );
}
