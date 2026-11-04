"use client";

import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { WHITE_LABEL_FEE } from "@/lib/plans";
import { submitTenantApplication, type TenantApplicationInput } from "@/lib/server/public-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** Same rules as submitTenantApplication, so most mistakes show before the round trip. The server checks again. */
const schema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80, "Keep it under 80 characters."),
  company: z.string().trim().min(2, "Enter your company or brand.").max(80, "Keep it under 80 characters."),
  email: z.email("Enter a valid work email."),
  /** Optional: blank stays blank (undefined) rather than becoming 0 or a made-up default. */
  traders: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.coerce.number({ error: "Enter a number." }).int("Whole numbers only.").min(1, "At least 1 trader.").max(100_000, "Talk to us directly for more than 100,000 traders.").optional(),
  ),
  /** Commission comes with every tenant; white-label is asked for here and decided by Nasscord. */
  wantsWhiteLabel: z.boolean(),
  notes: z.string().trim().max(1000, "Keep notes under 1,000 characters.").optional(),
});

type Input = z.input<typeof schema>;
type Values = z.output<typeof schema>;

/** Server field names, mapped back to the form's own. */
const FIELD: Partial<Record<keyof TenantApplicationInput, keyof Values>> = {
  name: "name",
  company: "company",
  email: "email",
  expectedTraders: "traders",
  offer: "wantsWhiteLabel",
  notes: "notes",
};

const SUCCESS = "Application received.";

/** Tenant application. Saves a row in tenant_applications through submitTenantApplication. */
export function TenantApplyForm({ defaultWhiteLabel = false, className }: { defaultWhiteLabel?: boolean; className?: string }) {
  const [submitted, setSubmitted] = React.useState<Values | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const ids = {
    name: React.useId(),
    company: React.useId(),
    email: React.useId(),
    traders: React.useId(),
    whiteLabel: React.useId(),
    notes: React.useId(),
    error: React.useId(),
  };

  const form = useForm<Input, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", company: "", email: "", traders: "", wantsWhiteLabel: defaultWhiteLabel, notes: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    setFormError(null);
    let res: Awaited<ReturnType<typeof submitTenantApplication>>;
    try {
      res = await submitTenantApplication({
        name: values.name,
        company: values.company,
        email: values.email,
        offer: values.wantsWhiteLabel ? "white_label" : "commission",
        expectedTraders: values.traders,
        notes: values.notes ? values.notes : undefined,
      });
    } catch {
      setFormError("We could not reach the server. Check your connection and try again.");
      return;
    }
    if (res.ok) {
      setSubmitted(values);
      return;
    }
    const field = res.field ? FIELD[res.field as keyof TenantApplicationInput] : undefined;
    // The white-label box has no inline message slot, so an "offer" error shows under the form.
    if (field && field !== "wantsWhiteLabel") form.setError(field, { message: res.error }, { shouldFocus: true });
    else setFormError(res.error);
  }

  if (submitted) {
    return (
      <Card className={cn("gap-4 rounded-[2px] py-7 ring-foreground", className)} role="status">
        <CardHeader className="gap-3">
          <CheckCircle2 aria-hidden="true" className="size-8 text-gain-foreground" />
          <CardTitle className="text-lg font-semibold">{SUCCESS}</CardTitle>
          <CardDescription>
            Thanks, {submitted.name}. Your application for {submitted.company}
            {submitted.wantsWhiteLabel ? ", including white-label," : ""} is saved. A person at Nasscord reads it and replies to {submitted.email}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setSubmitted(null);
              form.reset();
            }}
          >
            Submit another application
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("gap-5 rounded-[2px] py-7 ring-foreground", className)}>
      <CardHeader>
        <CardTitle className="font-serif text-4xl font-normal">Apply to become a tenant</CardTitle>
        <CardDescription>Tell us who you are and who your traders are. A person reads every application.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate aria-describedby={formError ? ids.error : undefined} className="grid gap-4 sm:grid-cols-2">
          <Field id={ids.name} label="Your name" error={errors.name?.message}>
            <Input id={ids.name} autoComplete="name" aria-invalid={!!errors.name} {...form.register("name")} />
          </Field>
          <Field id={ids.company} label="Company or brand" error={errors.company?.message}>
            <Input id={ids.company} autoComplete="organization" aria-invalid={!!errors.company} {...form.register("company")} />
          </Field>
          <Field id={ids.email} label="Work email" error={errors.email?.message}>
            <Input id={ids.email} type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register("email")} />
          </Field>
          <Field id={ids.traders} label="Traders you expect in year one" hint="Optional" error={errors.traders?.message}>
            <Input id={ids.traders} type="number" inputMode="numeric" min={1} step={1} aria-invalid={!!errors.traders} className="font-mono tabular" {...form.register("traders")} />
          </Field>
          <Controller
            control={form.control}
            name="wantsWhiteLabel"
            render={({ field }) => (
              <Label
                htmlFor={ids.whiteLabel}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 font-normal transition-colors hover:bg-muted/60 sm:col-span-2",
                  field.value && "border-primary/60 bg-brand-soft/40",
                )}
              >
                <Checkbox id={ids.whiteLabel} className="mt-0.5" checked={field.value} onCheckedChange={(c) => field.onChange(c)} onBlur={field.onBlur} />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">Also apply for white-label</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    Your name, accent colors and domain on the terminal, from ${WHITE_LABEL_FEE}/mo plus per-seat once billing is switched on. Nasscord reviews it separately.
                  </span>
                </span>
              </Label>
            )}
          />
          <Field id={ids.notes} label="Notes" hint="Optional" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea id={ids.notes} rows={4} placeholder="Where your audience is, which brokers your traders hold, timelines, anything else we should know." aria-invalid={!!errors.notes} {...form.register("notes")} />
          </Field>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" size="lg" disabled={isSubmitting}>
              {isSubmitting ? "Sending application" : "Send application"}
            </Button>
            <p className="text-xs text-muted-foreground">A person reads every application. No newsletter, no drip sequence.</p>
          </div>
          {formError ? (
            <p id={ids.error} role="alert" className="flex items-start gap-2 text-sm text-destructive sm:col-span-2">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {formError}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ id, label, hint, error, className, children }: { id: string; label: string; hint?: string; error?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
      {error ? (
        <p id={`${id}-err`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
