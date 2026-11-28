import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { andList, brokerNames, publicBrokers, type PublicAvailability, type PublicBroker } from "@/lib/server/broker-availability";
import { Button } from "@/components/ui/button";
import { Container, Eyebrow, Section, SectionHead, Statement } from "@/components/marketing/container";
import { AvailabilityLegend } from "@/components/marketing/broker-availability";
import { BrokerGrid } from "@/components/marketing/broker-grid";
import { CordCard } from "@/components/marketing/cord-diagram";
import { CtaBand } from "@/components/marketing/cta-band";
import { FaqList, type FaqItem } from "@/components/marketing/faq";
import { Audiences, FeaturesGrid, Principles } from "@/components/marketing/features-grid";
import { delay, reveal } from "@/components/marketing/motion";
import { PlatformSetup } from "@/components/marketing/platform-setup";
import { CountUp } from "@/components/marketing/reveal";
import { RiskCalculator } from "@/components/marketing/risk-calculator";
import { SecurityControlList, SOFTWARE_DISCLAIMER } from "@/components/marketing/security-controls";
import { TenantProgram } from "@/components/marketing/tenant-program";
import { TerminalPreview } from "@/components/marketing/terminal-preview";

/*
 * Which brokers connect today comes from the broker service's own answer (publicBrokers), kept a few
 * minutes, like every other public page: the home page never names a broker as connectable while it
 * is gated, not built or waiting for an approval, and never leaves out one that connects.
 */

const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/** "Interactive Brokers, E*TRADE and Alpaca", or a neutral phrase when nothing connects. */
function connectNames(a: PublicAvailability): string {
  return a.today.length ? brokerNames(a.today, { max: 6 }) : "your broker";
}

export async function generateMetadata(): Promise<Metadata> {
  const a = await publicBrokers();
  return {
    title: { absolute: "Nasscord · One terminal for your US brokers" },
    description: `Connect ${connectNames(a)} and see your accounts, balances, positions, orders and executions in one place. Custody stays at your broker.`,
  };
}

/** A made-up starting point for the sizing example. Not anyone's account and not a recommendation. */
const SIZING_EXAMPLE = { netLiq: 50_000, entry: 100, atr: 1.8, symbol: "the stock" };

const has = (list: PublicBroker[], id: string) => list.some((b) => b.id === id);
const verb = (list: unknown[], one: string, many: string) => (list.length === 1 ? one : many);

/** "Which brokers can I connect?": what connects today, how, and what waits. */
function whichBrokers(a: PublicAvailability): string {
  const out: string[] = [];
  if (a.direct.length) out.push(`${andList(a.direct.map((b) => b.name))} ${verb(a.direct, "connects", "connect")} directly.`);
  if (a.sync.length) out.push(`${andList(a.sync.map((b) => b.name))} ${verb(a.sync, "connects", "connect")} read-only through SnapTrade, a data intermediary.`);
  if (!a.today.length) out.push("No broker connects yet.");
  if (a.soon.length) {
    out.push(
      `The other ${a.soon.length} ${verb(a.soon, "broker", "brokers")} in the registry (${andList(a.soon.map((b) => b.name))}) ${verb(a.soon, "is", "are")} listed but ${verb(a.soon, "does", "do")} not connect yet.`,
    );
  }
  return out.join(" ");
}

/** "Do you store my broker password?": one sentence per way in that is open today. */
function passwordAnswer(a: PublicAvailability): string {
  const out = ["No."];
  if (has(a.direct, "ibkr")) {
    out.push(
      "For Interactive Brokers you log in on IBKR's own page, served by a gateway that runs for your connection alone, with IBKR's second factor; the session lives in that gateway and nothing secret is written to the database.",
    );
  }
  if (has(a.direct, "etrade")) out.push("For E*TRADE you approve Nasscord on E*TRADE's page; Nasscord keeps your developer key and the access token, encrypted with AES-256-GCM, never your password.");
  const keyed = a.direct.filter((b) => b.open[0]?.flow === "api_key");
  if (keyed.length) out.push(`For ${andList(keyed.map((b) => b.name))} you paste an API key of your own account; it is kept encrypted the same way, and every call made with it goes through a fixed list of allowed requests.`);
  const signIn = a.direct.filter((b) => b.open[0]?.flow === "oauth2_platform" || b.open[0]?.flow === "oauth2_user_app");
  if (signIn.length) out.push(`For ${andList(signIn.map((b) => b.name))} you sign in on the broker's own page, and Nasscord keeps only the encrypted access token.`);
  if (a.sync.length) out.push("Through SnapTrade you log in on the broker's own page inside SnapTrade's connection page; Nasscord never sees that password.");
  return out.join(" ");
}

/** "Why do I reconnect so often?": the session rules of the brokers that connect today. */
function reconnectAnswer(a: PublicAvailability): string {
  const out = ["Because the brokers say so."];
  if (has(a.direct, "etrade")) out.push("E*TRADE ends every session at midnight Eastern, so you reconnect once a day.");
  if (has(a.direct, "ibkr")) {
    out.push(
      "An IBKR session lasts about a day, and IBKR allows one session per username: opening TWS or the IBKR mobile app with the same username can end Nasscord's session. A separate IBKR username for Nasscord avoids that.",
    );
  }
  out.push("The terminal shows when each session ends and has a Reconnect button.");
  return out.join(" ");
}

/** "Can I connect a paper account?": the user's own paper accounts that connect today; never sample data. */
function paperAnswer(a: PublicAvailability): string {
  const paper = a.today.filter((b) => b.paperToday);
  const never = "Sample-data environments, such as a broker's sandbox, are for Nasscord's developers only and never connect on this site.";
  if (!paper.length) return `Not yet: no broker that connects today offers your own paper account through Nasscord. ${never}`;
  return `Yes, your own paper account at ${andList(paper.map((b) => b.name))}: choose Paper when you connect. ${never}`;
}

function buildFaq(a: PublicAvailability): FaqItem[] {
  return [
    {
      q: "Which brokers can I connect?",
      a: (
        <>
          {whichBrokers(a)} The{" "}
          <Link href="/brokers" className="site-link">
            brokers page
          </Link>{" "}
          shows what each connection can do and takes requests.
        </>
      ),
    },
    {
      q: "Can I place orders from Nasscord?",
      a: "For IBKR, E*TRADE and Alpaca (API key), yes, once Nasscord switches order entry on for your workspace; it is off by default, and you can ask for it from the Orders page. You preview every order and confirm it before it goes to your broker. Market and Limit orders work at all three; Stop, Stop limit and brackets work where the broker and Nasscord support them, and the order ticket shows what each account takes. E*TRADE takes no bracket orders through its API, and every other broker stays read only, so you place those orders in the broker's own app.",
    },
    {
      q: "Do you store my broker password?",
      a: passwordAnswer(a),
    },
    {
      q: "Why do I reconnect so often?",
      a: reconnectAnswer(a),
    },
    {
      q: "Can I connect a paper account?",
      a: paperAnswer(a),
    },
    {
      q: "What about TradeScope alerts and the scanner?",
      a: "Not in this release. TradeScope alerts are not served yet, and the scanner, watchlist prices and options ideas need a market data feed this release does not have. Those pages in the terminal say so instead of showing numbers.",
    },
  ];
}

function stats(a: PublicAvailability): Array<{ value: number; label: string; suffix?: string; decimals?: number }> {
  return [
    { value: a.today.length, label: "Brokers you can connect today" },
    { value: 0, label: "Broker passwords stored" },
    { value: 1, label: "Gateway per IBKR connection" },
    { value: 256, label: "Bit key on stored broker tokens" },
  ];
}

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
  const a = await publicBrokers();
  const faq = buildFaq(a);
  const names = connectNames(a);
  const word = COUNT_WORD[a.today.length] ?? String(a.today.length);

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
              Connect {names}, then see every account, balance, position, order and execution in one place. Custody stays at your broker, and order
              entry stays off until Nasscord switches it on for your workspace.
            </p>
            <div className="flex animate-site-rise flex-wrap items-center gap-x-8 gap-y-4" style={delay(420)}>
              <Button size="lg" className="group/cta h-12 rounded-[2px] px-6 text-base" render={<Link href="/signup" />}>
                Sign up
                <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
              </Button>
              <Link href="#features" className="site-link text-base">
                What works today
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <dl className="mt-4 grid animate-site-rise grid-cols-2 border-t border-foreground sm:grid-cols-4" style={delay(520)}>
              {stats(a).map((s, i) => (
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

      <Statement caption="No broker passwords stored · Orders only when you confirm them · Custody stays put">
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
              Rows marked Today work for everyone who signs up. Rows marked On request work once Nasscord switches them on for your workspace; you ask from the Orders page after you sign up. Rows marked Not yet are switched off, and the terminal says so where they would be.
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
            title={
              <>
                {word} that {a.today.length === 1 ? "connects" : "connect"} today. More on the <em>list</em>.
              </>
            }
            lede={[
              a.today.length ? `${brokerNames(a.today, { max: 6 })} ${a.today.length === 1 ? "connects" : "connect"} today.` : "No broker connects yet.",
              a.soon.length
                ? a.soon.length === 1
                  ? "The other broker is listed so you can see what is planned; it does not connect yet."
                  : `The other ${a.soon.length} brokers are listed so you can see what is planned; none of them connect yet.`
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            className="mb-0 sm:mb-0"
          />
          <BrokerGrid brokers={a.brokers} />
          <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end" {...reveal()}>
            <AvailabilityLegend availability={a} />
            <Link href="/brokers" className="site-link w-fit">
              All brokers and capabilities
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </Container>
      </Section>

      {/* 08 Tenants */}
      <Section id="tenants">
        <Container>
          <div className="mb-14 grid gap-8 lg:grid-cols-2 lg:items-end">
            <SectionHead index={8} eyebrow="Tenants" title={<>Bring your traders to one <em>terminal</em>.</>} className="mb-0 sm:mb-0" />
            <div className="grid gap-6 lg:justify-self-end" {...reveal(120)}>
              <p className="max-w-[30rem] text-lg leading-relaxed text-muted-foreground">
                Newsletters, educators, communities and advisory firms give traders their own code. The traders who sign up with it join the tenant and show up in its
                portal. White-label is the add-on.
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

      {/* 09 Security */}
      <Section id="security" tone="band">
        <Container className="grid gap-12">
          <SectionHead index={9} eyebrow="Security" title={<>Built like <em>infrastructure</em>.</>} lede="Plain statements about how the system behaves. No badges, no vague promises." className="mb-0 sm:mb-0" />
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

      {/* 10 Questions */}
      <Section id="faq">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={10} eyebrow="Questions" title={<>The things traders ask <em>first</em>.</>} lede="If something is still unclear, the brokers, tenants and security pages go a level deeper." className="mb-0 h-fit sm:mb-0 lg:sticky lg:top-28" />
          <div {...reveal(100)}>
            <FaqList items={faq} />
          </div>
        </Container>
      </Section>

      <CtaBand />
    </>
  );
}
