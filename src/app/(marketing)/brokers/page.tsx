import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Ban } from "lucide-react";
import { BROKER_STATUS } from "@/lib/brokers";
import { brokerNames, publicBrokers, type PublicAvailability, type PublicBroker } from "@/lib/server/broker-availability";
import type { BrokerStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Container, PageHero, PaperCard, Section, SectionHead } from "@/components/marketing/container";
import { AvailabilityCard, AvailabilityLegend } from "@/components/marketing/broker-availability";
import { BrokerGrid } from "@/components/marketing/broker-grid";
import { CapabilityMatrix } from "@/components/marketing/capability-matrix";
import { CtaBand } from "@/components/marketing/cta-band";
import { reveal } from "@/components/marketing/motion";
import { RequestBrokerForm } from "@/components/marketing/request-broker-form";
import { NumberedSteps, type Step } from "@/components/marketing/steps";

const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/*
 * Which brokers connect today comes from the broker service's own answer (publicBrokers), kept a few
 * minutes, so this page never lists a broker as connectable while it is gated, not built or waiting for
 * an approval. When the service cannot be asked, the static release status in src/lib/brokers.ts is used.
 */

export async function generateMetadata(): Promise<Metadata> {
  const a = await publicBrokers();
  const today = a.today.length
    ? `${brokerNames(a.today, { max: 6 })} ${a.today.length === 1 ? "connects" : "connect"} today: accounts, balances, positions, orders and executions.`
    : "No broker connects yet.";
  const soon = a.soon.length ? ` ${a.soon.length} more ${a.soon.length === 1 ? "broker is" : "brokers are"} listed and wait for an approval.` : "";
  return { title: "Brokers", description: `${today}${soon}` };
}

/** One section per status in use. */
const GROUPS: Array<{ status: BrokerStatus; title: string; intro: string }> = [
  {
    status: "live",
    title: "Connect today",
    intro: "Nasscord shows your accounts, balances, positions, orders and executions from these brokers. Order entry for IBKR, E*TRADE and Alpaca (API key) is switched on per workspace by Nasscord; until then, and for every other broker, you place orders in the broker's own app.",
  },
  {
    status: "sync",
    title: "Read-only through SnapTrade",
    intro: "SnapTrade is a data intermediary. You log in on the broker's own page inside SnapTrade's connection page and choose the accounts, and SnapTrade passes the data on to Nasscord. How fresh it is follows SnapTrade's sync, and the terminal shows when it was last updated.",
  },
  {
    status: "soon",
    title: "Not available yet",
    intro: "Listed so you can see what is planned. Each one waits for an approval: from the broker, or from SnapTrade for the brokers Nasscord reads through it. We do not give dates. Request the one you hold below.",
  },
];

/** Brokers Nasscord does not plan to connect, and why. */
const NOT_OFFERED = [
  { name: "Vanguard", why: "SnapTrade reaches it only with your Vanguard password typed into SnapTrade's page. Nasscord does not ask for broker passwords." },
  { name: "Merrill and Firstrade", why: "The only way in for a platform today is Plaid, which shows no orders, so Nasscord could not show your book in full." },
  { name: "Public with a personal key", why: "Anyone holding that key can place trades. Public is planned through SnapTrade instead." },
  { name: "Moomoo through OpenD", why: "It needs a gateway logged in with your Moomoo password. Moomoo is planned through SnapTrade instead." },
];

const NEVER = [
  "Place or cancel an order you did not confirm, or change an existing order.",
  "Move money in or out of a brokerage account.",
  "Change the account owner, beneficiaries or bank links.",
  "Keep reading after you disconnect it.",
  "Share a session with another workspace or another user.",
];

const flowOf = (b: PublicBroker) => b.open[0]?.flow;

/** "How a connection works", one or two steps per way in that is open today. */
function connectSteps(a: PublicAvailability): Step[] {
  const has = (id: string) => a.direct.some((b) => b.id === id);
  const steps: Step[] = [];
  if (has("ibkr")) {
    steps.push(
      {
        title: "IBKR: start from the terminal",
        body: "On the Brokers page, choose Interactive Brokers, then Live or Paper. Nasscord starts a Client Portal gateway that serves this connection alone.",
      },
      {
        title: "IBKR: log in on IBKR's page",
        body: "A new tab names the Nasscord workspace the login joins, then opens IBKR's own login page. You sign in there with your second factor. The session lasts about a day. IBKR allows one session per username, so opening TWS or the IBKR mobile app with the same username can end it; a separate IBKR username for Nasscord avoids that.",
      },
    );
  }
  if (has("etrade")) {
    steps.push(
      {
        title: "E*TRADE: bring your own key",
        body: "E*TRADE gives API keys to individuals for their own account only. You create a consumer key on developer.etrade.com and paste the key and secret into Nasscord. The broker service stores them encrypted.",
      },
      {
        title: "E*TRADE: approve, then reconnect daily",
        body: "You approve Nasscord on E*TRADE's page and paste the verification code back. E*TRADE ends every session at midnight Eastern, so you reconnect once a day.",
      },
    );
  }
  const alpaca = a.direct.find((b) => b.id === "alpaca");
  if (alpaca && flowOf(alpaca) === "api_key") {
    steps.push({
      title: "Alpaca: paste your own API key",
      body: "Generate a key for your live account or one of your paper accounts at app.alpaca.markets and paste the Key ID and Secret. Alpaca keys can trade: Nasscord sends an order only when order entry is on for your workspace and you confirm it, and keeps the key encrypted. Regenerate the key in Alpaca to revoke it everywhere.",
    });
  }
  const signIn = a.direct.filter((b) => flowOf(b) === "oauth2_platform");
  if (signIn.length) {
    steps.push({
      title: `${brokerNames(signIn, { short: true, max: 3 })}: sign in on the broker's page`,
      body: "You sign in on the broker's own page and approve read-only access. The broker returns you to one fixed Nasscord address, and Nasscord never sees your password.",
    });
  }
  const ownApp = a.direct.filter((b) => flowOf(b) === "oauth2_user_app");
  if (ownApp.length) {
    steps.push({
      title: `${brokerNames(ownApp, { short: true, max: 3 })}: your own developer app`,
      body: "You create an app or key at the broker with Nasscord's callback address, paste its key and secret into Nasscord, then sign in on the broker's own page.",
    });
  }
  if (a.sync.length) {
    steps.push({
      title: `${brokerNames(a.sync, { short: true, max: 3 })}: through SnapTrade`,
      body: "SnapTrade's connection page opens with your broker already chosen. You log in on the broker's own page and pick the accounts to share. The connection is read only.",
    });
  }
  return steps;
}

export default async function BrokersPage() {
  const a = await publicBrokers();
  const groups = GROUPS.map((g) => ({ ...g, list: a.brokers.filter((b) => b.status === g.status || (g.status === "live" && b.status === "beta")) })).filter((g) => g.list.length > 0);
  const steps = connectSteps(a);
  const paper = a.today.filter((b) => b.paperToday);
  const word = COUNT_WORD[a.today.length] ?? String(a.today.length);
  const ctaNames = a.today.length && a.today.length <= 3 ? `Connect ${brokerNames(a.today, { joiner: "or" })}.` : "Connect your broker.";

  return (
    <>
      <PageHero
        eyebrow="Brokers"
        title={
          <>
            {word} {a.today.length === 1 ? "broker" : "brokers"} today. More on the <em>list</em>.
          </>
        }
        lede={[
          a.today.length ? `${brokerNames(a.today, { max: 6 })} ${a.today.length === 1 ? "connects" : "connect"} today.` : "No broker connects yet.",
          a.soon.length
            ? `The other ${a.soon.length} ${a.soon.length === 1 ? "broker" : "brokers"} in the registry ${a.soon.length === 1 ? "waits" : "wait"} for an approval from the broker or from SnapTrade, and ${a.soon.length === 1 ? "does" : "do"} not connect yet.`
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
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
        aside={<AvailabilityCard availability={a} />}
      >
        <AvailabilityLegend availability={a} className="max-w-2xl pt-4" />
      </PageHero>

      {groups.map((g, i) => (
        <Section key={g.status} id={g.status} tone={i % 2 === 1 ? "band" : "plain"} className="py-16 sm:py-20">
          <Container className="grid gap-10 lg:grid-cols-[minmax(0,22rem)_1fr] lg:gap-16">
            <div className="grid h-fit gap-4 lg:sticky lg:top-28" {...reveal()}>
              <span className="site-label">
                <span className="mr-3 font-mono tracking-normal text-site-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                {g.list.length} {g.list.length === 1 ? "broker" : "brokers"}
              </span>
              <h2 className="text-5xl leading-none">{g.title}</h2>
              <p className="font-medium">{BROKER_STATUS[g.status].description}</p>
              <p className="leading-relaxed text-muted-foreground">{g.intro}</p>
              {g.status === "soon" ? (
                <div className="grid gap-3 border-t border-border pt-4">
                  <h3 className="site-caption text-muted-foreground">Not planned</h3>
                  <ul className="grid gap-3 text-sm">
                    {NOT_OFFERED.map((n) => (
                      <li key={n.name} className="grid gap-0.5">
                        <span className="font-medium">{n.name}</span>
                        <span className="leading-relaxed text-muted-foreground">{n.why}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <BrokerGrid brokers={g.list} compact={g.status !== "live"} className="h-fit content-start lg:grid-cols-2 xl:grid-cols-2" />
          </Container>
        </Section>
      ))}

      <Section>
        <Container className="grid gap-12">
          <SectionHead index={groups.length + 1} eyebrow="Capabilities" title={<>What each connection can <em>do</em>.</>} lede="What a connection shows in this release, from the same broker registry the terminal uses." className="mb-0 sm:mb-0" />
          <div {...reveal(100)}>
            <CapabilityMatrix brokers={a.brokers} />
          </div>
          <p className="max-w-2xl font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            Order entry works for IBKR, E*TRADE and Alpaca (API key) in workspaces where Nasscord switches it on: Market and Limit orders at all three, plus Stop, Stop limit and brackets where the broker and Nasscord support them. E*TRADE takes no bracket orders through its API. Every other broker is read only.{" "}
            {paper.length ? `Paper login means your own paper account connects the same way as a live one (${brokerNames(paper, { short: true })}). ` : ""}
            Sample-data environments, such as E*TRADE&apos;s sandbox, are for Nasscord&apos;s developers only and never connect on this site.
          </p>
        </Container>
      </Section>

      {steps.length ? (
        <Section id="how" tone="band">
          <Container className="grid gap-14 lg:grid-cols-[1fr_minmax(0,24rem)] lg:gap-20">
            <div className="grid gap-12">
              <SectionHead
                index={groups.length + 2}
                eyebrow="How it works"
                title={<>How a connection <em>works</em>.</>}
                lede="Every way in follows the broker's own rules, and none of them gives Nasscord your broker password."
                className="mb-0 sm:mb-0"
              />
              <NumberedSteps steps={steps} />
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
      ) : null}

      <Section id="request">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead
            index={groups.length + (steps.length ? 3 : 2)}
            eyebrow="Missing one?"
            title={<>Request a <em>broker</em>.</>}
            lede="Every request is saved and counted. We prioritize by how many traders ask and by whether the broker publishes an API."
            className="mb-0 sm:mb-0"
          />
          <div {...reveal(100)}>
            <RequestBrokerForm />
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Connect your first <em>broker</em>.</>} lede={`No card is asked for. ${ctaNames}`} />
    </>
  );
}
