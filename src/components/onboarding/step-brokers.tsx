"use client";

import * as React from "react";
import { ArrowLeftIcon } from "lucide-react";
import { useConnections } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { ConnectBrokers, CONNECT_HOW } from "@/components/brokers/connect/connect-brokers";
import { CONNECTION_TONE, connectionName } from "@/components/brokers/connect/status";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkspaceScopeProvider, type WorkspaceScope } from "@/components/workspace-scope";
import { CONNECTABLE_BROKERS, type ConnectableBrokerId } from "@/lib/brokers";
import { getBrokerScope } from "@/lib/server/terminal-actions-extra";
import { StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { useSignupStore } from "@/components/onboarding/store";

type ScopeState = { status: "loading" } | { status: "ready"; scope: WorkspaceScope } | { status: "none" };

/**
 * Step 3: connect IBKR or E*TRADE with the same dialogs as the terminal's Brokers page, or skip and
 * connect later. The workspace exists by now (step 2), so the broker routes work; this step only
 * needs the workspace scope that the terminal layout would otherwise provide.
 */
export function StepBrokers() {
  const navigated = useSignupStore((s) => s.navigated);
  const submitBrokers = useSignupStore((s) => s.submitBrokers);
  const back = useSignupStore((s) => s.back);
  const created = useSignupStore((s) => s.created);
  const [scope, setScope] = React.useState<ScopeState>({ status: "loading" });

  useFocusOnMount("signup-brokers-continue", navigated);

  React.useEffect(() => {
    let cancelled = false;
    getBrokerScope()
      .then((s) => !cancelled && setScope(s ? { status: "ready", scope: s } : { status: "none" }))
      .catch(() => !cancelled && setScope({ status: "none" }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <StepShell
      step={3}
      title="Connect a broker"
      description="Connect IBKR or E*TRADE now, or continue and connect later from Brokers in your terminal."
      footer={
        <>
          {created ? (
            <span />
          ) : (
            <Button type="button" variant="ghost" onClick={back}>
              <ArrowLeftIcon />
              Back
            </Button>
          )}
          <Button id="signup-brokers-continue" type="button" size="lg" onClick={submitBrokers}>
            Continue
          </Button>
        </>
      }
    >
      {scope.status === "loading" ? (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading the brokers">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : scope.status === "ready" ? (
        <WorkspaceScopeProvider value={scope.scope}>
          <ConnectBrokers layout="list" />
          <ConnectedSoFar />
        </WorkspaceScopeProvider>
      ) : (
        <>
          <ul className="grid gap-3" aria-label="Brokers you can connect from the terminal">
            {CONNECTABLE_BROKERS.map((b) => (
              <li key={b.id} className="flex items-start gap-3 rounded-xl border border-border px-3 py-3">
                <BrokerMark id={b.id} size="md" />
                <div className="grid min-w-0 gap-0.5">
                  <span className="text-sm font-semibold">{b.name}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{CONNECT_HOW[b.id as ConnectableBrokerId]}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">Your workspace could not be read right now, so connect your broker from Brokers in your terminal after setup.</p>
        </>
      )}
      <p className="text-xs text-muted-foreground">This release is read-only: Nasscord shows balances, positions, orders and executions from your broker and places no orders.</p>
    </StepShell>
  );
}

/** Connections made so far in this workspace, from the broker routes. */
function ConnectedSoFar() {
  const { data } = useConnections();
  if (!data || data.length === 0) return null;
  return (
    <div className="grid gap-2">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Connected so far</p>
      <ul className="grid gap-2">
        {data.map((c) => {
          const tone = CONNECTION_TONE[c.status];
          const included = c.accounts.filter((a) => a.included).length;
          return (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <BrokerMark id={c.brokerId} size="sm" />
                {connectionName(c)}
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                {c.accounts.length > 0 ? (
                  <span>
                    {included} of {c.accounts.length} {c.accounts.length === 1 ? "account" : "accounts"} included
                  </span>
                ) : null}
                <StatusDot tone={tone.tone} label={<span className="text-xs">{tone.label}</span>} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
