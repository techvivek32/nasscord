import type { Metadata } from "next";
import { AuthHeader } from "@/app/(auth)/auth-header";
import { NotConfigured } from "@/app/(auth)/not-configured";
import { SignupWizard } from "@/components/onboarding/signup-wizard";
import type { SignupPhase, TenantPreview } from "@/components/onboarding/store";
import { getAuthUser, getSession } from "@/lib/auth";
import { homeForRole } from "@/lib/roles";
import { rateLimit } from "@/lib/server/rate-limit";
import { requestIp } from "@/lib/server/request";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { getTenantByReferralCode, normalizeTenantCode } from "@/lib/tenant-server";

export const metadata: Metadata = {
  title: "Create your workspace",
  description: "Account, workspace, brokers, preferences, ready. About two minutes plus the confirmation email.",
};

/**
 * Five-step onboarding. This server component works out where the user is (signed out, signed in
 * without a workspace, or set up) and resolves a tenant code, from a referral link (?code=ACME) or
 * from the code given at signup, so the wizard can show the tenant's name and white-label preview.
 * A set-up user whose session lacks the role in the members row (app_metadata was never written, or
 * a role change is not in the JWT yet) gets needsSync: the wizard repairs it before going home, which
 * breaks the /app -> /signup -> /app loop the proxy would otherwise run.
 * A code from the URL counts against the same per-address limit as the wizard's code lookup, so the
 * page cannot be used to try codes without one.
 */
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const configured = isSupabaseConfigured();

  let phase: SignupPhase = "account";
  let home = "/app";
  let needsSync = false;
  let prefill: { fullName?: string; email?: string; tenantCode?: string } = {};
  let initialTenant: TenantPreview | null = null;

  if (configured) {
    const user = await getAuthUser();
    if (user) {
      const session = await getSession();
      phase = session ? "continue" : "workspace";
      if (session) {
        home = homeForRole(session.role);
        needsSync = user.claimRole !== session.role;
      }
      prefill = { fullName: user.fullName, email: user.email, ...(user.tenantCode ? { tenantCode: user.tenantCode } : {}) };
    }
    const own = Boolean(prefill.tenantCode);
    const wanted = normalizeTenantCode(prefill.tenantCode ?? code);
    const allowed = own || !wanted || rateLimit(`tenant-code:${(await requestIp()) ?? "unknown"}:`, 40, 10 * 60_000);
    if (wanted && allowed) {
      if (!own) prefill = { ...prefill, tenantCode: wanted };
      const tenant = await getTenantByReferralCode(wanted);
      if (tenant) initialTenant = { code: wanted, name: tenant.name, branding: tenant.whiteLabel && tenant.branding ? tenant.branding : null };
    }
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <AuthHeader prompt="Already have an account?" linkLabel="Sign in" href="/login" />
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
        <div className="mx-auto w-full max-w-6xl">
          {configured ? (
            <SignupWizard phase={phase} prefill={prefill} initialTenant={initialTenant} home={home} needsSync={needsSync} />
          ) : (
            <div className="mx-auto max-w-md">
              <NotConfigured title="Create your workspace" />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
