import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Ban } from "lucide-react";
import { BROKERS, BROKER_STATUS, CONNECTABLE_BROKERS, PLANNED_BROKERS } from "@/lib/brokers";
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

const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export const metadata: Metadata = {
  title: "Brokers",
  description: `${andList(CONNECTABLE_BROKERS.map((b) => b.name))} connect today, read-only: accounts, balances, positions, orders and executions. ${PLANNED_BROKERS.length} more brokers are listed and do not connect yet.`,
};

/** One section per status in use. Only "live" and "soon" have brokers in this release. */
const GROUPS: Array<{ status: BrokerStatus; title: string; intro: string }> = [
  {
    status: "live",
    title: "Connect today",
    intro: "Read-only in this release. Nasscord shows your accounts, balances, positions, orders and executions from these brokers; order entry is switched off, so you keep placing orders in the broker's own app.",
  },
  {
    status: "soon",
    title: "Not available yet",
    intro: "Listed so you can see what is planned. None of these connect in this release, and we do not give dates. Request the one you hold below.",
  },
];

const CONNECT_STEPS = [
  {
    title: "IBKR: start from the terminal",
    body: "On the Brokers page, choose Interactive Brokers, then Live or Paper. Nasscord starts a Client Portal gateway that serves this connection alone.",
  },
  {
    title: "IBKR: log in on IBKR's page",
    body: "A new tab names the Nasscord workspace the login joins, then opens IBKR's own login page. You sign in there with your second factor. The session lasts about a day. IBKR allows one session per username, so opening TWS or the IBKR mobile app with the same username can end it; a separate IBKR username for Nasscord avoids that.",
  },
  {
    title: "E*TRADE: bring your own key",
    body: "E*TRADE gives API keys to individuals for their own account only. You create a consumer key on developer.etrade.com and paste the key and secret into Nasscord. The broker service stores them encrypted.",
  },
  {
    title: "E*TRADE: approve, then reconnect daily",
    body: "You approve Nasscord on E*TRADE's page and paste the verification code back. E*TRADE ends every session at midnight Eastern, so you reconnect once a day.",
  },
];

const NEVER = [
  "Place, change or cancel an order in this release.",
  "Move money in or out of a brokerage account.",
  "Change the account owner, beneficiaries or bank links.",
  "Keep reading after you disconnect it.",
  "Share a session with another workspace or another user.",
];

export default function BrokersPage() {
  return (
    <>
      <PageHero
        eyebrow="Brokers"
        title={
          <>
            {COUNT_WORD[CONNECTABLE_BROKERS.length] ?? CONNECTABLE_BROKERS.length} brokers today. More on the <em>list</em>.
          </>
        }
        lede={`${andList(CONNECTABLE_BROKERS.map((b) => b.name))} connect today, read-only. The other ${PLANNED_BROKERS.length} brokers in the registry are listed so you can see what is planned; none of them connect yet.`}
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
        if (list.length === 0) return null;
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
              <BrokerGrid brokers={list} compact={g.status !== "live"} className="h-fit content-start lg:grid-cols-2 xl:grid-cols-2" />
            </Container>
          </Section>
        );
      })}

      <Section>
        <Container className="grid gap-12">
          <SectionHead index={GROUPS.length + 1} eyebrow="Capabilities" title={<>What each connection can <em>do</em>.</>} lede="What a connection shows in this release, straight from the broker registry the terminal uses." className="mb-0 sm:mb-0" />
          <div {...reveal(100)}>
            <CapabilityMatrix />
          </div>
          <p className="max-w-2xl font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            Order entry is switched off in this release for every broker. Paper login means you can connect a paper account the same way as a live one (IBKR Paper). E*TRADE
            also accepts sandbox developer keys when this server allows them; the sandbox returns E*TRADE&apos;s sample data, not a paper account.
          </p>
        </Container>
      </Section>

      <Section id="how" tone="band">
        <Container className="grid gap-14 lg:grid-cols-[1fr_minmax(0,24rem)] lg:gap-20">
          <div className="grid gap-12">
            <SectionHead index={GROUPS.length + 2} eyebrow="How it works" title={<>How a connection <em>works</em>.</>} lede="Two brokers, two ways in, both on the broker's terms. Neither one gives Nasscord your broker password." className="mb-0 sm:mb-0" />
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
          <SectionHead index={GROUPS.length + 3} eyebrow="Missing one?" title={<>Request a <em>broker</em>.</>} lede="Every request is saved and counted. We prioritize by how many traders ask and by whether the broker publishes an API." className="mb-0 sm:mb-0" />
          <div {...reveal(100)}>
            <RequestBrokerForm />
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Connect your first <em>broker</em>.</>} lede="Starter is free and no card is asked for. Connect Interactive Brokers or E*TRADE, read-only." />
    </>
  );
}
