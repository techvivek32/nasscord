import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { fetchTenant } from "@/lib/api";
import { PARTNER_MODELS, REFERRAL_SHARE_PCT } from "@/lib/plans";
import type { PartnerModel } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Container, Section, SectionHead } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";
import { PARTNER_ANCHOR, WhiteLabelPreview } from "@/components/marketing/partner-models";
import { PartnerApplyForm } from "@/components/marketing/partner-apply-form";
import { RevenueCalculator } from "@/components/marketing/revenue-calculator";
import { NumberedSteps } from "@/components/marketing/steps";

export const metadata: Metadata = {
  title: "Partners",
  description: "White-label Nasscord under your brand, earn a 25% lifetime referral share, or embed TradeScope alerts and the verified order engine in your own product.",
};

const DETAILS: Record<PartnerModel, { bestFor: string; paragraphs: string[]; youGet: string[] }> = {
  white_label: {
    bestFor: "Advisory firms, trading educators and communities with a paying audience of self-directed traders.",
    paragraphs: [
      "Your customers sign in at your domain and see your name, your logo tile and your accent color on every screen, every email and every push notification. Nasscord stays invisible.",
      "You choose the plans and prices your customers see. Either we bill them on your behalf and remit your share, or you bill directly and pay a platform fee plus per-seat pricing.",
      "Each white-label tenant gets its own broker gateway pool, so your customers' sessions never share infrastructure with anyone else's.",
    ],
    youGet: ["Custom domain with managed TLS", "Branding: name, accent, emails, login screen", "Your plan catalog and pricing", "Partner console with revenue, seats and support tools", "Dedicated gateway pool"],
  },
  referral: {
    bestFor: "Newsletter authors, YouTubers, Discord communities and anyone traders already listen to.",
    paragraphs: [
      `Share your link or code. When someone you refer becomes a paying customer, you earn ${REFERRAL_SHARE_PCT}% of their subscription for as long as they stay, not just the first year.`,
      "Attribution is tracked from first visit through trial to paid plan with a 90-day window, and you can see every step in the partner portal.",
      "Payouts run monthly by ACH once your balance reaches $100. No fee to join, no minimum volume.",
    ],
    youGet: ["Personal referral link and up to 10 codes", "Clicks, trials and conversions dashboard", "Monthly ACH payouts, $100 minimum", "Lifetime share while the customer stays"],
  },
  embedded: {
    bestFor: "Fintech products, research platforms and trading tools that want alerts and order routing without building broker integrations.",
    paragraphs: [
      "TradeScope alerts, the verified order engine and combined positions are available as REST and streaming APIs. You render them in your product; Nasscord runs the engine and every broker connection.",
      "End users still authorize each broker through OAuth, so your product never touches a broker credential either.",
      "Pricing is usage-based on alerts delivered and orders verified, with solution engineering during integration.",
    ],
    youGet: ["REST and streaming APIs for alerts, orders and positions", "Broker OAuth handled by Nasscord", "Usage-based pricing", "Solution engineering during integration"],
  },
};

const HOW_IT_WORKS = [
  { title: "Apply", body: "Five fields below. Tell us the model you want and roughly how many seats you expect in the first year." },
  { title: "Review call", body: "Within two business days we reply and set up a 30-minute call to confirm fit, compliance posture and timelines." },
  { title: "Setup", body: "White-label partners get a staging tenant with your branding and domain. Referral partners get their link and codes the same day." },
  { title: "Launch and payouts", body: "Go live when you are ready. Revenue, seats and payouts show up in the partner portal from the first customer." },
];

export default async function PartnersPage() {
  const acme = await fetchTenant("acme");

  return (
    <>
      <Section className="pt-12 sm:pt-20">
        <Container className="grid gap-8">
          <SectionHead
            as="h1"
            eyebrow="Partners"
            title="Your brand, our engine."
            lede="Run Nasscord under your own name, earn a lifetime share for traders you refer, or embed the engine in your product. Three models, one application."
            className="mb-0 sm:mb-0"
          />
          <div className="flex flex-wrap gap-3">
            <Button size="lg" render={<Link href="#apply" />}>
              Apply as a partner
            </Button>
            <Button size="lg" variant="outline" render={<Link href="#calculator" />}>
              Estimate referral payout
            </Button>
          </div>
          <nav aria-label="Partner models" className="flex flex-wrap gap-2">
            {PARTNER_MODELS.map((m) => (
              <Link key={m.id} href={`#${PARTNER_ANCHOR[m.id]}`} className="rounded-full border border-input px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground hover:no-underline">
                {m.name}
              </Link>
            ))}
          </nav>
        </Container>
      </Section>

      {PARTNER_MODELS.map((m, i) => {
        const d = DETAILS[m.id];
        return (
          <Section key={m.id} id={PARTNER_ANCHOR[m.id]} className={i % 2 === 0 ? "bg-card/40" : undefined}>
            <Container className="grid gap-10 lg:grid-cols-[1fr_minmax(0,24rem)] lg:gap-16">
              <div className="grid gap-6">
                <div className="grid gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{m.name}</h2>
                    <Badge variant="secondary" className="bg-brand-soft text-primary">
                      {m.pricing}
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
                {m.id === "white_label" && acme?.branding ? (
                  <div className="grid gap-2">
                    <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Example: {acme.branding.name}</span>
                    <WhiteLabelPreview branding={acme.branding} className="max-w-md" />
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
                    Apply for {m.name.toLowerCase()}
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
          <SectionHead eyebrow="Referral calculator" title="What a referral book pays." lede={`${REFERRAL_SHARE_PCT}% of subscription revenue, every month, for as long as the customers you referred keep paying.`} className="mb-0 sm:mb-0" />
          <RevenueCalculator />
        </Container>
      </Section>

      <Section id="apply">
        <Container className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
          <SectionHead eyebrow="Apply" title="Tell us about your audience." lede="One form for all three models. We reply within two business days." className="mb-0 sm:mb-0" />
          <PartnerApplyForm />
        </Container>
      </Section>

      <CtaBand
        title="Already a partner?"
        lede="The partner portal has your referrals, tenants, payouts and branding."
        primary={{ label: "Open the partner portal", href: "/partner" }}
        secondary={{ label: "Apply as a partner", href: "#apply" }}
      />
    </>
  );
}
