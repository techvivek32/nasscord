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
  description: "Starter is free. Pro is $49/mo, Desk is $149/mo, both cheaper billed yearly. Enterprise is a custom contract with SSO, a dedicated gateway pool and an SLA. Broker commissions are never marked up.",
};

function buildFaq(): FaqItem[] {
  const starter = getPlan("starter");
  const pro = getPlan("pro");
  const desk = getPlan("desk");
  return [
    {
      q: "Can I change plans later?",
      a: `Yes, at any time from Settings. Upgrades take effect immediately and are prorated. Downgrades take effect at the end of the current period. Moving from ${desk.name} to ${pro.name} keeps your data; seats beyond ${pro.limits.seats} become read-only until you remove them.`,
    },
    {
      q: "What counts as a seat?",
      a: `A seat is a person who can sign in. ${starter.name} and ${pro.name} include ${pro.limits.seats}; ${desk.name} includes up to ${desk.limits.seats}, all trading the same book. Broker accounts are not seats: one person can connect any number of accounts on a paid plan.`,
    },
    {
      q: "Do you charge per broker connection?",
      a: `No. ${starter.name} allows ${starter.limits.brokers} broker connection. ${pro.name} and above allow unlimited connections at no extra cost, whether that is two accounts at one broker or one account at seven.`,
    },
    {
      q: "What happens when the 14-day trial ends?",
      a: `If you added a card, the plan you chose starts billing. If you did not, the workspace drops to ${starter.name}: your connections, history and settings stay, alerts return to a ${starter.limits.alertDelayMin}-minute delay, and only the first connected broker remains active until you pick a plan.`,
    },
    {
      q: "Can I put my own brand on the terminal?",
      a: `Not through a plan. Your own name, domain and accent color is white-label, which is part of the tenant program: tenants bring traders, earn ${COMMISSION_PCT}% of their subscriptions, and can apply for white-label on top. Nasscord turns it on after reviewing the application.`,
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
        lede="Start free with one broker connection. Upgrade when you want real-time alerts and the verified order engine. Cancel any time."
      />

      <section className="py-16 sm:py-20">
        <Container>
          <PricingPlans />
        </Container>
      </section>

      <Section tone="band">
        <Container className="grid gap-12">
          <SectionHead index={1} eyebrow="Compare" title={<>Every feature, every <em>plan</em>.</>} lede="Limits come straight from the plan definitions the billing system uses." className="mb-0 sm:mb-0" />
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
          <SectionHead index={2} eyebrow="Pricing questions" title={<>Billing, seats and <em>trials</em>.</>} className="mb-0 h-fit sm:mb-0 lg:sticky lg:top-28" />
          <div {...reveal(100)}>
            <FaqList items={buildFaq()} />
          </div>
        </Container>
      </Section>

      <CtaBand title={<>Start on Starter. Upgrade when the alerts <em>earn it</em>.</>} lede="No card for the free plan. Paid plans include a 14-day trial." />
    </>
  );
}
