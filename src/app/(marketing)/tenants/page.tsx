import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { COMMISSION_PCT, TENANT_OFFERS, WHITE_LABEL_FEE } from "@/lib/plans";
import type { TenantOfferId } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Container, PageHero, PaperCard, Section, SectionHead } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";
import { reveal } from "@/components/marketing/motion";
import { CommissionCard } from "@/components/marketing/page-visuals";
import { EXAMPLE_BRANDING, TENANT_ANCHOR, TENANT_OFFER_BADGE, WhiteLabelPreview } from "@/components/marketing/tenant-offers";
import { TenantApplyForm } from "@/components/marketing/tenant-apply-form";
import { RevenueCalculator } from "@/components/marketing/revenue-calculator";
import { NumberedSteps } from "@/components/marketing/steps";

export const metadata: Metadata = {
  title: "Tenant program",
  description: `Become a Nasscord tenant: bring traders with your own code and earn ${COMMISSION_PCT}% lifetime commission on their subscriptions once billing is on, and apply for white-label to run the terminal under your own brand.`,
};

const DETAILS: Record<TenantOfferId, { bestFor: string; paragraphs: string[]; youGet: string[]; apply: string }> = {
  commission: {
    bestFor: "Newsletter authors, YouTubers, Discord communities, advisory firms and anyone traders already listen to.",
    paragraphs: [
      `Every tenant earns commission. Give traders your code or your link; a trader who signs up with it joins your tenant, and you earn ${COMMISSION_PCT}% of their subscription for as long as they stay, not just the first year.`,
      "Billing is not switched on in this release, so no subscription is charged and no commission is earned or paid out yet. Commission statements and payouts start when billing does.",
      "Traders who join through you use the same terminal as everyone else, and the tenant portal shows your code, your link and the traders who signed up with them. No fee to join, no minimum volume.",
    ],
    youGet: ["A referral code and a link of your own", "The traders who joined with your code, in the tenant portal", `${COMMISSION_PCT}% for as long as the trader stays, once billing is on`],
    apply: "Apply as a tenant",
  },
  white_label: {
    bestFor: "Advisory firms, trading educators and communities with a paying audience of self-directed traders.",
    paragraphs: [
      "White-label is an add-on to the tenant program. Nasscord reviews each request and turns it on once it is approved; until then you earn commission like every other tenant.",
      "With white-label, your traders see your name and accent colors on every screen of the terminal, and the terminal can run at your own domain once it is set up with Nasscord.",
      `Setting your own plans and prices for your traders needs billing, which is not switched on in this release. Once it is, the platform fee is from $${WHITE_LABEL_FEE}/mo plus per-seat.`,
    ],
    youGet: ["Your name and accent colors on the terminal", "Your own domain", "The branding page in the tenant portal", "Planned: your own plans and prices"],
    apply: "Apply for white-label",
  },
};

const HOW_IT_WORKS = [
  { title: "Apply", body: "A short form below: who you are, how many traders you expect in the first year, and whether you also want white-label." },
  { title: "Review", body: "A person at Nasscord reads every application and replies to the email you give." },
  { title: "Setup", body: "Nasscord creates your tenant with a referral code, and your login opens the tenant portal. If white-label is approved, the branding page opens too." },
  { title: "Traders join", body: "Traders who sign up with your code or link join your tenant and show up in the portal. Commission statements and payouts start when billing does." },
];

export default function TenantProgramPage() {
  return (
    <>
      <PageHero
        eyebrow="Tenant program"
        title={
          <>
            Bring traders. Earn on <em>every one</em>.
          </>
        }
        lede={`Every tenant earns ${COMMISSION_PCT}% commission, for life, on the traders they bring, once billing is switched on. Add white-label to put your own brand on the terminal they use. One application.`}
        actions={
          <>
            <Button size="lg" className="group/cta h-12 rounded-[2px] px-6 text-base" render={<Link href="#apply" />}>
              Apply as a tenant
              <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
            </Button>
            <Link href="#calculator" className="site-link text-base">
              Estimate your commission
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </>
        }
        aside={<CommissionCard pct={COMMISSION_PCT} notes={["Traders join with your code or your link", "Earned once billing is on; nothing is paid out in this release", "White-label available on approval"]} />}
      >
        <nav aria-label="What a tenant gets" className="flex flex-wrap gap-2 pt-2">
          {TENANT_OFFERS.map((m) => (
            <Link key={m.id} href={`#${TENANT_ANCHOR[m.id]}`} className="site-caption border border-foreground px-3 py-1.5 transition-colors hover:bg-foreground hover:text-background hover:no-underline">
              {m.name}
            </Link>
          ))}
        </nav>
      </PageHero>

      {TENANT_OFFERS.map((m, i) => {
        const d = DETAILS[m.id];
        return (
          <Section key={m.id} id={TENANT_ANCHOR[m.id]} tone={i % 2 === 1 ? "band" : "plain"}>
            <Container className="grid gap-14 lg:grid-cols-[1fr_minmax(0,26rem)] lg:gap-20">
              <div className="grid gap-8">
                <div className="grid gap-5" {...reveal()}>
                  <span className="site-label">
                    <span className="mr-3 font-mono tracking-normal text-site-accent-ink">{String(i + 1).padStart(2, "0")}</span>
                    {TENANT_OFFER_BADGE[m.id]}
                  </span>
                  <h2 className="text-6xl leading-none sm:text-7xl">{m.id === "white_label" ? <em className="italic">{m.name}</em> : m.name}</h2>
                  <p className="max-w-2xl text-xl leading-relaxed text-muted-foreground">{m.summary}</p>
                </div>
                <div className="grid max-w-[40rem] gap-4 leading-relaxed text-muted-foreground" {...reveal(100)}>
                  {d.paragraphs.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
                <p className="border-t border-border pt-4" {...reveal(150)}>
                  <span className="site-label mr-2">Best for</span>
                  <span className="text-muted-foreground">{d.bestFor}</span>
                </p>
                {m.id === "white_label" ? (
                  <div className="grid gap-3" {...reveal(200, "scale")}>
                    <span className="site-caption text-muted-foreground">Fig. Example brand, made up for this page: {EXAMPLE_BRANDING.name}</span>
                    <WhiteLabelPreview branding={EXAMPLE_BRANDING} className="max-w-md transition-transform duration-700 hover:-rotate-1" />
                    <p className="font-mono text-[0.7rem] text-muted-foreground">The same components, re-themed through a single accent token. Light and dark accents are set separately.</p>
                  </div>
                ) : null}
              </div>
              <PaperCard className="h-fit p-6 lg:sticky lg:top-28" {...reveal(150, "scale")}>
                <h3 className="text-3xl">What you get</h3>
                <p className="mt-2 font-mono text-sm">{m.pricing}</p>
                <ul className="mt-5 border-t border-foreground">
                  {d.youGet.map((b) => (
                    <li key={b} className="flex gap-3 border-b border-border py-3 text-sm">
                      <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 bg-site-accent" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <Button className="mt-6 h-11 w-full rounded-[2px]" render={<Link href="#apply" />}>
                  {d.apply}
                </Button>
              </PaperCard>
            </Container>
          </Section>
        );
      })}

      <Section>
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={3} eyebrow="How it works" title={<>From application to your first <em>trader</em>.</>} className="mb-0 h-fit sm:mb-0 lg:sticky lg:top-28" />
          <NumberedSteps steps={HOW_IT_WORKS} />
        </Container>
      </Section>

      <Section id="calculator" tone="band">
        <Container className="grid gap-12">
          <SectionHead
            index={4}
            eyebrow="Commission calculator"
            title={<>What your traders <em>earn</em> you.</>}
            lede={`${COMMISSION_PCT}% of subscription revenue, every month, for as long as the traders you brought keep paying. An estimate at list prices: billing is not switched on in this release.`}
            className="mb-0 sm:mb-0"
          />
          <div {...reveal(100, "scale")}>
            <RevenueCalculator />
          </div>
        </Container>
      </Section>

      <Section id="apply">
        <Container className="grid gap-12 lg:grid-cols-[minmax(0,24rem)_1fr] lg:gap-20">
          <SectionHead index={5} eyebrow="Apply" title={<>Tell us about your <em>audience</em>.</>} lede="One form for the tenant program, with a box to tick if you also want white-label. A person reads every application." className="mb-0 h-fit sm:mb-0 lg:sticky lg:top-28" />
          <div {...reveal(100)}>
            <TenantApplyForm />
          </div>
        </Container>
      </Section>

      <CtaBand
        title={<>Already a <em>tenant</em>?</>}
        lede="The tenant portal has your referral code and link, the traders who joined with them and, with white-label, your branding."
        primary={{ label: "Open the tenant portal", href: "/tenant" }}
        secondary={{ label: "Apply as a tenant", href: "#apply" }}
        note="Referrals · Traders · Branding"
      />
    </>
  );
}
