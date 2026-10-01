"use client";

import * as React from "react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Card frame shared by every wizard step: title, one-line description, body, footer actions. */
export function StepShell({
  step,
  title,
  description,
  children,
  footer,
  className,
}: {
  step: number;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <span className="text-xs font-semibold tracking-wide text-primary uppercase">Step {step} of 5</span>
        <CardTitle className="text-xl tracking-tight">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">{children}</CardContent>
      {footer ? <CardFooter className="flex-wrap justify-between gap-2">{footer}</CardFooter> : null}
    </Card>
  );
}

/** Moves focus to the element with `id` when a step mounts after navigation (never on first page load). */
export function useFocusOnMount(id: string, enabled: boolean) {
  React.useEffect(() => {
    if (!enabled) return;
    const el = document.getElementById(id);
    if (el instanceof HTMLElement) el.focus();
  }, [id, enabled]);
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-loss-foreground">
      {message}
    </p>
  );
}

export function FieldHint({ id, children, className }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <p id={id} className={cn("text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}
