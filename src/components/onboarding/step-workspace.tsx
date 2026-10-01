"use client";

import * as React from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon, CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkspaces } from "@/hooks/queries";
import { slugify } from "@/lib/format";
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

function priceLine(plan: Plan) {
  if (plan.monthly === 0) return "$0, no card required";
  if (plan.id === "pro") return `14-day free trial, then $${plan.monthly}/mo`;
  return `$${plan.monthly}/mo`;
}

/** Step 2: workspace name, subdomain, timezone and plan. `brandActive`: joining a white-label tenant, which sets the pricing. */
export function StepWorkspace({ tenantName, brandActive }: { tenantName: string; brandActive: boolean }) {
  const workspace = useSignupStore((s) => s.workspace);
  const navigated = useSignupStore((s) => s.navigated);
  const setWorkspace = useSignupStore((s) => s.setWorkspace);
  const submitWorkspace = useSignupStore((s) => s.submitWorkspace);
  const back = useSignupStore((s) => s.back);

  const workspaces = useWorkspaces();

  const form = useForm<WorkspaceValues>({
    resolver: zodResolver(workspaceSchema),
    mode: "onTouched",
    defaultValues: { name: workspace.name, slug: workspace.slug, timezone: workspace.timezone, plan: workspace.plan },
  });
  const { register, handleSubmit, control, setValue, setError, clearErrors, formState } = form;
  const { errors } = formState;

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
  const taken = slugValid && (RESERVED_SLUGS.has(slug) || (workspaces.data?.some((w) => w.slug === slug) ?? false));
  const checking = slugValid && workspaces.isPending;

  React.useEffect(() => {
    if (taken) setError("slug", { type: "taken", message: "That subdomain is taken. Try another." });
    else if (errors.slug?.type === "taken") clearErrors("slug");
  }, [taken, errors.slug?.type, setError, clearErrors]);

  const nameField = register("name", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setWorkspace({ nameEdited: true });
      if (!workspace.slugEdited) setValue("slug", slugify(e.target.value), { shouldValidate: formState.touchedFields.slug });
    },
  });
  const slugField = register("slug", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = normaliseSlugInput(e.target.value);
      setValue("slug", next, { shouldValidate: true, shouldTouch: true });
      setWorkspace({ slugEdited: next.length > 0 });
    },
  });

  const onSubmit = (values: WorkspaceValues) => {
    if (taken) {
      setError("slug", { type: "taken", message: "That subdomain is taken. Try another." });
      return;
    }
    setWorkspace({ ...values });
    submitWorkspace();
  };

  return (
    <StepShell
      step={2}
      title="Set up your workspace"
      description="The workspace holds your accounts, alerts and teammates. You can rename it later; the URL is permanent."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={back}>
            <ArrowLeftIcon />
            Back
          </Button>
          <Button type="submit" form="signup-workspace-form" size="lg" disabled={checking}>
            Continue
          </Button>
        </>
      }
    >
      <form id="signup-workspace-form" noValidate onSubmit={handleSubmit(onSubmit)} className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="signup-workspace-name">Workspace name</Label>
            <Input
              id="signup-workspace-name"
              autoComplete="organization"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "signup-workspace-name-error" : undefined}
              {...nameField}
            />
            <FieldError id="signup-workspace-name-error" message={errors.name?.message} />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="signup-workspace-slug">Workspace URL</Label>
            <InputGroup>
              <InputGroupInput
                id="signup-workspace-slug"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                aria-invalid={!!errors.slug}
                aria-describedby="signup-workspace-slug-status"
                {...slugField}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText className="font-mono text-xs">.nasscord.com</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <SlugStatus id="signup-workspace-slug-status" slug={slug} valid={slugValid} checking={checking} taken={taken} error={errors.slug?.message} />
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
          <FieldHint id="signup-timezone-hint">Alerts and the trade log show times in this zone. Market hours stay in Eastern time.</FieldHint>
        </div>

        <fieldset className="grid gap-3">
          <legend className="text-sm font-medium">Plan</legend>
          {brandActive ? (
            <FieldHint>
              List prices shown for reference. {tenantName} sets your pricing and bills you directly; nothing is charged by Nasscord.
            </FieldHint>
          ) : (
            <FieldHint>Switch plans any time from Settings. Yearly billing is about 20% less.</FieldHint>
          )}
          <RadioGroup
            value={plan}
            onValueChange={(v) => setValue("plan", v as SignupPlanId, { shouldDirty: true })}
            aria-label="Plan"
            className="grid gap-2 sm:grid-cols-3"
          >
            {SIGNUP_PLANS.map((p) => {
              const selected = plan === p.id;
              const id = `signup-plan-${p.id}`;
              return (
                <label
                  key={p.id}
                  htmlFor={id}
                  className={cn(
                    "flex cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-colors hover:border-input",
                    selected && "border-primary ring-1 ring-primary",
                  )}
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
                  {p.yearly && p.yearly > 0 ? <span className="text-xs text-muted-foreground tabular">${p.yearly}/mo billed yearly</span> : <span className="text-xs text-muted-foreground">{p.limits.brokers === 1 ? "1 broker, 1 seat" : ""}</span>}
                </label>
              );
            })}
          </RadioGroup>
        </fieldset>
      </form>
    </StepShell>
  );
}

function SlugStatus({ id, slug, valid, checking, taken, error }: { id: string; slug: string; valid: boolean; checking: boolean; taken: boolean; error?: string }) {
  if (error && !taken) return <FieldError id={id} message={error} />;
  if (!slug) return <FieldHint id={id}>Lowercase letters, numbers and hyphens. 3 to 32 characters.</FieldHint>;
  if (!valid) return <FieldHint id={id}>Lowercase letters, numbers and hyphens. 3 to 32 characters.</FieldHint>;
  if (checking)
    return (
      <FieldHint id={id} className="inline-flex items-center gap-1.5">
        <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
        Checking availability
      </FieldHint>
    );
  if (taken)
    return (
      <p id={id} role="alert" className="inline-flex items-center gap-1.5 text-xs text-loss-foreground">
        <XIcon className="size-3.5" aria-hidden="true" />
        <span className="font-mono">{slug}.nasscord.com</span> is taken. Try another.
      </p>
    );
  return (
    <p id={id} className="inline-flex items-center gap-1.5 text-xs text-gain-foreground">
      <CheckIcon className="size-3.5" aria-hidden="true" />
      <span className="font-mono">{slug}.nasscord.com</span> is available
    </p>
  );
}
