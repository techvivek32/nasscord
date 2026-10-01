"use client";

import * as React from "react";
import { ArrowLeftIcon, BellIcon, CheckIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BROKERS } from "@/lib/brokers";
import type { Broker, BrokerId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ConnectDialog, ManageDialog } from "@/components/onboarding/connect-dialog";
import { StepShell, useFocusOnMount } from "@/components/onboarding/step-shell";
import { useSignupStore } from "@/components/onboarding/store";

/** Step 3: the twelve registry brokers, each with the one action its status allows. */
export function StepBrokers() {
  const connections = useSignupStore((s) => s.connections);
  const notify = useSignupStore((s) => s.notify);
  const navigated = useSignupStore((s) => s.navigated);
  const toggleNotify = useSignupStore((s) => s.toggleNotify);
  const submitBrokers = useSignupStore((s) => s.submitBrokers);
  const back = useSignupStore((s) => s.back);

  const [connecting, setConnecting] = React.useState<BrokerId | null>(null);
  const [managing, setManaging] = React.useState<BrokerId | null>(null);

  useFocusOnMount(`signup-broker-${BROKERS[0].id}`, navigated);

  const connectedCount = connections.length;
  const accountCount = connections.reduce((n, c) => n + c.accounts.length, 0);

  return (
    <StepShell
      step={3}
      title="Connect your brokers"
      description="Nasscord talks to each broker through its own API with a token you can revoke. Connect one now; add the rest any time from Settings."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={back}>
            <ArrowLeftIcon />
            Back
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            {connectedCount === 0 ? (
              <Button type="button" variant="link" className="px-0 text-muted-foreground" onClick={submitBrokers}>
                Skip for now
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground tabular">
                {connectedCount} {connectedCount === 1 ? "broker" : "brokers"} · {accountCount} {accountCount === 1 ? "account" : "accounts"}
              </span>
            )}
            <Button type="button" size="lg" disabled={connectedCount === 0} onClick={submitBrokers}>
              Continue
            </Button>
          </div>
        </>
      }
    >
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Brokers">
        {BROKERS.map((b) => {
          const connection = connections.find((c) => c.brokerId === b.id);
          return (
            <li key={b.id} className="min-w-0">
              <BrokerTile
                broker={b}
                connectedAccounts={connection?.accounts.length ?? 0}
                notifying={notify.includes(b.id)}
                onConnect={() => setConnecting(b.id)}
                onManage={() => setManaging(b.id)}
                onNotify={() => toggleNotify(b.id)}
              />
            </li>
          );
        })}
      </ul>

      {connecting ? <ConnectDialog key={connecting} brokerId={connecting} open onOpenChange={(o) => !o && setConnecting(null)} /> : null}
      {managing ? <ManageDialog key={managing} brokerId={managing} open onOpenChange={(o) => !o && setManaging(null)} /> : null}
    </StepShell>
  );
}

function BrokerTile({
  broker,
  connectedAccounts,
  notifying,
  onConnect,
  onManage,
  onNotify,
}: {
  broker: Broker;
  connectedAccounts: number;
  notifying: boolean;
  onConnect: () => void;
  onManage: () => void;
  onNotify: () => void;
}) {
  const connected = connectedAccounts > 0;
  const buttonId = `signup-broker-${broker.id}`;

  return (
    <Card size="sm" className={cn("h-full gap-3", connected && "ring-primary/50")}>
      <div className="flex items-start gap-3 px-3">
        <BrokerMark id={broker.id} size="md" />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{broker.name}</span>
            {connected ? (
              <Badge variant="secondary" className="bg-gain-soft text-gain-foreground">
                <CheckIcon />
                Connected · {connectedAccounts} {connectedAccounts === 1 ? "account" : "accounts"}
              </Badge>
            ) : (
              <BrokerStatusBadge status={broker.status} />
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{broker.blurb}</p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 px-3">
        <TileAction broker={broker} connected={connected} notifying={notifying} buttonId={buttonId} onConnect={onConnect} onManage={onManage} onNotify={onNotify} />
      </div>
    </Card>
  );
}

function TileAction({
  broker,
  connected,
  notifying,
  buttonId,
  onConnect,
  onManage,
  onNotify,
}: {
  broker: Broker;
  connected: boolean;
  notifying: boolean;
  buttonId: string;
  onConnect: () => void;
  onManage: () => void;
  onNotify: () => void;
}) {
  if (connected) {
    return (
      <>
        <span className="text-xs text-muted-foreground">{broker.capabilities.trading ? "Trading enabled" : "Read-only sync"}</span>
        <Button id={buttonId} type="button" variant="outline" size="sm" onClick={onManage}>
          Manage
        </Button>
      </>
    );
  }
  if (broker.status === "soon") {
    return (
      <>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {notifying ? "We will email you when it opens." : "Not available yet."}
        </span>
        <Button id={buttonId} type="button" variant={notifying ? "secondary" : "outline"} size="sm" aria-pressed={notifying} onClick={onNotify}>
          {notifying ? <CheckIcon /> : <BellIcon />}
          {notifying ? "We will email you" : "Notify me"}
        </Button>
      </>
    );
  }
  if (broker.status === "sync") {
    return (
      <>
        <span className="text-xs text-muted-foreground">Positions and balances only</span>
        <Button id={buttonId} type="button" variant="outline" size="sm" onClick={onConnect}>
          <RefreshCwIcon />
          Sync
        </Button>
      </>
    );
  }
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {[broker.capabilities.options && "Options", broker.capabilities.extendedHours && "Extended hours", broker.capabilities.paper && "Paper"].filter(Boolean).join(" · ") || "Equities"}
      </span>
      <Button id={buttonId} type="button" size="sm" onClick={onConnect}>
        <PlugZapIcon />
        Connect
      </Button>
    </>
  );
}
