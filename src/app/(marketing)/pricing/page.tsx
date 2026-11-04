import type { Metadata } from "next";
import Link from "next/link";
import { COMMISSION_PCT, getPlan } from "@/lib/plans";
import { Container, PageHero, Section, SectionHead } from "@/components/marketing/container";
import { ComparisonTable } from "@/components/marketing/comparison-table";
import { CtaBand } from "@/components/marketing/cta-band";
import { FaqList, type FaqItem } from "@/components/marketing/faq";
import { reveal } from "@/components/marketing/motion";
import { PricingPlans } from "@/components/marketing/pricing-plans";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Starter is free. Pro is $49/mo and Desk is $149/mo at list price, less billed yearly. Billing is not switched on in this release, so no plan is charged. Broker commissions are never marked up.",
};

function buildFaq(): FaqItem[] {
  const starter = getPlan("starter");
  const pro = getPlan("pro");
  const desk = getPlan("desk");
  return [
    {
      q: "Is anything charged today?",
      a: `No. Billing is not switched on in this release, so no plan is charged and no card is asked for. You pick a plan at signup and it is saved on your workspace. The prices on this page are what ${pro.name} and ${desk.name} cost once billing is on.`,
    },
    {
      q: "What do I get in this release?",
      a: "Every plan connects Interactive Brokers and E*TRADE read-only: your accounts, balances, positions, orders and executions in one place, with a switch for which accounts count. Items marked Planned, such as TradeScope alerts, order entry and extra seats, are not switched on yet.",
    },
    {
      q: "What counts as a seat?",
      a: `A seat is a person who can sign in to the workspace. Inviting more people is not in this release, so every workspace has one seat today. ${desk.name} is planned to allow up to ${desk.limits.seats}. Broker accounts are not seats: one person can connect any number of accounts.`,
    },
    {
      q: "Do you charge per broker connection?",
      a: `No. A connection never costs extra. Once billing is on, ${starter.name} covers ${starter.limits.brokers} broker connection and ${pro.name} and above have no connection limit, whether that is two accounts at one broker or one at each. Plan limits are not enforced in this release.`,
    },
    {
      q: "Can I put my own brand on the terminal?",
      a: `Not through a plan. Your own name, domain and accent color is white-label, which is part of the tenant program: tenants bring traders, earn ${COMMISSION_PCT}% of their subscriptions once billing is on, and can apply for white-label on top. Nasscord turns it on after reviewing the application.`,
    },
    {
      q: "Do you take a cut of trades?",
      a: "Never. Nasscord is a flat subscription. Commissions, exchange fees and regulatory fees are set and charged by your broker, and Nasscord neither adds to them nor receives any part of them.",
    },
  ];
}

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title={
          <>
            Simple plans. Your broker bills the <em>commissions</em>.
          </>
        }
        lede="Pick a plan when you sign up. Billing is not switched on in this release, so nothing is charged and no card is asked for."
      />

      <section className="py-16 sm:py-20">
        <Container>
          <PricingPlans />
        </Container>
      </section>

      <Section tone="band">
        <Container className="grid gap-12">
          <SectionHead index={1} eyebrow="Compare" title={<>Every feature, every <em>plan</em>.</>} lede="What works in this release, and what is planned. Limits come straight from the plan definitions." className="mb-0 sm:mb-0" />
          <div {...reveal(100)}>
            <ComparisonTable />
          </div>
          <p className="font-mono text-[0.7rem] text-muted-foreground">
            Enterprise limits are set per contract. White-label pricing is in the{" "}
            <Link href="/tenants#white-label" className="site-link">
              tenant program
            </Link>
            .
          </p>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={2} eyebrow="Pricing questions" title={<>Billing, seats and <em>limits</em>.</>} className="mb-0 h-fit sm:mb-0 lg:sticky lg:top-28" />
          <div {...reveal(100)}>
            <FaqList items={buildFaq()} />
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Start on Starter. Connect your first <em>broker</em>.</>} lede="No card for any plan in this release. Connections are read-only." />
    </>
  );
}
