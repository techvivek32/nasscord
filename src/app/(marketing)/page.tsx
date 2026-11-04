import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BROKERS, CONNECTABLE_BROKERS, PLANNED_BROKERS } from "@/lib/brokers";
import { COMMISSION_PCT, getPlan } from "@/lib/plans";
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
import { TerminalPreview } from "@/components/marketing/terminal-preview";

/** "A, B and C". */
const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

const CONNECTABLE_NAMES = andList(CONNECTABLE_BROKERS.map((b) => b.name));

export const metadata: Metadata = {
  title: { absolute: "Nasscord · One terminal for your US brokers" },
  description: `Connect ${CONNECTABLE_NAMES} and see your accounts, balances, positions, orders and executions in one place. Read-only in this release; custody stays at your broker.`,
};

/** A made-up starting point for the sizing example. Not anyone's account and not a recommendation. */
const SIZING_EXAMPLE = { netLiq: 50_000, entry: 100, atr: 1.8, symbol: "the stock" };

function buildFaq(): FaqItem[] {
  const starter = getPlan("starter");
  return [
    {
      q: "Which brokers can I connect?",
      a: (
        <>
          {CONNECTABLE_NAMES}, read-only. The other {PLANNED_BROKERS.length} brokers in the registry ({andList(PLANNED_BROKERS.map((b) => b.name))}) are listed but do not connect
          yet. The{" "}
          <Link href="/brokers" className="site-link">
            brokers page
          </Link>{" "}
          shows what each connection can do and takes requests.
        </>
      ),
    },
    {
      q: "Can I place orders from Nasscord?",
      a: "Not in this release. Order entry is switched off: the order ticket works out a size from your stop and shows why it cannot place the order, and nothing is sent to your broker. Keep placing orders in your broker's own app for now.",
    },
    {
      q: "Do you store my broker password?",
      a: "No. For Interactive Brokers you log in on IBKR's own page, served by a gateway that runs for your connection alone, with IBKR's second factor; the session lives in that gateway and nothing secret is written to the database. For E*TRADE you approve Nasscord on E*TRADE's page; Nasscord keeps your developer key and the access token, encrypted with AES-256-GCM, never your password.",
    },
    {
      q: "Why do I reconnect so often?",
      a: "Because the brokers say so. E*TRADE ends every session at midnight Eastern, so you reconnect once a day. An IBKR session lasts about a day, and IBKR allows one session per username: opening TWS or the IBKR mobile app with the same username can end Nasscord's session. A separate IBKR username for Nasscord avoids that. The terminal shows when each session ends and has a Reconnect button.",
    },
    {
      q: "Can I connect a paper account?",
      a: "Yes, for Interactive Brokers: choose Paper when you connect and log in with your paper username. E*TRADE accepts sandbox developer keys when this server allows them; the sandbox returns E*TRADE's sample data rather than a paper account.",
    },
    {
      q: "Is there a free plan?",
      a: `Yes. ${starter.name} is $${starter.monthly}. Billing is not switched on in this release, so no plan is charged, no card is asked for and plan limits are not enforced yet.`,
    },
    {
      q: "What about TradeScope alerts and the scanner?",
      a: "Not in this release. TradeScope alerts are not served yet, and the scanner, watchlist prices and options ideas need a market data feed this release does not have. Those pages in the terminal say so instead of showing numbers.",
    },
  ];
}

const STATS: Array<{ value: number; label: string; suffix?: string; decimals?: number }> = [
  { value: CONNECTABLE_BROKERS.length, label: "Brokers you can connect today" },
  { value: 0, label: "Broker passwords stored" },
  { value: 1, label: "Gateway per IBKR connection" },
  { value: 256, label: "Bit key on stored E*TRADE tokens" },
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

export default function HomePage() {
  const faq = buildFaq();

  return (
    <>
      {/* Hero: the message on the left, the broker chart on its dot-grid card to the right */}
      <section className="relative border-b border-border py-16 sm:py-24">
        <Container className="grid gap-14 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-center lg:gap-12">
          <div className="grid content-center gap-8">
            <span className="animate-site-rise">
              <Eyebrow>One terminal · Your US brokers</Eyebrow>
            </span>
            <h1 className="text-[clamp(3.75rem,8vw,6.5rem)] leading-[0.88] tracking-[-0.015em]">
              <span className="block animate-site-rise" style={delay(80)}>
                Your brokers.
              </span>
              <span className="block animate-site-rise" style={delay(200)}>
                One <em className="italic">terminal</em>.
              </span>
            </h1>
            <p className="max-w-[34rem] animate-site-rise text-lg leading-relaxed text-pretty text-muted-foreground sm:text-xl" style={delay(320)}>
              Connect {CONNECTABLE_NAMES}, then see every account, balance, position, order and execution in one place. Read-only in this release: custody
              and order entry stay at your broker.
            </p>
            <div className="flex animate-site-rise flex-wrap items-center gap-x-8 gap-y-4" style={delay(420)}>
              <Button size="lg" className="group/cta h-12 rounded-[2px] px-6 text-base" render={<Link href="/signup" />}>
                Start free
                <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
              </Button>
              <Link href="#features" className="site-link text-base">
                What works today
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

      <Statement caption="No broker passwords stored · Read-only in this release · Custody stays put">
        Most trading tools are built around one broker. Nasscord is built around <em>you</em>.
      </Statement>

      {/* 01 Who it is for */}
      <Section>
        <Container>
          <SectionHead index={1} eyebrow="Who it's for" title={<>One platform, three ways <em>in</em>.</>} lede="Traders sign up directly. Tenants bring traders with their own code. The traders a tenant brings get the same terminal, in the tenant's brand when white-label is on." />
          <Audiences />
        </Container>
      </Section>

      {/* 02 Platform */}
      <Section id="platform">
        <Container>
          <div className="mb-14 grid gap-8 lg:grid-cols-2 lg:items-end">
            <SectionHead index={2} eyebrow="The platform" title={<>One signup. Every account on one <em>screen</em>.</>} className="mb-0 sm:mb-0" />
            <div className="grid gap-5 lg:justify-self-end" {...reveal(120)}>
              <p className="max-w-[30rem] text-lg leading-relaxed text-muted-foreground">
                A broker gateway, a login proxy, a place for your keys and a terminal used to be separate installs. Now they are one account, and Nasscord runs them.
              </p>
              <Link href="/signup" className="site-link w-fit">
                Create your account
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
          </div>
          <PlatformSetup />
        </Container>
      </Section>

      {/* 03 Features */}
      <Section id="features">
        <Container>
          <div className="mb-12 grid gap-8 sm:mb-16 lg:grid-cols-2 lg:items-end">
            <SectionHead index={3} eyebrow="Features" title={<>What works today, and what does <em>not</em> yet.</>} className="mb-0 sm:mb-0" />
            <p className="max-w-[34rem] text-lg leading-relaxed text-muted-foreground lg:justify-self-end" {...reveal(120)}>
              This release is read-only. Rows marked Today work for everyone who signs up; rows marked Not yet are switched off, and the terminal says so where they would be.
            </p>
          </div>
          <FeaturesGrid />
        </Container>
      </Section>

      {/* 04 Try it */}
      <Section id="try-it">
        <Container>
          <SectionHead
            index={4}
            eyebrow="Try it"
            title={<>How a 1% risk <em>sizes</em> a trade.</>}
            lede="The sizing rule the order ticket uses: quantity follows from the stop, so a stop-out costs 1% of net liquidation at the default risk per trade (you can change it in Settings). The starting values are a made-up example; move them and the stop, target and quantity follow."
          />
          <div {...reveal(100)}>
            <RiskCalculator defaults={SIZING_EXAMPLE} />
          </div>
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
          <SectionHead index={6} eyebrow="The terminal" title={<>Every account, one <em>book</em>.</>} lede="Each connected account with its balances, and every position across them in one table, with the broker on every row." className="mb-0 sm:mb-0" />
          <TerminalPreview />
          <p className="max-w-xl font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            FIG. 2 · An example with made-up figures, not a real account. Once you connect a broker, the terminal shows your own accounts from the broker.
          </p>
        </Container>
      </Section>

      {/* 07 Brokers */}
      <Section id="brokers" tone="band">
        <Container className="grid gap-12">
          <SectionHead
            index={7}
            eyebrow="Brokers"
            title={<>Two that connect today. More on the <em>list</em>.</>}
            lede={`${CONNECTABLE_NAMES} connect today, read-only. The other ${PLANNED_BROKERS.length} brokers are listed so you can see what is planned; none of them connect yet.`}
            className="mb-0 sm:mb-0"
          />
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
          <SectionHead index={8} eyebrow="Pricing" title={<>Simple plans. Your broker bills the <em>commissions</em>.</>} lede="Starter is free. Billing is not switched on in this release, so no plan is charged and no card is asked for." className="mb-0 sm:mb-0" />
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
                Newsletters, educators, communities and advisory firms give traders their own code. Once billing is on, they earn {COMMISSION_PCT}% of those traders&apos; subscriptions for as
                long as they stay. White-label is the add-on.
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
          <TenantProgram />
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
