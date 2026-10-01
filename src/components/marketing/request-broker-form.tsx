"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const schema = z.object({
  broker: z.string().trim().min(2, "Tell us which broker you use.").max(60, "Keep it under 60 characters."),
  email: z.string().trim().email("Enter a valid email so we can tell you when it ships."),
});

type Values = z.infer<typeof schema>;

/** Small request form for brokers not in the registry. Demo: the submission stays in the browser and shows a toast. */
export function RequestBrokerForm({ className }: { className?: string }) {
  const [sent, setSent] = React.useState<string | null>(null);
  const brokerId = React.useId();
  const emailId = React.useId();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { broker: "", email: "" } });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    await new Promise((r) => setTimeout(r, 400));
    setSent(values.broker);
    toast.success(`Request noted for ${values.broker}.`, { description: `We will email ${values.email} when it is available.` });
    form.reset();
  }

  return (
    <Card className={cn("gap-4", className)}>
      <CardHeader>
        <CardTitle>Request a broker</CardTitle>
        <CardDescription>Missing one you hold? Tell us and we will prioritize by demand and by whether the broker publishes an API.</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="flex items-start gap-3 rounded-lg bg-gain-soft p-3 text-sm text-gain-foreground" role="status">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div className="grid gap-1">
              <p className="font-medium">Thanks, {sent} is on the list.</p>
              <button type="button" className="w-fit text-left text-xs underline underline-offset-2" onClick={() => setSent(null)}>
                Request another broker
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
            <div className="grid gap-1.5">
              <Label htmlFor={brokerId}>Broker name</Label>
              <Input id={brokerId} placeholder="e.g. Merrill Edge" autoComplete="off" aria-invalid={!!errors.broker} aria-describedby={errors.broker ? `${brokerId}-err` : undefined} {...form.register("broker")} />
              {errors.broker ? (
                <p id={`${brokerId}-err`} className="text-xs text-destructive">
                  {errors.broker.message}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <Input id={emailId} type="email" placeholder="you@example.com" autoComplete="email" aria-invalid={!!errors.email} aria-describedby={errors.email ? `${emailId}-err` : undefined} {...form.register("email")} />
              {errors.email ? (
                <p id={`${emailId}-err`} className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              ) : null}
            </div>
            <Button type="submit" disabled={isSubmitting} className="sm:mt-5">
              {isSubmitting ? "Sending" : "Send request"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
