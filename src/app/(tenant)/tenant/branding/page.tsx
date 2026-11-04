import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { BrandingForm } from "@/components/tenant/branding-form";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal } from "@/components/tenant/scope";
import { WhiteLabelGate } from "@/components/tenant/white-label-gate";
import { APP_DOMAIN } from "@/lib/branding";

export const metadata: Metadata = { title: "Branding · Tenant portal" };

export default async function TenantBrandingPage() {
  const { session, tenant } = await loadPortal();
  return (
    <>
      <PageHeader title="Branding" description="Your name, accent colors, domain and support address on the terminal your traders see." />
      {!tenant ? (
        <NoTenant session={session} />
      ) : !tenant.whiteLabel ? (
        <WhiteLabelGate title="Branding needs white-label" description="Your traders see the Nasscord brand. Your own name, colors and domain are part of white-label." />
      ) : (
        <BrandingForm tenantId={tenant.id} tenantName={tenant.name} branding={tenant.branding ?? null} appDomain={APP_DOMAIN} />
      )}
    </>
  );
}
