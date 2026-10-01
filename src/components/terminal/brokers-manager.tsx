"use client";

import * as React from "react";
import { toast } from "sonner";
import { BellIcon, CheckIcon, ExternalLinkIcon, LoaderCircleIcon, PlugZapIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { EmptyState } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { BROKERS, getBroker } from "@/lib/brokers";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { AccountType, Broker, BrokerAccount, BrokerConnection, BrokerId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CONNECTION_TONE, connectionTiming } from "@/components/terminal/broker-health";
import { useAccountScope } from "@/components/terminal/hooks";
import { CardSkeleton } from "@/components/terminal/skeletons";
import { useTerminalStore } from "@/components/terminal/store";

const ACCOUNT_TYPE: Record<AccountType, string> = { individual: "Individual", ira: "IRA", roth: "Roth IRA", margin: "Margin", paper: "Paper" };
const PERMISSION: Record<BrokerConnection["permissions"][number], string> = { read: "Read", trade: "Trade", options: "Options" };
const STAGES = ["Redirecting to the broker", "Authorizing Nasscord", "Fetching accounts"] as const;
const STAGE_MS = 700;

/** Accounts a broker returns in the simulated OAuth hand-off (for brokers the demo trader has not connected yet). */
const RETURNED: Partial<Record<BrokerId, Array<Pick<BrokerAccount, "id" | "label" | "masked" | "type" | "netLiq">>>> = {
  etrade: [{ id: "acc_etrade_1", label: "Individual", masked: "••••4417", type: "individual", netLiq: 27_340.18 }],
  tastytrade: [{ id: "acc_tasty_1", label: "Margin", masked: "5WT•••92", type: "margin", netLiq: 18_205.6 }],
  tradier: [{ id: "acc_tradier_1", label: "Individual", masked: "6YA•••03", type: "individual", netLiq: 12_880 }],
  tradestation: [{ id: "acc_ts_1", label: "Margin", masked: "1147•••8", type: "margin", netLiq: 45_120.75 }],
  webull: [{ id: "acc_webull_1", label: "Individual", masked: "••••3306", type: "individual", netLiq: 6_410.22 }],
  fidelity: [{ id: "acc_fidelity_1", label: "Individual", masked: "Z••••512", type: "individual", netLiq: 142_880.3 }],
  robinhood: [{ id: "acc_rh_1", label: "Individual", masked: "••••7728", type: "individual", netLiq: 4_915.44 }],
};

export function BrokersManager() {
  const scope = useAccountScope();
  const setIncluded = useTerminalStore((s) => s.setIncluded);
  const overrides = useTerminalStore((s) => s.includedOverrides);
  const hydrated = useTerminalStore((s) => s.hydrated);
  const [connecting, setConnecting] = React.useState<BrokerId | null>(null);
  const [notified, setNotified] = React.useState<BrokerId[]>([]);

  if (scope.isLoading || !hydrated) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
      </div>
    );
  }

  const connectedIds = new Set(scope.connections.map((c) => c.brokerId));
  const remaining = BROKERS.filter((b) => !connectedIds.has(b.id));

  const reconnect = (b: Broker) => {
    toast.loading(`Reconnecting ${b.short}…`, { id: `re-${b.id}` });
    window.setTimeout(() => toast.success(`${b.short} session renewed`, { id: `re-${b.id}`, description: b.id === "ibkr" ? "Gateway re-authenticated with your login and second factor." : "OAuth token refreshed. No orders were affected." }), 900);
  };

  return (
    <>
      <section className="grid gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Connected</h2>
        {scope.connections.length === 0 ? (
          <EmptyState title="No brokers connected" description="Connect a broker below. Orders route through your own broker session; Nasscord never holds your funds." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {scope.connections.map((c) => {
              const b = getBroker(c.brokerId);
              const tone = CONNECTION_TONE[c.status];
              return (
                <Card key={c.brokerId}>
                  <CardHeader>
                    <div className="flex items-start gap-3">
                      <BrokerMark id={c.brokerId} size="lg" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <CardTitle>{b.name}</CardTitle>
                          <StatusDot tone={tone.tone} label={<span className="text-xs">{tone.label}</span>} pulse={c.status === "syncing"} />
                        </div>
                        <CardDescription>
                          {connectionTiming(c)} · connected {fmtDate(c.connectedAt)}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-2">
                    {c.accounts.map((a) => {
                      const inc = overrides[a.id] ?? a.included;
                      const sid = `inc-${a.id}`;
                      return (
                        <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                          <Label htmlFor={sid} className="grid min-w-0 cursor-pointer gap-0.5 font-normal">
                            <span className="flex items-center gap-2 text-sm font-medium">
                              {a.label}
                              <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {ACCOUNT_TYPE[a.type]} · {fmtMoney(a.netLiq, { digits: 0 })} net liq
                            </span>
                          </Label>
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="hidden sm:inline">{inc ? "Included" : "Excluded"}</span>
                            <Switch
                              id={sid}
                              checked={inc}
                              aria-label={`Include ${b.short} ${a.label} ${a.masked}`}
                              onCheckedChange={(v) => {
                                setIncluded(a.id, v);
                                toast(v ? `${b.short} ${a.label} included` : `${b.short} ${a.label} excluded`, { description: v ? "Counts toward totals, sizing and positions." : "Hidden from totals and sizing until you include it again." });
                              }}
                            />
                          </span>
                        </div>
                      );
                    })}
                  </CardContent>
                  <CardContent className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {c.permissions.map((p) => (
                        <Badge key={p} variant="outline">
                          {PERMISSION[p]}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => reconnect(b)}>
                        <RefreshCwIcon />
                        Reconnect
                      </Button>
                      <Button variant="outline" size="sm" render={<a href={`https://${b.site}`} target="_blank" rel="noreferrer" />} onClick={() => toast(`Opening ${b.short} in a new tab`, { description: "Revoke or change permissions on the broker's side; Nasscord picks up the change within a minute." })}>
                        Manage
                        <ExternalLinkIcon data-icon="inline-end" />
                      </Button>
                    </div>
                  </CardContent>
                  {c.note ? <CardContent className="text-xs text-muted-foreground">{c.note}</CardContent> : null}
                </Card>
              );
            })}
          </div>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">Add a broker</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {remaining.map((b) => {
            const soon = b.status === "soon";
            const isNotified = notified.includes(b.id);
            return (
              <Card key={b.id} size="sm" className="gap-3">
                <div className="flex items-start gap-3 px-3">
                  <BrokerMark id={b.id} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{b.name}</span>
                      <BrokerStatusBadge status={b.status} />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{b.blurb}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 px-3">
                  <span className="text-[11px] text-muted-foreground">
                    {b.capabilities.trading ? "Trading" : "Read-only"}
                    {b.capabilities.options ? " · options" : ""}
                    {b.capabilities.extendedHours ? " · extended hours" : ""}
                    {b.capabilities.paper ? " · paper" : ""}
                  </span>
                  {soon ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isNotified}
                      onClick={() => {
                        setNotified((n) => [...n, b.id]);
                        toast.success(`We will email you when ${b.name} is live`);
                      }}
                    >
                      <BellIcon />
                      {isNotified ? "On the list" : "Notify me"}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setConnecting(b.id)}>
                      <PlugZapIcon />
                      {b.status === "sync" ? "Sync" : "Connect"}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {connecting ? <ConnectDialog key={connecting} brokerId={connecting} open onOpenChange={(o) => !o && setConnecting(null)} /> : null}
    </>
  );
}

type Phase = "intro" | "progress" | "accounts";

/** Simulated OAuth hand-off: intro -> three timed stages -> returned accounts -> connected. */
function ConnectDialog({ brokerId, open, onOpenChange }: { brokerId: BrokerId; open: boolean; onOpenChange: (open: boolean) => void }) {
  const broker = getBroker(brokerId);
  const addSessionConnection = useTerminalStore((s) => s.addSessionConnection);
  const returned = RETURNED[brokerId] ?? [];
  const [phase, setPhase] = React.useState<Phase>("intro");
  const [stage, setStage] = React.useState(0);
  const [selected, setSelected] = React.useState<string[]>(() => returned.map((a) => a.id));

  React.useEffect(() => {
    if (phase !== "progress") return;
    const t = window.setTimeout(() => {
      if (stage < STAGES.length - 1) setStage((s) => s + 1);
      else setPhase("accounts");
    }, STAGE_MS);
    return () => window.clearTimeout(t);
  }, [phase, stage]);

  const canTrade = broker.capabilities.trading;

  const finish = () => {
    const accounts: BrokerAccount[] = returned
      .filter((a) => selected.includes(a.id))
      .map((a) => ({ ...a, brokerId, buyingPower: Math.round(a.netLiq * 0.6), cash: Math.round(a.netLiq * 0.25), dayPnl: 0, included: true }));
    addSessionConnection({
      brokerId,
      status: canTrade ? "connected" : "syncing",
      connectedAt: new Date().toISOString(),
      tokenRenewsAt: canTrade ? new Date(Date.now() + 30 * 60_000).toISOString() : undefined,
      permissions: canTrade ? (broker.capabilities.options ? ["read", "trade", "options"] : ["read", "trade"]) : ["read"],
      accounts,
      note: canTrade ? undefined : "Read-only sync through a licensed aggregator. Balances refresh every few minutes.",
    });
    toast.success(`${broker.name} connected`, { description: `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"} added. ${canTrade ? "Orders route through your own broker session." : "Positions and balances refresh read-only."}` });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
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
                {broker.status === "sync" ? "Sync" : "Connect"} {broker.name}
              </DialogTitle>
              <DialogDescription>{phase === "accounts" ? "Choose the accounts to bring into the terminal." : broker.blurb}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {phase === "intro" ? (
          <div className="grid gap-3">
            <PermissionList title="Nasscord will be able to" tone="can" items={canTrade ? ["Read positions, balances and order history", "Place and cancel orders you approve, with brackets"] : ["Read positions and balances", "Refresh them on a schedule through the licensed aggregator"]} />
            <PermissionList title="Nasscord will not be able to" tone="cannot" items={["Move money or change bank links", "Change your login, password or contact details"]} />
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              You will be sent to {broker.name} to sign in and approve access, then returned here. Your {broker.short} password stays with {broker.short}; Nasscord receives a revocable token.
            </p>
          </div>
        ) : null}

        {phase === "progress" ? (
          <div className="grid gap-3" aria-live="polite" aria-busy="true">
            <Progress value={((stage + 1) / STAGES.length) * 100} aria-label={STAGES[stage]} />
            <ol className="grid gap-2">
              {STAGES.map((label, i) => {
                const state = i < stage ? "done" : i === stage ? "active" : "todo";
                return (
                  <li key={label} className={cn("flex items-center gap-2 text-sm", state === "todo" && "text-muted-foreground")}>
                    {state === "done" ? <CheckIcon className="size-4 text-gain-foreground" aria-hidden="true" /> : state === "active" ? <LoaderCircleIcon className="size-4 animate-spin text-primary" aria-hidden="true" /> : <span className="inline-block size-4 rounded-full border border-input" aria-hidden="true" />}
                    {label}
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
              returned.map((a) => {
                const cid = `conn-${a.id}`;
                const checked = selected.includes(a.id);
                return (
                  <Label key={a.id} htmlFor={cid} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 font-normal transition-colors hover:bg-muted/60", checked && "border-primary/60 bg-brand-soft/40")}>
                    <Checkbox id={cid} checked={checked} onCheckedChange={(c) => setSelected((prev) => (c ? [...prev, a.id] : prev.filter((x) => x !== a.id)))} />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {a.label}
                        <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{ACCOUNT_TYPE[a.type]}</span>
                    </span>
                    <span className="font-mono text-sm tabular">{fmtMoney(a.netLiq)}</span>
                  </Label>
                );
              })
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
              <Button onClick={finish} disabled={selected.length === 0}>
                Add selected ({selected.length})
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
