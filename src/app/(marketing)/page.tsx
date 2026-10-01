import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fetchAlerts, fetchConnections, fetchPositions, fetchTenant } from "@/lib/api";
import { BROKERS, PLANNED_BROKERS, SYNC_BROKERS, TRADING_BROKERS } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { COMMISSION_PCT, getPlan } from "@/lib/plans";
import { whiteLabelBranding } from "@/lib/tenant";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow, Section, SectionHead, Statement } from "@/components/marketing/container";
import { BrokerGrid, BrokerLegend } from "@/components/marketing/broker-grid";
import { CordCard } from "@/components/marketing/cord-diagram";
import { CtaBand } from "@/components/marketing/cta-band";
import { FaqList, type FaqItem } from "@/components/marketing/faq";
import { Audiences, FeaturesGrid, Principles } from "@/components/marketing/features-grid";
import { delay, reveal } from "@/components/marketing/motion";
import { PlatformSetup } from "@/components/marketing/platform-setup";
import { PricingPlans } from "@/components/marketing/pricing-plans";
import { CountUp } from "@/components/marketing/reveal";
import { RiskCalculator } from "@/components/marketing/risk-calculator";
import { SecurityControlList, SOFTWARE_DISCLAIMER } from "@/components/marketing/security-controls";
import { TenantProgram } from "@/components/marketing/tenant-program";
import { programFor } from "@/components/tenant/program";
import { TerminalPreview } from "@/components/marketing/terminal-preview";

export const metadata: Metadata = {
  title: { absolute: "Nasscord · One terminal for every US broker" },
  description:
    "Connect Interactive Brokers, Schwab, E*TRADE and more in minutes. TradeScope alerts, a verified order engine, risk sizing and one combined account view.",
};


/** "Live positions and P&L" -> "live positions and P&L": lower-case the first letter only. */
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "A, B and C". */
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

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
          <Link href="/brokers" className="site-link">
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
          <Link href="/tenants#white-label" className="site-link">
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
      q: "Can I practice before using real money?",
      a: `Yes. Switch the terminal to paper mode and the order ticket only offers your paper accounts, so practice orders never reach a live one; leaving paper mode asks you to confirm. ${andList(BROKERS.filter((b) => b.capabilities.paper).map((b) => b.name))} offer paper accounts, and they connect like any other account.`,
    },
    {
      q: "Is there a free plan?",
      a: `Yes. ${starter.name} is $${starter.monthly} for as long as you like: ${lcFirst(starter.features[0])}, ${lcFirst(starter.features[1])} and ${lcFirst(starter.features[2])}. ${pro.name} is $${pro.monthly}/mo (or $${pro.yearly}/mo billed yearly) with a 14-day trial, and it unlocks real-time alerts, the verified order engine and unlimited broker connections.`,
    },
    {
      q: "What happens if a broker session drops?",
      a: "The connection shows as Expiring or Disconnected in the terminal and you get a push notification. Working orders are not affected: they live in the broker's order book, not in Nasscord, so brackets keep protecting the position. Alerts keep flowing. Reconnect from Brokers in the terminal; for Interactive Brokers that means a fresh login with your second factor, because IBKR sessions renew daily by design.",
    },
  ];
}

const STATS = [
  { value: BROKERS.length, label: "US brokers" },
  { value: ENGINE_DEFAULTS.universeSize, label: "Symbols scanned" },
  { value: ENGINE_DEFAULTS.atrStopMultiple, decimals: 1, suffix: "x", label: "ATR stop" },
  { value: COMMISSION_PCT, suffix: "%", label: "Tenant commission" },
];

/** Hairlines for the 2x2 (phone) / 1x4 (wider) stat strip. */
function statCell(i: number) {
  return [
    "border-border py-4",
    i % 2 === 1 ? "border-l pl-4" : "pr-4",
    i >= 2 && "border-t sm:border-t-0",
    i === 2 && "sm:border-l sm:pl-4",
  ]
    .filter(Boolean)
    .join(" ");
}

export default async function HomePage() {
  const [alerts, positions, connections, acme] = await Promise.all([fetchAlerts(), fetchPositions(), fetchConnections(), fetchTenant("t_acme")]);
  const faq = buildFaq();
  const lead = alerts.open[0];
  const account = connections[0]?.accounts[0];

  return (
    <>
      {/* Hero: the message on the left, the broker chart on its dot-grid card to the right */}
      <section className="relative border-b border-border py-16 sm:py-24">
        <Container className="grid gap-14 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-center lg:gap-12">
          <div className="grid content-center gap-8">
            <span className="animate-site-rise">
              <Eyebrow>One terminal · Every US broker</Eyebrow>
            </span>
            <h1 className="text-[clamp(3.75rem,8vw,6.5rem)] leading-[0.88] tracking-[-0.015em]">
              <span className="block animate-site-rise" style={delay(80)}>
                Every broker.
              </span>
              <span className="block animate-site-rise" style={delay(200)}>
                One <em className="italic">terminal</em>.
              </span>
            </h1>
            <p className="max-w-[34rem] animate-site-rise text-lg leading-relaxed text-pretty text-muted-foreground sm:text-xl" style={delay(320)}>
              Connect Interactive Brokers, Schwab, E*TRADE and more in minutes. Act on alerts with verified, risk-sized orders, and see every position in one book.
              Custody stays at your broker.
            </p>
            <div className="flex animate-site-rise flex-wrap items-center gap-x-8 gap-y-4" style={delay(420)}>
              <Button size="lg" className="group/cta h-12 rounded-[2px] px-6 text-base" render={<Link href="/signup" />}>
                Start free
                <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
              </Button>
              <Link href="/app" className="site-link text-base">
                See the terminal
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <dl className="mt-4 grid animate-site-rise grid-cols-2 border-t border-foreground sm:grid-cols-4" style={delay(520)}>
              {STATS.map((s, i) => (
                <div key={s.label} className={statCell(i)}>
                  <dd className="text-4xl leading-none tracking-[-0.03em] tabular sm:text-5xl">
                    <CountUp value={s.value} decimals={s.decimals} suffix={s.suffix} />
                  </dd>
                  <dt className="mt-2 text-sm text-muted-foreground">{s.label}</dt>
                </div>
              ))}
            </dl>
          </div>
          <div className="animate-site-rise" style={delay(260)}>
            <CordCard />
          </div>
        </Container>
      </section>

      <Statement caption="No broker passwords · Orders verified at the broker · Custody stays put">
        Most trading tools are built around one broker. Nasscord is built around <em>you</em>.
      </Statement>

      {/* 01 Who it is for */}
      <Section>
        <Container>
          <SectionHead index={1} eyebrow="Who it's for" title={<>One platform, three ways <em>in</em>.</>} lede="Traders sign up directly. Tenants bring traders and earn on every one. The traders a tenant brings get the same terminal, in the tenant's brand when white-label is on." />
          <Audiences />
        </Container>
      </Section>

      {/* 02 Platform */}
      <Section id="platform">
        <Container>
          <div className="mb-14 grid gap-8 lg:grid-cols-2 lg:items-end">
            <SectionHead index={2} eyebrow="The platform" title={<>One signup. Four systems. About two <em>minutes</em>.</>} className="mb-0 sm:mb-0" />
            <div className="grid gap-5 lg:justify-self-end" {...reveal(120)}>
              <p className="max-w-[30rem] text-lg leading-relaxed text-muted-foreground">
                A broker gateway, a proxy, a terminal and an alert engine used to be four separate installs. Now they are one account, and Nasscord runs all four.
              </p>
              <Link href="/app" className="site-link w-fit">
                Open the live demo
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </div>
          <PlatformSetup brokerCount={connections.length} accountCount={connections.reduce((n, c) => n + c.accounts.length, 0)} />
        </Container>
      </Section>

      {/* 03 Try it */}
      {lead && account ? (
        <Section id="try-it">
          <Container>
            <SectionHead index={3} eyebrow="Try it" title={<>What a 1% risk actually <em>buys</em>.</>} lede="The same arithmetic the order ticket runs. Move the account size, the price or the volatility and watch the stop, target and quantity follow." />
            <div {...reveal(100)}>
              <RiskCalculator defaults={{ netLiq: account.netLiq, entry: lead.entry, atr: lead.atr, symbol: lead.symbol }} />
            </div>
          </Container>
        </Section>
      ) : null}

      {/* 04 Features */}
      <Section>
        <Container>
          <div className="mb-12 grid gap-8 sm:mb-16 lg:grid-cols-2 lg:items-end">
            <SectionHead index={4} eyebrow="Features" title={<>Everything the desk needs, nothing it <em>doesn&apos;t</em>.</>} className="mb-0 sm:mb-0" />
            <p className="max-w-[34rem] text-lg leading-relaxed text-muted-foreground lg:justify-self-end" {...reveal(120)}>
              Every number below comes from the same engine that runs the terminal, so what you read here is what you get.
            </p>
          </div>
          <FeaturesGrid />
        </Container>
      </Section>

      {/* 05 Principles */}
      <Section tone="band">
        <Container>
          <SectionHead index={5} eyebrow="Why Nasscord" title={<>Trading software, minus the <em>sales pitch</em>.</>} />
          <Principles />
        </Container>
      </Section>

      {/* 06 Terminal */}
      <Section>
        <Container className="grid gap-12">
          <SectionHead index={6} eyebrow="The terminal" title={<>This is the screen you <em>trade</em> from.</>} lede="Live alerts with their levels, and every position across every broker in one table." className="mb-0 sm:mb-0" />
          <TerminalPreview alerts={alerts.open.slice(0, 2)} positions={positions.slice(0, 5)} brokerCount={connections.length} />
          <p className="max-w-xl font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            FIG. 2 · Demo data from a three-broker workspace. Stops sit at {ENGINE_DEFAULTS.atrStopMultiple}x ATR below entry; targets at {ENGINE_DEFAULTS.rewardToRisk} times the risk.
          </p>
        </Container>
      </Section>

      {/* 07 Brokers */}
      <Section id="brokers" tone="band">
        <Container className="grid gap-12">
          <SectionHead index={7} eyebrow="Brokers" title={<>Every broker you hold, one <em>connection</em> each.</>} lede={`${BROKERS.length} brokers today. The status on each tells you exactly what the connection can do.`} className="mb-0 sm:mb-0" />
          <BrokerGrid brokers={BROKERS} />
          <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end" {...reveal()}>
            <BrokerLegend />
            <Link href="/brokers" className="site-link w-fit">
              All brokers and capabilities
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </Container>
      </Section>

      {/* 08 Pricing */}
      <Section id="pricing">
        <Container className="grid gap-12">
          <SectionHead index={8} eyebrow="Pricing" title={<>Simple plans. Your broker bills the <em>commissions</em>.</>} lede="Start free with one broker. Upgrade when you want real-time alerts and the order engine." className="mb-0 sm:mb-0" />
          <PricingPlans />
          <Link href="/pricing" className="site-link w-fit">
            Compare every plan feature
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </Container>
      </Section>

      {/* 09 Tenants */}
      <Section id="tenants" tone="band">
        <Container>
          <div className="mb-14 grid gap-8 lg:grid-cols-2 lg:items-end">
            <SectionHead index={9} eyebrow="Tenants" title={<>Bring traders. Earn on <em>every one</em>.</>} className="mb-0 sm:mb-0" />
            <div className="grid gap-6 lg:justify-self-end" {...reveal(120)}>
              <p className="max-w-[30rem] text-lg leading-relaxed text-muted-foreground">
                Newsletters, educators, communities and advisory firms earn {COMMISSION_PCT}% of the subscriptions of the traders they bring, for as long as those traders stay. White-label is the add-on.
              </p>
              <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
                <Button size="lg" className="group/cta h-12 rounded-[2px] px-6 text-base" render={<Link href="/tenants#apply" />}>
                  Apply as a tenant
                  <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
                </Button>
                <Link href="/tenants" className="site-link">
                  The tenant program
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              </div>
            </div>
          </div>
          <TenantProgram preview={whiteLabelBranding(acme)} funnel={acme ? programFor(acme, []).funnel : undefined} tenantName={acme?.name} />
        </Container>
      </Section>

      {/* 10 Security */}
      <Section id="security">
        <Container className="grid gap-12">
          <SectionHead index={10} eyebrow="Security" title={<>Built like <em>infrastructure</em>.</>} lede="Plain statements about how the system behaves. No badges, no vague promises." className="mb-0 sm:mb-0" />
          <SecurityControlList />
          <div className="flex flex-wrap items-center justify-between gap-4" {...reveal()}>
            <p className="max-w-xl font-medium">{SOFTWARE_DISCLAIMER}</p>
            <Link href="/security" className="site-link">
              Read the security overview
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </Container>
      </Section>

      {/* 11 Questions */}
      <Section id="faq">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={11} eyebrow="Questions" title={<>The things traders ask <em>first</em>.</>} lede="If something is still unclear, the brokers, pricing and security pages go a level deeper." className="mb-0 h-fit sm:mb-0 lg:sticky lg:top-28" />
          <div {...reveal(100)}>
            <FaqList items={faq} />
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
