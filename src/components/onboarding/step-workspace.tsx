"use client";

import * as React from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { checkSlugAvailable, createWorkspace, signOut } from "@/lib/auth-actions";
import { APP_DOMAIN } from "@/lib/branding";
import { maskEmail, slugify } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import type { Plan } from "@/lib/types";
import { cn } from "@/lib/utils";
import { RESERVED_SLUGS, SIGNUP_PLAN_IDS, TIMEZONES, type SignupPlanId, type TimezoneId } from "@/components/onboarding/data";
import { workspaceSchema, type WorkspaceValues } from "@/components/onboarding/schemas";
import { FieldError, FieldHint, StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { useSignupStore } from "@/components/onboarding/store";

const TIMEZONE_ITEMS = TIMEZONES.map((t) => ({ value: t.value, label: t.label }));
const SIGNUP_PLANS = SIGNUP_PLAN_IDS.map((id) => PLANS.find((p) => p.id === id)).filter((p): p is Plan => p !== undefined);

/** What a trader types in the subdomain field, normalised while typing (trailing hyphens allowed mid-edit). */
function normaliseSlugInput(v: string) {
  return v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").slice(0, 32);
}

/** List price only: billing is not switched on in this release, so nothing is charged and there is no trial clock. */
function priceLine(plan: Plan) {
  if (plan.monthly === 0) return "$0, no card required";
  return `$${plan.monthly}/mo list price, not charged`;
}

type SlugCheck = { state: "idle" | "checking" | "available" | "taken" | "error"; slug: string; message?: string };

/**
 * Step 2: workspace name, subdomain, timezone and plan. The subdomain is checked against the database
 * while typing; "Create workspace" creates it (createWorkspace) and makes the user its owner.
 * `brandActive`: joining a white-label tenant, which sets the pricing.
 */
export function StepWorkspace({ tenantName, brandActive }: { tenantName: string | null; brandActive: boolean }) {
  const workspace = useSignupStore((s) => s.workspace);
  const tenantCode = useSignupStore((s) => s.account.tenantCode);
  const email = useSignupStore((s) => s.account.email);
  const navigated = useSignupStore((s) => s.navigated);
  const setWorkspace = useSignupStore((s) => s.setWorkspace);
  const workspaceCreated = useSignupStore((s) => s.workspaceCreated);

  const [check, setCheck] = React.useState<SlugCheck>({ state: "idle", slug: "" });
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm<WorkspaceValues>({
    resolver: zodResolver(workspaceSchema),
    mode: "onTouched",
    defaultValues: { name: workspace.name, slug: workspace.slug, timezone: workspace.timezone, plan: workspace.plan },
  });
  const { register, handleSubmit, control, setValue, setError, formState } = form;
  const { errors, isSubmitting } = formState;

  const name = useWatch({ control, name: "name" }) ?? "";
  const slug = useWatch({ control, name: "slug" }) ?? "";
  const timezone = useWatch({ control, name: "timezone" });
  const plan = useWatch({ control, name: "plan" });

  // Keep the rail summary live.
  React.useEffect(() => {
    setWorkspace({ name, slug, timezone, plan });
  }, [name, slug, timezone, plan, setWorkspace]);

  useFocusOnMount("signup-workspace-name", navigated);

  const slugValid = workspaceSchema.shape.slug.safeParse(slug).success;
  const reserved = slugValid && RESERVED_SLUGS.has(slug);

  // Availability, debounced. Results for an older value are ignored.
  React.useEffect(() => {
    if (!slugValid || reserved) return;
    let cancelled = false;
    const t = window.setTimeout(async () => {
      setCheck({ state: "checking", slug });
      const res = await checkSlugAvailable(slug).catch(() => null);
      if (cancelled) return;
      if (!res || !res.ok) setCheck({ state: "error", slug, message: res && !res.ok ? res.error : "We could not check that subdomain." });
      else setCheck({ state: res.available ? "available" : "taken", slug, message: res.reason });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [slug, slugValid, reserved]);

  const current: SlugCheck = reserved
    ? { state: "taken", slug, message: "That subdomain is reserved. Try another." }
    : check.slug === slug
      ? check
      : { state: slugValid ? "checking" : "idle", slug };

  const nameField = register("name", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setWorkspace({ nameEdited: true });
      if (!workspace.slugEdited) setValue("slug", slugify(e.target.value).slice(0, 32).replace(/-+$/, ""), { shouldValidate: formState.touchedFields.slug });
    },
  });
  const slugField = register("slug", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = normaliseSlugInput(e.target.value);
      setValue("slug", next, { shouldValidate: true, shouldTouch: true });
      setWorkspace({ slugEdited: next.length > 0 });
    },
  });

  const onSubmit = async (values: WorkspaceValues) => {
    setFormError(null);
    if (current.state === "taken") {
      setError("slug", { type: "taken", message: current.message ?? "That subdomain is taken. Try another." });
      return;
    }
    const res = await createWorkspace({ ...values, tenantCode: tenantCode.trim() || undefined });
    if (!res.ok) {
      if (res.field === "slug" || res.field === "name" || res.field === "timezone" || res.field === "plan") {
        setError(res.field, { type: "server", message: res.error });
        if (res.field === "slug") setCheck({ state: "taken", slug: values.slug, message: res.error });
      } else {
        setFormError(res.error);
      }
      return;
    }
    setWorkspace({ ...values, slug: res.slug || values.slug });
    workspaceCreated({ slug: res.slug || values.slug, role: res.role });
  };

  return (
    <StepShell
      step={2}
      title="Set up your workspace"
      description="The workspace holds your broker connections and settings. Choose the name and address with care: neither can be changed from the app."
      footer={
        <>
          <form action={signOut} className="text-xs text-muted-foreground">
            {email ? <>Signed in as {maskEmail(email)}. </> : null}
            <button type="submit" className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline">
              Not you? Sign out
            </button>
          </form>
          <Button type="submit" form="signup-workspace-form" size="lg" disabled={isSubmitting || current.state === "checking"}>
            {isSubmitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            {isSubmitting ? "Creating workspace" : "Create workspace"}
          </Button>
        </>
      }
    >
      {formError ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{formError}</AlertTitle>
        </Alert>
      ) : null}

      <form id="signup-workspace-form" noValidate onSubmit={handleSubmit(onSubmit)} className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="signup-workspace-name">Workspace name</Label>
            <Input id="signup-workspace-name" autoComplete="organization" aria-invalid={!!errors.name} aria-describedby={errors.name ? "signup-workspace-name-error" : undefined} {...nameField} />
            <FieldError id="signup-workspace-name-error" message={errors.name?.message} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="signup-workspace-slug">Workspace address</Label>
            <InputGroup>
              <InputGroupInput
                id="signup-workspace-slug"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                aria-invalid={!!errors.slug || current.state === "taken"}
                aria-describedby="signup-workspace-slug-status"
                {...slugField}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="font-mono text-xs">.{APP_DOMAIN}</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <SlugStatus id="signup-workspace-slug-status" slug={slug} valid={slugValid} check={current} error={errors.slug?.type === "taken" || errors.slug?.type === "server" ? undefined : errors.slug?.message} />
          </div>
        </div>

        <div className="grid gap-1.5 sm:max-w-sm">
          <Label htmlFor="signup-timezone">Timezone</Label>
          <Select
            items={TIMEZONE_ITEMS}
            value={timezone}
            onValueChange={(v) => {
              if (v) setValue("timezone", v as TimezoneId, { shouldDirty: true });
            }}
          >
            <SelectTrigger id="signup-timezone" className="w-full" aria-describedby="signup-timezone-hint">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldHint id="signup-timezone-hint">Saved with your workspace. Times in the terminal are shown in Eastern time, the market&apos;s clock, for now.</FieldHint>
        </div>

        <fieldset className="grid gap-3">
          <legend className="text-sm font-medium">Plan</legend>
          {brandActive && tenantName ? (
            <FieldHint>List prices shown for reference. {tenantName} sets your pricing.</FieldHint>
          ) : (
            <FieldHint>Nothing is charged and plan limits are not enforced in this release. The plan is recorded on your workspace; the platform owner can change it for you.</FieldHint>
          )}
          <RadioGroup value={plan} onValueChange={(v) => setValue("plan", v as SignupPlanId, { shouldDirty: true })} aria-label="Plan" className="grid gap-2 sm:grid-cols-3">
            {SIGNUP_PLANS.map((p) => {
              const selected = plan === p.id;
              const id = `signup-plan-${p.id}`;
              return (
                <label
                  key={p.id}
                  htmlFor={id}
                  className={cn("flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:border-input", selected && "border-primary ring-1 ring-primary")}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="grid gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        {p.name}
                        {p.featured ? <Badge className="h-4 px-1.5 text-[10px]">Recommended</Badge> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">{p.tagline}</span>
                    </span>
                    <RadioGroupItem id={id} value={p.id} aria-label={`${p.name}, ${priceLine(p)}`} className="mt-0.5" />
                  </span>
                  <span className="text-sm font-medium tabular">{priceLine(p)}</span>
                </label>
              );
            })}
          </RadioGroup>
        </fieldset>
      </form>
    </StepShell>
  );
}

function SlugStatus({ id, slug, valid, check, error }: { id: string; slug: string; valid: boolean; check: SlugCheck; error?: string }) {
  if (error) return <FieldError id={id} message={error} />;
  if (!slug || !valid) return <FieldHint id={id}>Lowercase letters, numbers and hyphens. 3 to 32 characters.</FieldHint>;
  if (check.state === "checking" || check.state === "idle")
    return (
      <FieldHint id={id} className="inline-flex items-center gap-1.5">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
        Checking availability
      </FieldHint>
    );
  if (check.state === "error") return <FieldError id={id} message={check.message ?? "We could not check that subdomain. Try again."} />;
  if (check.state === "taken")
    return (
      <p id={id} role="alert" className="inline-flex items-center gap-1.5 text-xs text-loss-foreground">
        <XIcon className="size-3.5" aria-hidden="true" />
        {check.message ?? (
          <>
            <span className="font-mono">
              {slug}.{APP_DOMAIN}
            </span>{" "}
            is taken. Try another.
          </>
        )}
      </p>
    );
  return (
    <p id={id} className="inline-flex items-center gap-1.5 text-xs text-gain-foreground">
      <CheckIcon className="size-3.5" aria-hidden="true" />
      <span className="font-mono">
        {slug}.{APP_DOMAIN}
      </span>{" "}
      is available
    </p>
  );
}
