import type { Metadata } from "next";
import { AuthHeader } from "@/app/(auth)/auth-header";
import { SignupWizard } from "@/components/onboarding/signup-wizard";
import { fetchTenant } from "@/lib/api";
import { PARTNER_TENANT_SLUG } from "@/components/onboarding/data";

export const metadata: Metadata = {
  title: "Create your workspace",
  description: "Account, workspace, brokers, preferences, ready. About two minutes.",
};

/**
 * Five-step onboarding. The page is a server component: it loads the white-label partner
 * that the NOVA-PARTNER code resolves to and hands its branding to the client wizard.
 */
export default async function SignupPage() {
  const partner = await fetchTenant(PARTNER_TENANT_SLUG);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AuthHeader prompt="Already have an account?" linkLabel="Sign in" href="/login" />
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="mx-auto w-full max-w-6xl">
          <SignupWizard partnerName={partner?.branding?.name ?? partner?.name ?? "Acme Capital"} partnerBranding={partner?.branding ?? null} />
        </div>
      </main>
    </div>
  );
}
