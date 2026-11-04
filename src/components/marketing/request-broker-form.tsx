"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, CircleAlert } from "lucide-react";
import { submitBrokerRequest } from "@/lib/server/public-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Same rules as the server action, so most mistakes show before the round trip. The server checks again. */
const schema = z.object({
  brokerName: z.string().trim().min(2, "Enter the broker's name.").max(80, "Keep it under 80 characters."),
  email: z.email("Enter a valid email so we can tell you when it is ready."),
});

type Values = z.infer<typeof schema>;

/** Request form for a broker that does not connect yet. Saves a row in broker_requests through submitBrokerRequest. */
export function RequestBrokerForm({ className }: { className?: string }) {
  const [sent, setSent] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const brokerId = React.useId();
  const emailId = React.useId();
  const errorId = React.useId();
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { brokerName: "", email: "" } });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    setFormError(null);
    let res: Awaited<ReturnType<typeof submitBrokerRequest>>;
    try {
      res = await submitBrokerRequest(values);
    } catch {
      setFormError("We could not reach the server. Check your connection and try again.");
      return;
    }
    if (res.ok) {
      setSent(values.brokerName.trim());
      form.reset();
      return;
    }
    if (res.field === "brokerName" || res.field === "email") form.setError(res.field, { message: res.error }, { shouldFocus: true });
    else setFormError(res.error);
  }

  return (
    <Card className={cn("gap-4 rounded-[2px] py-7 ring-foreground", className)}>
      <CardHeader>
        <CardTitle className="font-serif text-4xl font-normal">Request a broker</CardTitle>
        <CardDescription>Hold an account at a broker that does not connect yet? Tell us which one, and leave an email so we can tell you when it does.</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <div className="flex items-start gap-3 rounded-lg bg-gain-soft p-3 text-sm text-gain-foreground" role="status">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div className="grid gap-1">
              <p className="font-medium">Request saved for {sent}.</p>
              <button type="button" className="w-fit text-left text-xs underline underline-offset-2" onClick={() => setSent(null)}>
                Request another broker
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate aria-describedby={formError ? errorId : undefined} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start">
            <div className="grid gap-1.5">
              <Label htmlFor={brokerId}>Broker name</Label>
              <Input
                id={brokerId}
                placeholder="e.g. Merrill Edge"
                autoComplete="off"
                aria-invalid={!!errors.brokerName}
                aria-describedby={errors.brokerName ? `${brokerId}-err` : undefined}
                {...form.register("brokerName")}
              />
              {errors.brokerName ? (
                <p id={`${brokerId}-err`} className="text-xs text-destructive">
                  {errors.brokerName.message}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <Input
                id={emailId}
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                aria-invalid={!!errors.email}
                aria-describedby={errors.email ? `${emailId}-err` : undefined}
                {...form.register("email")}
              />
              {errors.email ? (
                <p id={`${emailId}-err`} className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              ) : null}
            </div>
            <Button type="submit" disabled={isSubmitting} className="sm:mt-5">
              {isSubmitting ? "Sending" : "Send request"}
            </Button>
            {formError ? (
              <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-destructive sm:col-span-3">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {formError}
              </p>
            ) : null}
          </form>
        )}
      </CardContent>
    </Card>
  );
}
