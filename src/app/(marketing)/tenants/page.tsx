import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { fetchTenant } from "@/lib/api";
import { COMMISSION_PCT, TENANT_OFFERS, WHITE_LABEL_FEE } from "@/lib/plans";
import { whiteLabelBranding } from "@/lib/tenant";
import type { TenantOfferId } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, Section, SectionHead } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";
import { TENANT_ANCHOR, TENANT_OFFER_BADGE, WhiteLabelPreview } from "@/components/marketing/tenant-offers";
import { TenantApplyForm } from "@/components/marketing/tenant-apply-form";
import { RevenueCalculator } from "@/components/marketing/revenue-calculator";
import { NumberedSteps } from "@/components/marketing/steps";

export const metadata: Metadata = {
  title: "Tenant program",
  description: `Become a Nasscord tenant: earn ${COMMISSION_PCT}% lifetime commission on the traders you bring, and apply for white-label to run the terminal under your own brand.`,
};

const DETAILS: Record<TenantOfferId, { bestFor: string; paragraphs: string[]; youGet: string[]; apply: string }> = {
  commission: {
    bestFor: "Newsletter authors, YouTubers, Discord communities, advisory firms and anyone traders already listen to.",
    paragraphs: [
      `Every tenant earns commission. Share your link or code; when a trader you bring becomes a paying customer, you earn ${COMMISSION_PCT}% of their subscription for as long as they stay, not just the first year.`,
      "Traders who join through you trade from the same terminal as everyone else and show up in your tenant portal. Attribution is tracked from first visit through trial to paid plan with a 90-day window.",
      "Payouts run monthly by ACH once your balance reaches $100. No fee to join, no minimum volume.",
    ],
    youGet: ["Personal referral link and up to 10 codes", "Clicks, trials and conversions in the tenant portal", "Monthly ACH payouts, $100 minimum", `${COMMISSION_PCT}% for as long as the trader stays`],
    apply: "Apply as a tenant",
  },
  white_label: {
    bestFor: "Advisory firms, trading educators and communities with a paying audience of self-directed traders.",
    paragraphs: [
      "White-label is an add-on to the tenant program. Nasscord reviews each request and turns it on once it is approved; until then you earn commission like every other tenant.",
      "Your traders sign in at your domain and see your name, your logo tile and your accent color on every screen, every email and every push notification. Nasscord stays invisible.",
      `You choose the plans and prices your traders see. Either we bill them on your behalf and remit your share, or you bill directly and pay the platform fee, from $${WHITE_LABEL_FEE}/mo, plus per-seat pricing.`,
      "Each white-label tenant gets its own broker gateway pool, so your traders' sessions never share infrastructure with anyone else's.",
    ],
    youGet: ["Custom domain with managed TLS", "Branding: name, accent, emails, login screen", "Your plan catalog and pricing", "Branding and plans pages in the tenant portal", "Dedicated gateway pool"],
    apply: "Apply for white-label",
  },
};

const HOW_IT_WORKS = [
  { title: "Apply", body: "A short form below: who you are, how many traders you expect in the first year, and whether you also want white-label." },
  { title: "Review call", body: "Within two business days we reply and set up a 30-minute call to confirm fit, compliance posture and timelines." },
  { title: "Setup", body: "Every tenant gets a referral link, codes and the tenant portal the same day. If white-label is approved, you also get a staging terminal with your branding and domain." },
  { title: "Launch and payouts", body: "Go live when you are ready. Traders, commission and payouts show up in the tenant portal from the first trader." },
];

export default async function TenantProgramPage() {
  const acme = await fetchTenant("t_acme");
  const preview = whiteLabelBranding(acme);

  return (
    <>
      <Section className="pt-12 sm:pt-20">
        <Container className="grid gap-8">
          <SectionHead
            as="h1"
            eyebrow="Tenant program"
            title="Bring traders. Earn on every one."
            lede={`Every tenant earns ${COMMISSION_PCT}% commission, for life, on the traders they bring. Add white-label to put your own brand on the terminal they trade from. One application.`}
            className="mb-0 sm:mb-0"
          />
          <div className="flex flex-wrap gap-3">
            <Button size="lg" render={<Link href="#apply" />}>
              Apply as a tenant
            </Button>
            <Button size="lg" variant="outline" render={<Link href="#calculator" />}>
              Estimate your commission
            </Button>
          </div>
          <nav aria-label="What a tenant gets" className="flex flex-wrap gap-2">
            {TENANT_OFFERS.map((m) => (
              <Link key={m.id} href={`#${TENANT_ANCHOR[m.id]}`} className="rounded-full border border-input px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground hover:no-underline">
                {m.name}
              </Link>
            ))}
          </nav>
        </Container>
      </Section>

      {TENANT_OFFERS.map((m, i) => {
        const d = DETAILS[m.id];
        return (
          <Section key={m.id} id={TENANT_ANCHOR[m.id]} className={i % 2 === 0 ? "bg-card/40" : undefined}>
            <Container className="grid gap-10 lg:grid-cols-[1fr_minmax(0,24rem)] lg:gap-16">
              <div className="grid gap-6">
                <div className="grid gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{m.name}</h2>
                    <Badge variant="secondary" className="bg-brand-soft text-primary">
                      {TENANT_OFFER_BADGE[m.id]}
                    </Badge>
                  </div>
                  <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">{m.summary}</p>
                </div>
                <div className="grid gap-4 text-sm leading-relaxed text-muted-foreground">
                  {d.paragraphs.map((p) => (
                    <p key={p}>{p}</p>
                  ))}
                </div>
                <p className="text-sm">
                  <span className="font-semibold">Best for: </span>
                  <span className="text-muted-foreground">{d.bestFor}</span>
                </p>
                {m.id === "white_label" && preview ? (
                  <div className="grid gap-2">
                    <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Example: {preview.name}</span>
                    <WhiteLabelPreview branding={preview} className="max-w-md" />
                    <p className="text-xs text-muted-foreground">The same components, re-themed through a single accent token. Light and dark accents are set separately.</p>
                  </div>
                ) : null}
              </div>
              <Card className="h-fit gap-4">
                <CardHeader>
                  <CardTitle className="text-base font-semibold">What you get</CardTitle>
                  <CardDescription>{m.pricing}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  <ul className="grid gap-2 text-sm">
                    {d.youGet.map((b) => (
                      <li key={b} className="flex gap-2">
                        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  <Button variant="outline" className="w-full" render={<Link href="#apply" />}>
                    {d.apply}
                  </Button>
                </CardContent>
              </Card>
            </Container>
          </Section>
        );
      })}

      <Section>
        <Container className="grid gap-10 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
          <SectionHead eyebrow="How it works" title="From application to first payout." className="mb-0 sm:mb-0" />
          <NumberedSteps steps={HOW_IT_WORKS} />
        </Container>
      </Section>

      <Section id="calculator" className="bg-card/40">
        <Container className="grid gap-8">
          <SectionHead
            eyebrow="Commission calculator"
            title="What your traders earn you."
            lede={`${COMMISSION_PCT}% of subscription revenue, every month, for as long as the traders you brought keep paying.`}
            className="mb-0 sm:mb-0"
          />
          <RevenueCalculator />
        </Container>
      </Section>

      <Section id="apply">
        <Container className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
          <SectionHead eyebrow="Apply" title="Tell us about your audience." lede="One form for the tenant program, with a box to tick if you also want white-label. We reply within two business days." className="mb-0 sm:mb-0" />
          <TenantApplyForm />
        </Container>
      </Section>

      <CtaBand
        title="Already a tenant?"
        lede="The tenant portal has your referrals, traders, payouts and, with white-label, your branding."
        primary={{ label: "Open the tenant portal", href: "/tenant" }}
        secondary={{ label: "Apply as a tenant", href: "#apply" }}
      />
    </>
  );
}
