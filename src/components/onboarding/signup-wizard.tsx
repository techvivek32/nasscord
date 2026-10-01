"use client";

import * as React from "react";
import { TenantTheme } from "@/components/tenant-theme";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { TenantBranding } from "@/lib/types";
import { StepProgress, StepRail } from "@/components/onboarding/step-rail";
import { SummaryCard } from "@/components/onboarding/summary-card";
import { StepAccount } from "@/components/onboarding/step-account";
import { StepWorkspace } from "@/components/onboarding/step-workspace";
import { StepBrokers } from "@/components/onboarding/step-brokers";
import { StepPreferences } from "@/components/onboarding/step-preferences";
import { StepReady } from "@/components/onboarding/step-ready";
import { isTenantCode, useSignupStore } from "@/components/onboarding/store";

/**
 * Root of the signup wizard. Two columns on desktop (rail 280px + step card), stacked on
 * mobile with a compact progress line. A valid tenant code makes the new user a tenant user of
 * that tenant; when the tenant has white-label (`tenantBranding` is set) the right column takes
 * its accent as soon as the code is entered, so the trader sees the white-label preview live.
 */
export function SignupWizard({ tenantName, tenantBranding }: { tenantName: string; tenantBranding: TenantBranding | null }) {
  const hydrated = useSignupStore((s) => s.hydrated);
  const step = useSignupStore((s) => s.step);
  const furthest = useSignupStore((s) => s.furthest);
  const tenantCode = useSignupStore((s) => s.account.tenantCode);
  const goTo = useSignupStore((s) => s.goTo);

  React.useEffect(() => {
    // Manual hydration keeps the first client render identical to the server render.
    void useSignupStore.persist.rehydrate();
    const state = useSignupStore.getState();
    if (state.launched) state.reset();
    else useSignupStore.setState({ hydrated: true });
  }, []);

  /** Signing up through the tenant: the user becomes a tenant user. */
  const tenantJoined = isTenantCode(tenantCode);
  /** ...and the tenant has white-label, so its brand and pricing apply. */
  const brandActive = tenantJoined && tenantBranding !== null;

  const stepCard = !hydrated ? (
    <WizardSkeleton />
  ) : step === 1 ? (
    <StepAccount tenantName={tenantName} whiteLabel={tenantBranding !== null} />
  ) : step === 2 ? (
    <StepWorkspace tenantName={tenantName} brandActive={brandActive} />
  ) : step === 3 ? (
    <StepBrokers />
  ) : step === 4 ? (
    <StepPreferences />
  ) : (
    <StepReady tenantName={tenantName} tenantJoined={tenantJoined} brandActive={brandActive} />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-10">
      <aside className="hidden lg:flex lg:flex-col lg:gap-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1 text-sm text-muted-foreground">Five short steps. Your draft is saved in this browser as you go.</p>
        </div>
        {hydrated ? (
          <>
            <StepRail current={step} furthest={furthest} onSelect={goTo} />
            <SummaryCard tenantName={tenantName} whiteLabel={tenantBranding !== null} />
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
        {brandActive && tenantBranding ? (
          <TenantTheme branding={tenantBranding}>
            <div className="grid gap-4">
              {stepCard}
              <TenantPreviewNote name={tenantBranding.name} />
            </div>
          </TenantTheme>
        ) : (
          stepCard
        )}
        {hydrated ? (
          <div className="mt-6 lg:hidden">
            <SummaryCard tenantName={tenantName} whiteLabel={tenantBranding !== null} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function TenantPreviewNote({ name }: { name: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Preview: buttons, links and focus rings use {name}&apos;s accent. Your terminal will look the same after setup.
    </p>
  );
}

function WizardSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading your draft">
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
