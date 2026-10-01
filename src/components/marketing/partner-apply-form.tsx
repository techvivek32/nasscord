"use client";

import * as React from "react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { PARTNER_MODELS } from "@/lib/plans";
import type { PartnerModel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MODEL_IDS = PARTNER_MODELS.map((m) => m.id) as [PartnerModel, ...PartnerModel[]];
const MODEL_ITEMS = PARTNER_MODELS.map((m) => ({ value: m.id, label: m.name }));

const schema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80, "Keep it under 80 characters."),
  company: z.string().trim().min(2, "Enter your company or brand.").max(80, "Keep it under 80 characters."),
  email: z.email("Enter a valid work email."),
  model: z.enum(MODEL_IDS, { error: "Choose a partner model." }),
  seats: z.coerce.number({ error: "Enter a number." }).int("Whole seats only.").min(1, "At least 1 seat.").max(100_000, "Talk to us directly for more than 100,000 seats."),
  notes: z.string().trim().max(1000, "Keep notes under 1,000 characters.").optional(),
});

type Input = z.input<typeof schema>;
type Values = z.output<typeof schema>;

const SUCCESS = "Application received. We reply within two business days.";

/** Partner application. Demo: the payload stays in the browser; the success state and toast stand in for the reply. */
export function PartnerApplyForm({ defaultModel, className }: { defaultModel?: PartnerModel; className?: string }) {
  const [submitted, setSubmitted] = React.useState<Values | null>(null);
  const ids = {
    name: React.useId(),
    company: React.useId(),
    email: React.useId(),
    model: React.useId(),
    seats: React.useId(),
    notes: React.useId(),
  };

  const form = useForm<Input, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", company: "", email: "", model: defaultModel, seats: 10, notes: "" },
  });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    await new Promise((r) => setTimeout(r, 600));
    setSubmitted(values);
    toast.success(SUCCESS);
  }

  if (submitted) {
    const model = PARTNER_MODELS.find((m) => m.id === submitted.model);
    return (
      <Card className={cn("gap-4", className)} role="status">
        <CardHeader className="gap-3">
          <CheckCircle2 aria-hidden="true" className="size-8 text-gain-foreground" />
          <CardTitle className="text-lg font-semibold">{SUCCESS}</CardTitle>
          <CardDescription>
            Thanks, {submitted.name}. We will write to {submitted.email} about the {model?.name.toLowerCase()} program for {submitted.company}
            {submitted.seats ? ` (${submitted.seats.toLocaleString("en-US")} expected seats)` : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" render={<Link href="/partner" />}>
            Preview the partner portal
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
        <CardTitle className="text-lg font-semibold">Apply as a partner</CardTitle>
        <CardDescription>Tell us who you are and how you want to work with Nasscord. A person reads every application.</CardDescription>
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
          <Field id={ids.model} label="Partner model" error={errors.model?.message}>
            <Controller
              control={form.control}
              name="model"
              render={({ field }) => (
                <Select
                  items={MODEL_ITEMS}
                  value={field.value ?? null}
                  onValueChange={(v) => field.onChange(v ?? undefined)}
                >
                  <SelectTrigger id={ids.model} className="w-full" aria-invalid={!!errors.model} aria-describedby={errors.model ? `${ids.model}-err` : undefined} onBlur={field.onBlur}>
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_ITEMS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field id={ids.seats} label="Expected seats in year one" error={errors.seats?.message}>
            <Input id={ids.seats} type="number" inputMode="numeric" min={1} step={1} aria-invalid={!!errors.seats} className="font-mono tabular" {...form.register("seats")} />
          </Field>
          <Field id={ids.notes} label="Notes" hint="Optional" error={errors.notes?.message} className="sm:col-span-2">
            <Textarea id={ids.notes} rows={4} placeholder="Which brokers your customers hold, timelines, anything else we should know." aria-invalid={!!errors.notes} {...form.register("notes")} />
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
