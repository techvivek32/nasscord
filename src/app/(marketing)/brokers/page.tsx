import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Ban } from "lucide-react";
import { BROKERS, BROKER_STATUS } from "@/lib/brokers";
import type { BrokerStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Container, PageHero, PaperCard, Section, SectionHead } from "@/components/marketing/container";
import { BrokerGrid, BrokerLegend } from "@/components/marketing/broker-grid";
import { CapabilityMatrix } from "@/components/marketing/capability-matrix";
import { CtaBand } from "@/components/marketing/cta-band";
import { reveal } from "@/components/marketing/motion";
import { BrokerStatusCard } from "@/components/marketing/page-visuals";
import { RequestBrokerForm } from "@/components/marketing/request-broker-form";
import { NumberedSteps } from "@/components/marketing/steps";

export const metadata: Metadata = {
  title: "Brokers",
  description: "Twelve US brokers, one connection each. Trading through Interactive Brokers, Schwab, E*TRADE, tastytrade, Tradier, Alpaca and TradeStation; Webull in beta; Fidelity and Robinhood as read-only portfolio sync.",
};

const GROUPS: Array<{ status: BrokerStatus; title: string; intro: string }> = [
  {
    status: "live",
    title: "Trading (Live)",
    intro: "Orders, brackets and cancels route through the broker's own API and are verified in its order book before Nasscord reports them.",
  },
  {
    status: "beta",
    title: "Beta",
    intro: "The connection works end to end, but the broker's API still limits which order types are available. We say so on the order ticket.",
  },
  {
    status: "sync",
    title: "Portfolio sync",
    intro: "Positions and balances arrive read-only through a licensed aggregator so they count in your combined book. Orders stay in the broker's own app.",
  },
  {
    status: "soon",
    title: "Coming soon",
    intro: "Integration planned. Request it below and we will email you when it ships.",
  },
];

const CONNECT_STEPS = [
  {
    title: "OAuth redirect",
    body: "Click Connect in the terminal and the broker's own sign-in page opens. You authenticate there, including any second factor the broker requires. Nasscord never sees the password.",
  },
  {
    title: "Permissions",
    body: "The broker shows the scopes Nasscord is asking for: read, trade and, where supported, options. You approve them on the broker's page and can revoke them there at any time.",
  },
  {
    title: "Token refresh",
    body: "The broker returns a short-lived access token plus a refresh token. Both are stored encrypted with your workspace's key and refreshed by the gateway before they expire, so you are not asked to sign in again unless the broker requires it.",
  },
  {
    title: "One IBKR gateway session per login",
    body: "Interactive Brokers works differently: each login runs its own Client Portal gateway process behind a proxy that keeps the browser and the keepalive worker on one session. IBKR sessions renew daily with your login and second factor by design.",
  },
];

const NEVER = [
  "Move money in or out of a brokerage account.",
  "Change the account owner, beneficiaries or bank links.",
  "Act after you revoke the grant at the broker.",
  "Share a session with another workspace or another user.",
];

export default function BrokersPage() {
  return (
    <>
      <PageHero
        eyebrow="Brokers"
        title={
          <>
            Every broker you hold, one <em>connection</em> each.
          </>
        }
        lede={`${BROKERS.length} brokers in the registry today. The status on each one tells you exactly what the connection can do, and the capability matrix below says it in one table.`}
        actions={
          <>
            <Button size="lg" className="group/cta h-12 rounded-[2px] px-6 text-base" render={<Link href="/signup" />}>
              Connect a broker
              <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
            </Button>
            <Link href="#request" className="site-link text-base">
              Request a broker
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </>
        }
        aside={<BrokerStatusCard />}
      >
        <BrokerLegend className="max-w-2xl pt-4" />
      </PageHero>

      {GROUPS.map((g, i) => {
        const list = BROKERS.filter((b) => b.status === g.status);
        return (
          <Section key={g.status} id={g.status} tone={i % 2 === 1 ? "band" : "plain"} className="py-16 sm:py-20">
            <Container className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-16">
              <div className="grid h-fit gap-4 lg:sticky lg:top-28" {...reveal()}>
                <span className="site-label">
                  <span className="mr-3 font-mono tracking-normal text-site-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                  {list.length} {list.length === 1 ? "broker" : "brokers"}
                </span>
                <h2 className="text-5xl leading-none">{g.title}</h2>
                <p className="font-medium">{BROKER_STATUS[g.status].description}</p>
                <p className="leading-relaxed text-muted-foreground">{g.intro}</p>
              </div>
              {list.length > 0 ? (
                <BrokerGrid brokers={list} compact className="h-fit content-start lg:grid-cols-2 xl:grid-cols-2" />
              ) : (
                <p className="border border-dashed border-input px-6 py-10 text-center text-muted-foreground">No brokers in this group right now.</p>
              )}
            </Container>
          </Section>
        );
      })}

      <Section>
        <Container className="grid gap-12">
          <SectionHead index={5} eyebrow="Capabilities" title={<>What each connection can <em>do</em>.</>} lede="Trading, options, extended hours and paper accounts, straight from the broker registry the terminal uses." className="mb-0 sm:mb-0" />
          <div {...reveal(100)}>
            <CapabilityMatrix />
          </div>
          <p className="max-w-2xl font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            Extended hours means orders between 04:00 and 09:30 or 16:00 and 20:00 ET. Outside regular hours Nasscord forces limit orders regardless of the broker. Paper means the broker
            offers a simulated account. In the terminal, paper mode sends the order ticket to your paper accounts only, so practice orders never reach a live account.
          </p>
        </Container>
      </Section>

      <Section tone="band">
        <Container className="grid gap-14 lg:grid-cols-[1fr_minmax(0,24rem)] lg:gap-20">
          <div className="grid gap-12">
            <SectionHead index={6} eyebrow="How it works" title={<>How a connection <em>works</em>.</>} lede="Four steps, all of them on the broker's terms." className="mb-0 sm:mb-0" />
            <NumberedSteps steps={CONNECT_STEPS} />
          </div>
          <PaperCard className="h-fit p-6 lg:sticky lg:top-28" {...reveal(150, "scale")}>
            <h3 className="text-3xl">What a connection can <em className="italic">never</em> do</h3>
            <p className="mt-2 text-sm text-muted-foreground">Limits that hold for every broker.</p>
            <ul className="mt-5 border-t border-foreground">
              {NEVER.map((n) => (
                <li key={n} className="flex gap-3 border-b border-border py-3 text-sm">
                  <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-site-accent-ink" />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </PaperCard>
        </Container>
      </Section>

      <Section id="request">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={7} eyebrow="Missing one?" title={<>Request a <em>broker</em>.</>} lede="We prioritize by how many traders ask and by whether the broker publishes an API." className="mb-0 sm:mb-0" />
          <div {...reveal(100)}>
            <RequestBrokerForm />
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Connect your first broker in about two <em>minutes</em>.</>} lede="Starter includes one broker connection, free. Pro connects them all." />
    </>
  );
}
