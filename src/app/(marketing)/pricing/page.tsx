import type { Metadata } from "next";
import { PageHero } from "@/components/marketing/container";
import { CtaBand } from "@/components/marketing/cta-band";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Pricing is coming soon. You can sign up and connect your brokers now.",
};

/** Nasscord has no plans or prices for now: the page says so, and the sign-up band below it stays. */
export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title={
          <>
            Pricing is coming <em>soon</em>.
          </>
        }
        lede="You can sign up and connect your brokers now."
      />
      <CtaBand />
    </>
  );
}
