"use client";

import * as React from "react";
import { toast } from "sonner";
import { CheckIcon, ExternalLinkIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { getBroker } from "@/lib/brokers";
import { fmtMoney } from "@/lib/format";
import type { BrokerId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ACCOUNT_TYPE_LABEL, CONNECT_STAGES, CONNECT_STAGE_MS, DEMO_ACCOUNTS, type DemoAccount } from "@/components/onboarding/data";
import { useSignupStore } from "@/components/onboarding/store";

type Phase = "intro" | "progress" | "accounts";

/**
 * Simulated OAuth hand-off. Intro (what we can and cannot do) -> three timed stages ->
 * returned accounts with checkboxes -> "Add selected". Mount with `key={brokerId}` so the
 * phase resets per broker.
 */
export function ConnectDialog({ brokerId, open, onOpenChange }: { brokerId: BrokerId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const broker = getBroker(brokerId);
  const addConnection = useSignupStore((s) => s.addConnection);
  const returned = DEMO_ACCOUNTS[brokerId];

  const [phase, setPhase] = React.useState<Phase>("intro");
  const [stage, setStage] = React.useState(0);
  const [selected, setSelected] = React.useState<string[]>(() => returned.map((a) => a.id));

  // Timed stages. Each one advances after ~700 ms; the last flips to the accounts list.
  React.useEffect(() => {
    if (phase !== "progress") return;
    const t = window.setTimeout(() => {
      if (stage < CONNECT_STAGES.length - 1) setStage((s) => s + 1);
      else setPhase("accounts");
    }, CONNECT_STAGE_MS);
    return () => window.clearTimeout(t);
  }, [phase, stage]);

  const canTrade = broker.capabilities.trading;
  const verb = broker.status === "sync" ? "Sync" : "Connect";

  const toggle = (id: string, checked: boolean) => setSelected((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));

  const addSelected = () => {
    const accounts = returned.filter((a) => selected.includes(a.id));
    addConnection(brokerId, accounts);
    toast.success(`${broker.name} connected`, {
      description: `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} added. ${canTrade ? "Orders route through your own broker session." : "Positions and balances refresh read-only."}`,
    });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Do not let a click outside cancel the hand-off mid-flight.
        if (!next && phase === "progress") return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={phase !== "progress"}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BrokerMark id={brokerId} size="md" />
            <div className="grid gap-1">
              <DialogTitle>
                {verb} {broker.name}
              </DialogTitle>
              <DialogDescription>{phase === "accounts" ? "Choose the accounts to bring into Nasscord." : broker.blurb}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase === "intro" ? (
          <div className="grid gap-4">
            <PermissionList
              title="Nasscord will be able to"
              tone="can"
              items={canTrade ? ["Read positions, balances and order history", "Place and cancel orders you approve, with brackets"] : ["Read positions and balances", "Refresh them on a schedule through the licensed aggregator"]}
            />
            <PermissionList title="Nasscord will not be able to" tone="cannot" items={["Move money or change bank links", "Change your login, password or contact details"]} />
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              You will be sent to {broker.name} to sign in and approve access, then returned here. Your {broker.short} password stays with {broker.short}; Nasscord receives a revocable token.
            </p>
          </div>
        ) : null}

        {phase === "progress" ? (
          <div className="grid gap-4" aria-live="polite" aria-busy="true">
            <Progress value={((stage + 1) / CONNECT_STAGES.length) * 100} aria-label={`${CONNECT_STAGES[stage]}`} />
            <ol className="grid gap-2">
              {CONNECT_STAGES.map((label, i) => {
                const state = i < stage ? "done" : i === stage ? "active" : "todo";
                return (
                  <li key={label} className={cn("flex items-center gap-2 text-sm", state === "todo" && "text-muted-foreground")}>
                    {state === "done" ? (
                      <CheckIcon className="size-4 text-gain-foreground" aria-hidden="true" />
                    ) : state === "active" ? (
                      <LoaderCircleIcon className="size-4 animate-spin text-primary" aria-hidden="true" />
                    ) : (
                      <span className="inline-block size-4 rounded-full border border-input" aria-hidden="true" />
                    )}
                    {label}
                    {state === "active" ? <span className="sr-only">, in progress</span> : null}
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        {phase === "accounts" ? (
          <div className="grid gap-2" role="group" aria-label={`Accounts at ${broker.name}`}>
            {returned.length === 0 ? (
              <p className="text-sm text-muted-foreground">{broker.name} returned no accounts for this login.</p>
            ) : (
              returned.map((a) => <AccountRow key={a.id} account={a} checked={selected.includes(a.id)} onCheckedChange={(c) => toggle(a.id, c)} />)
            )}
          </div>
        ) : null}

        <DialogFooter>
          {phase === "intro" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setStage(0);
                  setPhase("progress");
                }}
              >
                Continue to {broker.short}
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            </>
          ) : null}
          {phase === "progress" ? (
            <Button variant="outline" disabled>
              <LoaderCircleIcon className="animate-spin" />
              Waiting for {broker.short}
            </Button>
          ) : null}
          {phase === "accounts" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={addSelected} disabled={selected.length === 0}>
                Add selected ({selected.length})
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Connected broker: include or exclude accounts, or disconnect. */
export function ManageDialog({ brokerId, open, onOpenChange }: { brokerId: BrokerId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const broker = getBroker(brokerId);
  const connection = useSignupStore((s) => s.connections.find((c) => c.brokerId === brokerId));
  const addConnection = useSignupStore((s) => s.addConnection);
  const removeConnection = useSignupStore((s) => s.removeConnection);
  const all = DEMO_ACCOUNTS[brokerId];
  const [selected, setSelected] = React.useState<string[]>(() => connection?.accounts.map((a) => a.id) ?? []);

  const save = () => {
    const accounts = all.filter((a) => selected.includes(a.id));
    if (accounts.length === 0) {
      removeConnection(brokerId);
      toast(`${broker.name} disconnected`, { description: "No accounts were left selected." });
    } else {
      addConnection(brokerId, accounts);
      toast.success(`${broker.name} updated`, { description: `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} included.` });
    }
    onOpenChange(false);
  };

  const disconnect = () => {
    removeConnection(brokerId);
    toast(`${broker.name} disconnected`, { description: "You can connect it again any time, here or from Settings." });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <BrokerMark id={brokerId} size="md" />
            <div className="grid gap-1">
              <DialogTitle>Manage {broker.name}</DialogTitle>
              <DialogDescription>Included accounts appear in your positions, orders and risk sizing.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="grid gap-2" role="group" aria-label={`Accounts at ${broker.name}`}>
          {all.map((a) => (
            <AccountRow key={a.id} account={a} checked={selected.includes(a.id)} onCheckedChange={(c) => setSelected((prev) => (c ? [...prev, a.id] : prev.filter((x) => x !== a.id)))} />
          ))}
        </div>
        <DialogFooter className="sm:justify-between">
          <Button variant="destructive" onClick={disconnect}>
            <XIcon />
            Disconnect
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AccountRow({ account, checked, onCheckedChange }: { account: DemoAccount; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  const id = `acct-${account.id}`;
  return (
    <Label
      htmlFor={id}
      className={cn("flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 font-normal transition-colors hover:bg-muted/60", checked && "border-primary/60 bg-brand-soft/40")}
    >
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {account.label}
          <span className="font-mono text-xs text-muted-foreground tabular">{account.masked}</span>
        </span>
        <span className="text-xs text-muted-foreground">{ACCOUNT_TYPE_LABEL[account.type]}</span>
      </span>
      <span className="font-mono text-sm tabular">{fmtMoney(account.netLiq)}</span>
    </Label>
  );
}

function PermissionList({ title, items, tone }: { title: string; items: string[]; tone: "can" | "cannot" }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      <ul className="grid gap-1">
        {items.map((it) => (
          <li key={it} className="flex items-start gap-2 text-sm">
            {tone === "can" ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-gain-foreground" aria-hidden="true" /> : <XIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
