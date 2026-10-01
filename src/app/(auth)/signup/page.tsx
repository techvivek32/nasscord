import type { Metadata } from "next";
import { AuthHeader } from "@/app/(auth)/auth-header";
import { SignupWizard } from "@/components/onboarding/signup-wizard";
import { fetchTenant } from "@/lib/api";
import { whiteLabelBranding } from "@/lib/tenant";
import { SIGNUP_TENANT_ID } from "@/components/onboarding/data";

export const metadata: Metadata = {
  title: "Create your workspace",
  description: "Account, workspace, brokers, preferences, ready. About two minutes.",
};

/**
 * Five-step onboarding. The page is a server component: it loads the tenant that the demo
 * tenant code (ACME) resolves to and hands its name, and its brand when it has white-label,
 * to the client wizard.
 */
export default async function SignupPage() {
  const tenant = await fetchTenant(SIGNUP_TENANT_ID);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AuthHeader prompt="Already have an account?" linkLabel="Sign in" href="/login" />
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="mx-auto w-full max-w-6xl">
          <SignupWizard tenantName={tenant?.name ?? "Acme Capital"} tenantBranding={whiteLabelBranding(tenant)} />
        </div>
      </main>
    </div>
  );
}
