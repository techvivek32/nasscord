import type { Metadata } from "next";
import { BROKERS, BROKER_STATUS } from "@/lib/brokers";
import type { BrokerStatus } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, Section, SectionHead } from "@/components/marketing/container";
import { BrokerGrid, BrokerLegend } from "@/components/marketing/broker-grid";
import { CapabilityMatrix } from "@/components/marketing/capability-matrix";
import { CtaBand } from "@/components/marketing/cta-band";
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

export default function BrokersPage() {
  return (
    <>
      <Section className="pt-12 sm:pt-20">
        <Container className="grid gap-10">
          <SectionHead
            as="h1"
            eyebrow="Brokers"
            title="Every US broker you hold, one connection each."
            lede="Twelve brokers in the registry today. The status on each tile tells you exactly what the connection can do, and the capability matrix below says it in one table."
            className="mb-0 sm:mb-0"
          />
          <BrokerLegend />
        </Container>
      </Section>

      {GROUPS.map((g, i) => {
        const list = BROKERS.filter((b) => b.status === g.status);
        return (
          <Section key={g.status} id={g.status} className={i % 2 === 0 ? "bg-card/40" : undefined}>
            <Container className="grid gap-6">
              <div className="grid max-w-2xl gap-2">
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{g.title}</h2>
                  <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground tabular">{list.length}</span>
                </div>
                <p className="text-sm text-muted-foreground">{BROKER_STATUS[g.status].description}</p>
                <p className="text-base leading-relaxed text-muted-foreground">{g.intro}</p>
              </div>
              {list.length > 0 ? (
                <BrokerGrid brokers={list} />
              ) : (
                <p className="rounded-xl border border-dashed border-input px-6 py-10 text-center text-sm text-muted-foreground">No brokers in this group right now.</p>
              )}
            </Container>
          </Section>
        );
      })}

      <Section>
        <Container className="grid gap-8">
          <SectionHead eyebrow="Capabilities" title="What each connection can do." lede="Trading, options, extended hours and paper accounts, straight from the broker registry the terminal uses." className="mb-0 sm:mb-0" />
          <CapabilityMatrix />
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Extended hours means orders between 04:00 and 09:30 or 16:00 and 20:00 ET. Outside regular hours Nasscord forces limit orders regardless of the broker. Paper means a
            simulated account the broker provides; Nasscord also offers its own paper mode for every broker.
          </p>
        </Container>
      </Section>

      <Section className="bg-card/40">
        <Container className="grid gap-10 lg:grid-cols-[1fr_minmax(0,22rem)] lg:gap-16">
          <div className="grid gap-8">
            <SectionHead eyebrow="How it works" title="How a connection works." lede="Four steps, all of them on the broker's terms." className="mb-0 sm:mb-0" />
            <NumberedSteps steps={CONNECT_STEPS} />
          </div>
          <Card className="h-fit gap-4">
            <CardHeader>
              <CardTitle className="text-base font-semibold">What a connection can never do</CardTitle>
              <CardDescription>Limits that hold for every broker.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2 text-sm text-muted-foreground">
                <li>Move money in or out of a brokerage account.</li>
                <li>Change the account owner, beneficiaries or bank links.</li>
                <li>Act after you revoke the grant at the broker.</li>
                <li>Share a session with another workspace or another user.</li>
              </ul>
            </CardContent>
          </Card>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
          <SectionHead eyebrow="Missing one?" title="Request a broker." lede="We prioritize by how many traders ask and by whether the broker publishes an API." className="mb-0 sm:mb-0" />
          <RequestBrokerForm />
        </Container>
      </Section>

      <CtaBand title="Connect your first broker in about two minutes." lede="Starter includes one broker connection, free. Pro connects them all." />
    </>
  );
}
