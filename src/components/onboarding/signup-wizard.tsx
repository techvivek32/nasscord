"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { TriangleAlertIcon } from "lucide-react";
import { TenantTheme } from "@/components/tenant-theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StepProgress, StepRail } from "@/components/onboarding/step-rail";
import { SummaryCard } from "@/components/onboarding/summary-card";
import { StepAccount } from "@/components/onboarding/step-account";
import { StepWorkspace } from "@/components/onboarding/step-workspace";
import { StepBrokers } from "@/components/onboarding/step-brokers";
import { StepPreferences } from "@/components/onboarding/step-preferences";
import { StepReady } from "@/components/onboarding/step-ready";
import { useSignupStore, type AccountDraft, type SignupPhase, type TenantPreview } from "@/components/onboarding/store";
import type { WizardStep } from "@/components/onboarding/data";
import { signOut, syncAccess } from "@/lib/auth-actions";

type AccessState = { status: "pending" } | { status: "ok" } | { status: "failed"; error: string };

/**
 * Root of the signup wizard. The server page says where the user really is (`phase`):
 *  - "account": signed out. Step 1 creates the account and waits for the email confirmation.
 *  - "workspace": signed in from the confirmation link, no workspace yet. Resumes at step 2.
 *  - "continue": the workspace exists. Steps 3 to 5 continue from the saved draft; without one
 *    (another device, or setup already finished) the user goes to `home`. With `needsSync` (the
 *    session lacks the role in the members row) syncAccess first copies the role into the session;
 *    if that fails the user sees why and can retry, instead of bouncing between /signup and /app.
 * Two columns on desktop (rail 280px + step card), stacked on mobile. A tenant code with
 * white-label wraps the step card in that tenant's accent as a live preview.
 */
export function SignupWizard({
  phase,
  prefill,
  initialTenant,
  home,
  needsSync = false,
}: {
  phase: SignupPhase;
  prefill: Partial<AccountDraft>;
  initialTenant: TenantPreview | null;
  home: string;
  needsSync?: boolean;
}) {
  const router = useRouter();
  const [access, setAccess] = React.useState<AccessState>(() => (phase === "continue" && needsSync ? { status: "pending" } : { status: "ok" }));
  const [syncAttempt, setSyncAttempt] = React.useState(0);
  const hydrated = useSignupStore((s) => s.hydrated);
  const step = useSignupStore((s) => s.step);
  const furthest = useSignupStore((s) => s.furthest);
  const created = useSignupStore((s) => s.created);
  const tenant = useSignupStore((s) => s.tenant);
  const tenantCode = useSignupStore((s) => s.account.tenantCode);
  const goTo = useSignupStore((s) => s.goTo);

  const prefillKey = `${prefill.fullName ?? ""}|${prefill.email ?? ""}|${prefill.tenantCode ?? ""}`;
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Manual hydration keeps the first client render identical to the server render.
      await useSignupStore.persist.rehydrate();
      if (cancelled) return;
      const store = useSignupStore.getState();
      if (store.launched) store.reset();
      if (phase === "continue") {
        let target = home;
        if (needsSync) {
          const res = await syncAccess().catch(() => null);
          if (cancelled) return;
          if (!res || !res.ok) {
            setAccess({ status: "failed", error: res && !res.ok ? res.error : "We could not reach Nasscord. Check your connection and try again." });
            return;
          }
          target = res.home;
          setAccess({ status: "ok" });
        }
        const s = useSignupStore.getState();
        if (!s.created || s.step < 3) {
          router.replace(target);
          return;
        }
      }
      useSignupStore.getState().syncPhase(phase, prefill);
      const code = useSignupStore.getState().account.tenantCode.trim().toUpperCase();
      if (initialTenant && initialTenant.code === code) useSignupStore.getState().setTenant(initialTenant);
    })();
    return () => {
      cancelled = true;
    };
    // prefill is compared through prefillKey; initialTenant follows the same server render.
  }, [phase, prefillKey, home, router, needsSync, syncAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeTenant = tenant && tenant.code === tenantCode.trim().toUpperCase() ? tenant : null;
  const branding = activeTenant?.branding ?? null;
  const minStep: WizardStep = created ? 3 : phase === "workspace" ? 2 : 1;

  const stepCard = !hydrated || access.status === "pending" ? (
    <WizardSkeleton />
  ) : access.status === "failed" ? (
    <AccessFailed
      error={access.error}
      onRetry={() => {
        setAccess({ status: "pending" });
        setSyncAttempt((n) => n + 1);
      }}
    />
  ) : step === 1 ? (
    <StepAccount />
  ) : step === 2 ? (
    <StepWorkspace tenantName={activeTenant?.name ?? null} brandActive={branding !== null} />
  ) : step === 3 ? (
    <StepBrokers />
  ) : step === 4 ? (
    <StepPreferences />
  ) : (
    <StepReady tenantName={activeTenant?.name ?? null} brandActive={branding !== null} />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10">
      <aside className="hidden lg:flex lg:flex-col lg:gap-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">Five short steps. Your progress is saved in this browser as you go.</p>
        </div>
        {hydrated ? (
          <>
            <StepRail current={step} furthest={furthest} minStep={minStep} onSelect={goTo} />
            <SummaryCard />
          </>
        ) : (
          <RailSkeleton />
        )}
      </aside>

      <div className="grid gap-4 lg:hidden">
        <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
        {hydrated ? <StepProgress current={step} /> : <Skeleton className="h-9 w-full" />}
      </div>

      <section aria-live="polite" className="min-w-0">
        {branding ? (
          <TenantTheme branding={branding}>
            <div className="grid gap-4">
              {stepCard}
              <p className="text-xs text-muted-foreground">Preview: buttons, links and focus rings use {branding.name}&apos;s accent. Your terminal will look the same.</p>
            </div>
          </TenantTheme>
        ) : (
          stepCard
        )}
        {hydrated ? (
          <div className="mt-6 lg:hidden">
            <SummaryCard />
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** The workspace exists but the session could not be updated with its role. Retry runs syncAccess again. */
function AccessFailed({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <Card role="alert">
      <CardHeader className="gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold tracking-wide text-warn-foreground uppercase">
          <TriangleAlertIcon className="size-4" aria-hidden="true" />
          Sign-in not updated
        </span>
        <CardTitle className="text-lg tracking-tight">We could not open your workspace yet</CardTitle>
        <CardDescription>{error}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        Your workspace and settings are saved. Trying again updates your sign-in so you can open it. If it keeps failing, sign out and sign in again.
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3">
        <form action={signOut}>
          <Button type="submit" variant="outline">
            Sign out
          </Button>
        </form>
        <Button type="button" onClick={onRetry}>
          Try again
        </Button>
      </CardFooter>
    </Card>
  );
}

function WizardSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading your progress">
      <CardHeader className="gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-16 w-full" />
        <div className="flex justify-end">
          <Skeleton className="h-8 w-36" />
        </div>
      </CardContent>
    </Card>
  );
}

function RailSkeleton() {
  return (
    <div className="grid gap-6" aria-hidden="true">
      <div className="grid gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 px-2">
            <Skeleton className="size-6 rounded-full" />
            <div className="grid flex-1 gap-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        ))}
      </div>
      <Skeleton className="h-44 w-full rounded-xl" />
    </div>
  );
}
