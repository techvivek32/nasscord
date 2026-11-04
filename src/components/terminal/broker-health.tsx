"use client";

import Link from "next/link";
import { CircleAlertIcon, PlugZapIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { CONNECTION_TONE, connectionName, sessionLine } from "@/components/brokers/connect/status";
import { EmptyState } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PartialError } from "@/lib/api";
import type { BrokerConnection } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountScope, useMinuteClock, type AccountScopeInfo } from "@/components/terminal/hooks";
import { CardSkeleton } from "@/components/terminal/skeletons";

export { CONNECTION_TONE } from "@/components/brokers/connect/status";

/** Shown wherever broker data would be when the workspace has no connection yet. */
export function NoBrokerState({ className }: { className?: string }) {
  return (
    <EmptyState
      title="No broker connected"
      description="Connect IBKR or E*TRADE to see your accounts here."
      className={className}
      action={
        <Button size="sm" render={<Link href="/app/brokers" />}>
          <PlugZapIcon />
          Connect a broker
        </Button>
      }
    />
  );
}

/** Connections exist, but none in view has a live session (pending login, ended, error). */
export function NoLiveSessionState({ className, accountInView }: { className?: string; accountInView?: boolean }) {
  return (
    <EmptyState
      title="No broker session is active"
      description={
        accountInView
          ? "The account in view has no active broker session. Reconnect it from Brokers, or pick All accounts in the header."
          : "Your broker connections need a new login before Nasscord can read them. Reconnect from Brokers."
      }
      className={className}
      action={
        <Button size="sm" variant="outline" render={<Link href="/app/brokers" />}>
          Open Brokers
        </Button>
      }
    />
  );
}

/** Live connections, but no account is included, so there is nothing to read. */
export function NoAccountsState({ className }: { className?: string }) {
  return (
    <EmptyState
      title="No account is included"
      description="Turn on Included for at least one account under Brokers. If your broker listed no accounts, reconnect it there."
      className={className}
      action={
        <Button size="sm" variant="outline" render={<Link href="/app/brokers" />}>
          Open Brokers
        </Button>
      }
    />
  );
}

export type BrokerGate = "loading" | "error" | "none" | "no-session" | "no-session-in-view" | "no-accounts" | null;

/**
 * The state every broker-data page starts from: loading, the connections route failing, no
 * connection, no live session, no included account, or an account in view whose session ended.
 * Returns null when the page can show its data.
 */
export function brokerGate(scope: AccountScopeInfo): BrokerGate {
  if (scope.isLoading) return "loading";
  if (scope.error && scope.connections.length === 0) return "error";
  if (scope.connections.length === 0) return "none";
  if (scope.live.length === 0) return "no-session";
  if (scope.included.length === 0) return "no-accounts";
  const live = new Set(scope.live.map((c) => c.id));
  if (!scope.scoped.some((a) => a.connectionId !== undefined && live.has(a.connectionId))) return "no-session-in-view";
  return null;
}

/** The screen for a gate that stops the page (everything but "loading" and null). */
export function BrokerGateState({ gate, scope }: { gate: Exclude<BrokerGate, "loading" | null>; scope: AccountScopeInfo }) {
  switch (gate) {
    case "error":
      return <ConnectionsError scope={scope} />;
    case "none":
      return <NoBrokerState />;
    case "no-accounts":
      return <NoAccountsState />;
    case "no-session":
      return <NoLiveSessionState />;
    case "no-session-in-view":
      return <NoLiveSessionState accountInView={scope.selected !== null} />;
  }
}

/** The connections route itself failed (for example the broker service is not configured). */
export function ConnectionsError({ scope, className }: { scope: AccountScopeInfo; className?: string }) {
  return (
    <Alert variant="destructive" className={className}>
      <CircleAlertIcon />
      <AlertTitle>Your broker connections could not be read</AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>{scope.error?.message ?? "Try again in a moment."}</span>
        <Button size="sm" variant="outline" className="justify-self-start" onClick={scope.refetch}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Errors a read route returned, one line per connection, plus the route's own failure. `stale`:
 * the route failed on the latest refresh and the page still shows the last list that was read.
 */
export function BrokerErrors({
  errors,
  error,
  stale,
  connections,
  className,
}: {
  errors: PartialError[];
  error?: Error | null;
  stale?: boolean;
  connections: BrokerConnection[];
  className?: string;
}) {
  if (errors.length === 0 && !error) return null;
  const name = (id: string) => {
    const c = connections.find((x) => x.id === id);
    return c ? connectionName(c) : "A broker connection";
  };
  const title = error
    ? stale
      ? "The latest refresh failed"
      : "This list could not be read"
    : errors.length === 1
      ? "One connection could not be read"
      : `${errors.length} connections could not be read`;
  return (
    <Alert className={className}>
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="grid gap-1">
          {error ? <li>{stale ? `${error.message} What you see is the last list that was read.` : error.message}</li> : null}
          {errors.map((e, i) => (
            <li key={`${e.connectionId}-${i}`}>
              <span className="font-medium text-foreground">{name(e.connectionId)}:</span> {e.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** Sidebar card on the Alerts page: every connection with its status, detail and session line. */
export function BrokerHealthCard({ className }: { className?: string }) {
  const scope = useAccountScope();
  const now = useMinuteClock();
  if (scope.isLoading) return <CardSkeleton lines={3} className={className} />;
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Broker sessions</CardTitle>
        <CardDescription>The connections Nasscord reads your accounts through.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {scope.error && scope.connections.length === 0 ? (
          <p className="text-sm text-destructive">{scope.error.message}</p>
        ) : scope.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No broker connected yet.</p>
        ) : (
          scope.connections.map((c) => {
            const s = CONNECTION_TONE[c.status];
            const line = now ? sessionLine(c, now) : null;
            return (
              <div key={c.id} className="flex items-start gap-3">
                <BrokerMark id={c.brokerId} size="sm" className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-2">
                    <span className="truncate text-sm font-medium">{connectionName(c)}</span>
                    <StatusDot tone={s.tone} label={<span className="text-xs">{s.label}</span>} pulse={c.status === "pending"} />
                  </div>
                  <p className={cn("text-xs text-muted-foreground")}>
                    {c.accounts.length} {c.accounts.length === 1 ? "account" : "accounts"}
                    {line ? ` · ${line}` : ""}
                  </p>
                  {c.statusDetail ? <p className="mt-0.5 text-xs text-muted-foreground">{c.statusDetail}</p> : null}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
      <CardContent>
        <Button variant="outline" size="sm" className="w-full" render={<Link href="/app/brokers" />}>
          {scope.connections.length === 0 ? "Connect a broker" : "Manage brokers"}
        </Button>
      </CardContent>
    </Card>
  );
}
