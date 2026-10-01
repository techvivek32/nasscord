"use client";

import * as React from "react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { WHITE_LABEL_FEE } from "@/lib/plans";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const schema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80, "Keep it under 80 characters."),
  company: z.string().trim().min(2, "Enter your company or brand.").max(80, "Keep it under 80 characters."),
  email: z.email("Enter a valid work email."),
  traders: z.coerce.number({ error: "Enter a number." }).int("Whole numbers only.").min(1, "At least 1 trader.").max(100_000, "Talk to us directly for more than 100,000 traders."),
  /** Commission comes with every tenant; white-label is asked for here and decided by Nasscord. */
  wantsWhiteLabel: z.boolean(),
  notes: z.string().trim().max(1000, "Keep notes under 1,000 characters.").optional(),
});

type Input = z.input<typeof schema>;
type Values = z.output<typeof schema>;

const SUCCESS = "Application received. We reply within two business days.";

/** Tenant application. Demo: the payload stays in the browser; the success state and toast stand in for the reply. */
export function TenantApplyForm({ defaultWhiteLabel = false, className }: { defaultWhiteLabel?: boolean; className?: string }) {
  const [submitted, setSubmitted] = React.useState<Values | null>(null);
  const ids = {
    name: React.useId(),
    company: React.useId(),
    email: React.useId(),
    traders: React.useId(),
    whiteLabel: React.useId(),
    notes: React.useId(),
  };

  const form = useForm<Input, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", company: "", email: "", traders: 10, wantsWhiteLabel: defaultWhiteLabel, notes: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    await new Promise((r) => setTimeout(r, 600));
    setSubmitted(values);
    toast.success(SUCCESS);
  }

  if (submitted) {
    return (
      <Card className={cn("gap-4", className)} role="status">
        <CardHeader className="gap-3">
          <CheckCircle2 aria-hidden="true" className="size-8 text-gain-foreground" />
          <CardTitle className="text-lg font-semibold">{SUCCESS}</CardTitle>
          <CardDescription>
            Thanks, {submitted.name}. We will write to {submitted.email} about the tenant program for {submitted.company}
            {submitted.wantsWhiteLabel ? ", including white-label" : ""}
            {submitted.traders ? ` (${submitted.traders.toLocaleString("en-US")} expected traders)` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" render={<Link href="/tenant" />}>
            Preview the tenant portal
          </Button>
          <Button
            variant="ghost"
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
    <Card className={cn("gap-5", className)}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Apply to become a tenant</CardTitle>
        <CardDescription>Tell us who you are and who your traders are. A person reads every application.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:grid-cols-2">
          <Field id={ids.name} label="Your name" error={errors.name?.message}>
            <Input id={ids.name} autoComplete="name" aria-invalid={!!errors.name} {...form.register("name")} />
          </Field>
          <Field id={ids.company} label="Company or brand" error={errors.company?.message}>
            <Input id={ids.company} autoComplete="organization" aria-invalid={!!errors.company} {...form.register("company")} />
          </Field>
          <Field id={ids.email} label="Work email" error={errors.email?.message}>
            <Input id={ids.email} type="email" autoComplete="email" aria-invalid={!!errors.email} {...form.register("email")} />
          </Field>
          <Field id={ids.traders} label="Traders you expect in year one" error={errors.traders?.message}>
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
                    Your brand, domain and pricing on the terminal, from ${WHITE_LABEL_FEE}/mo plus per-seat. Nasscord reviews it separately; commission starts either way.
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
            <p className="text-xs text-muted-foreground">We reply within two business days. No newsletter, no drip sequence.</p>
          </div>
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
