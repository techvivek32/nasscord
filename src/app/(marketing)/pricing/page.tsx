import type { Metadata } from "next";
import Link from "next/link";
import { getPlan } from "@/lib/plans";
import { Container, Section, SectionHead } from "@/components/marketing/container";
import { ComparisonTable } from "@/components/marketing/comparison-table";
import { CtaBand } from "@/components/marketing/cta-band";
import { FaqList, type FaqItem } from "@/components/marketing/faq";
import { PricingPlans } from "@/components/marketing/pricing-plans";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Starter is free. Pro is $49/mo, Desk is $149/mo, both cheaper billed yearly. Enterprise is white-label with custom pricing. Broker commissions are never marked up.",
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
      a: `A seat is a person who can sign in. ${starter.name} and ${pro.name} include ${pro.limits.seats}; ${desk.name} includes up to ${desk.limits.seats} with owner, trader and viewer roles. Broker accounts are not seats: one person can connect any number of accounts on a paid plan.`,
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
      q: "Do you take a cut of trades?",
      a: "Never. Nasscord is a flat subscription. Commissions, exchange fees and regulatory fees are set and charged by your broker, and Nasscord neither adds to them nor receives any part of them.",
    },
  ];
}

export default function PricingPage() {
  return (
    <>
      <Section className="pt-12 sm:pt-20">
        <Container className="grid gap-10">
          <SectionHead as="h1" eyebrow="Pricing" title="Simple plans. Your broker bills the commissions." lede="Start free with one broker connection. Upgrade when you want real-time alerts and the verified order engine. Cancel any time." className="mb-0 sm:mb-0" />
          <PricingPlans />
        </Container>
      </Section>

      <Section className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead eyebrow="Compare" title="Every feature, every plan." lede="Limits come straight from the plan definitions the billing system uses." className="mb-0 sm:mb-0" />
          <ComparisonTable />
          <p className="text-xs text-muted-foreground">
            Enterprise limits are set per contract. Talk to{" "}
            <Link href="/partners" className="text-primary hover:underline">
              partnerships
            </Link>{" "}
            for white-label pricing.
          </p>
        </Container>
      </Section>

      <Section>
        <Container className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
          <SectionHead eyebrow="Pricing FAQ" title="Billing, seats and trials." className="mb-0 sm:mb-0" />
          <FaqList items={buildFaq()} />
        </Container>
      </Section>

      <CtaBand title="Start on Starter. Upgrade when the alerts earn it." lede="No card for the free plan. Paid plans include a 14-day trial." />
    </>
  );
}
