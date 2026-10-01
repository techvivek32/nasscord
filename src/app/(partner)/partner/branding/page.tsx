import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { BrandingPage } from "@/components/partner/branding-form";

export const metadata: Metadata = { title: "Branding · Partners" };

export default function PartnerBrandingPage() {
  return (
    <>
      <PageHeader title="Branding" description="Your name, accent colors, domain and support address across the terminal and emails." />
      <BrandingPage />
    </>
  );
}
