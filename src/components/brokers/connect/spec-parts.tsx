"use client";

import { CircleAlertIcon, ExternalLinkIcon, LockIcon, TriangleAlertIcon, UserRoundCheckIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BrokerId, ConnectOption } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * Pieces the generic connect dialogs (api key, OAuth, SnapTrade) render from a broker's ConnectSpec
 * (src/lib/broker-connect): the header, what to have ready, the numbered steps, the caution, the
 * disclosure and the owner-only note. Copy comes from the spec, never from here.
 */

/** The broker service lets only the platform owner use this way for now (BROKER_AUDIENCE superadmin). */
export function isOwnerOnly(option: ConnectOption | undefined): boolean {
  return option?.audience === "superadmin" && option.available;
}

export function ConnectDialogHeader({ brokerId, title, description, via }: { brokerId: BrokerId; title: string; description: string; via?: "snaptrade" }) {
  return (
    <DialogHeader className="pr-8">
      <div className="flex items-start gap-3">
        <BrokerMark id={brokerId} size="md" />
        <div className="grid min-w-0 gap-1">
          <DialogTitle className="flex flex-wrap items-center gap-2 leading-tight">
            {title}
            {via === "snaptrade" ? <Badge variant="secondary">via SnapTrade</Badge> : null}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </div>
      </div>
    </DialogHeader>
  );
}

/** What the user needs before starting. */
export function SpecPrerequisites({ items, className }: { items?: string[]; className?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={cn("grid gap-1 text-xs text-muted-foreground", className)}>
      <p className="font-medium text-foreground">You need</p>
      <ul className="grid list-disc gap-0.5 pl-4">
        {items.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

/** The spec's numbered steps, plus a link to the broker's own page for them. */
export function SpecSteps({ steps, docsUrl, title = "Steps", className }: { steps: string[]; docsUrl?: string; title?: string; className?: string }) {
  if (steps.length === 0) return null;
  let host: string | null = null;
  if (docsUrl) {
    try {
      const u = new URL(docsUrl);
      host = u.protocol === "https:" ? u.host : null;
    } catch {
      host = null;
    }
  }
  return (
    <div className={cn("grid gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground", className)}>
      <p className="font-medium text-foreground">{title}</p>
      <ol className="grid list-decimal gap-1 pl-4">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {docsUrl && host ? (
        <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 justify-self-start text-primary underline-offset-2 hover:underline">
          Open {host}
          <ExternalLinkIcon className="size-3" aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

/** A caution shown before the steps (a regenerated key stops the user's other tools). */
export function SpecWarning({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

/** What Nasscord can and cannot do with this access, and how long it lasts. */
export function SpecDisclosure({ text, note, className }: { text: string; note?: string; className?: string }) {
  return (
    <div className={cn("grid gap-1.5 rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground", className)}>
      <p className="flex items-start gap-2 text-foreground">
        <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>{text}</span>
      </p>
      {note ? <p className="pl-5.5">{note}</p> : null}
    </div>
  );
}

/** Shown to the platform owner on a way only they can use while the broker's approval is pending. */
export function OwnerOnlyNote() {
  return (
    <Alert>
      <UserRoundCheckIcon />
      <AlertTitle>Only you can connect this way</AlertTitle>
      <AlertDescription>Other users see it as not available yet until the broker approves Nasscord and the broker service opens it to everyone.</AlertDescription>
    </Alert>
  );
}

/** A failed step's sentence (the route's `{ error }`), or a fixed message. */
export function ErrorAlert({ error, message }: { error?: Error | null; message?: string }) {
  const text = error?.message ?? message;
  if (!text) return null;
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}
