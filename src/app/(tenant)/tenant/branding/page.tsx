import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { BrandingPage } from "@/components/tenant/branding-form";
import { DEFAULT_BRANDING } from "@/lib/tenant";

export const metadata: Metadata = { title: "Branding · Tenant portal" };

export default function TenantBrandingPage() {
  return (
    <>
      <PageHeader title="Branding" description="Your name, accent colors, domain and support address on the terminal and emails your traders see." />
      <BrandingPage fallback={DEFAULT_BRANDING} />
    </>
  );
}
