"use client";

import * as React from "react";
import { ChevronDownIcon, CircleAlertIcon, PlugZapIcon } from "lucide-react";
import { useBrokerOptions } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { connectChoices, connectableNow, type ConnectChoice } from "@/lib/broker-connect";
import { BROKERS, getBroker } from "@/lib/brokers";
import type { Broker, BrokerId, BrokerOptions } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AggregatorDialog } from "@/components/brokers/connect/aggregator-dialog";
import { ApiKeyDialog } from "@/components/brokers/connect/api-key-dialog";
import { EtradeConnectDialog } from "@/components/brokers/connect/etrade-dialog";
import { IbkrConnectDialog } from "@/components/brokers/connect/ibkr-dialog";
import { OAuthDialog } from "@/components/brokers/connect/oauth-dialog";
import { isOwnerOnly } from "@/components/brokers/connect/spec-parts";

/*
 * The connect entry point, shared by onboarding step 3 and the terminal's Brokers page. What a user
 * can connect comes from the broker service at run time (GET /api/broker/options, through
 * useBrokerOptions), joined with each broker's connect specs (src/lib/broker-connect) by
 * connectChoices(). A broker gets Connect only for a way the service offers this user now; every
 * other broker says "Not available yet" with the reason. Nothing here reads the static `status` of
 * src/lib/brokers.ts, which is for pages that cannot ask the service.
 */

interface BrokerRow {
  broker: Broker;
  choices: ConnectChoice[];
  available: ConnectChoice[];
}

function rowsFor(options: BrokerOptions | undefined): BrokerRow[] {
  return BROKERS.map((broker) => {
    const choices = connectChoices(broker.id, options);
    return { broker, choices, available: choices.filter((c) => c.available) };
  });
}

/** "Not available yet: Nasscord is waiting for ..." reads as "Nasscord is waiting for ..." under that heading. */
function reasonText(row: BrokerRow): string {
  const raw = row.choices[0]?.reason ?? "Nasscord cannot connect to this broker yet.";
  const text = raw.replace(/^Not available yet:\s*/i, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "IBKR", "IBKR or E*TRADE", "IBKR, E*TRADE or Alpaca". */
function orList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/**
 * The brokers this user can connect right now, as words for copy ("IBKR, E*TRADE or Alpaca"), from
 * the broker service. Null while unknown, or when there are too many to list in a sentence.
 */
export function useConnectableNames(): string | null {
  const { data } = useBrokerOptions();
  return React.useMemo(() => {
    if (!data) return null;
    const ids = connectableNow(data);
    if (ids.length === 0 || ids.length > 4) return null;
    return orList(ids.map((id) => getBroker(id).short));
  }, [data]);
}

type Opening = { brokerId: BrokerId; choice: ConnectChoice; round: number } | null;

export function ConnectBrokers({ layout = "grid", className }: { layout?: "grid" | "list"; className?: string }) {
  const options = useBrokerOptions();
  const [open, setOpen] = React.useState<Opening>(null);
  // A new key per open, so each dialog starts from its first step.
  const [round, setRound] = React.useState(0);
  const connect = (brokerId: BrokerId, choice: ConnectChoice) => {
    setRound((r) => r + 1);
    setOpen({ brokerId, choice, round: round + 1 });
  };
  const close = () => setOpen(null);

  const rows = React.useMemo(() => rowsFor(options.data), [options.data]);
  const ready = rows.filter((r) => r.available.length > 0);
  const others = rows.filter((r) => r.available.length === 0);

  let body: React.ReactNode;
  if (options.isPending) {
    body = <ConnectSkeleton layout={layout} />;
  } else if (options.isError && !options.data) {
    body = (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Nasscord could not check which brokers you can connect</AlertTitle>
        <AlertDescription className="grid gap-2">
          <span>{options.error.message}</span>
          <Button size="sm" variant="outline" className="justify-self-start" onClick={() => void options.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (layout === "list") {
    body = (
      <div className="grid gap-3">
        {ready.length > 0 ? (
          <ul className="grid gap-3" aria-label="Brokers you can connect now">
            {ready.map((r) => (
              <li key={r.broker.id} className="grid gap-2 rounded-xl border border-border px-3 py-3">
                {r.available.map((choice, i) => (
                  <div key={`${choice.spec.method}-${choice.spec.client ?? "none"}`} className="flex flex-wrap items-center gap-3">
                    {i === 0 ? <BrokerMark id={r.broker.id} size="md" /> : <span className="hidden w-9 sm:block" aria-hidden="true" />}
                    <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        {i === 0 ? r.broker.name : choice.spec.title}
                        <ChoiceBadges choice={choice} />
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">{choice.spec.summary}</span>
                    </div>
                    <Button size="sm" variant={i === 0 ? "default" : "outline"} onClick={() => connect(r.broker.id, choice)} aria-label={`Connect ${r.broker.name}: ${choice.spec.title}`}>
                      <PlugZapIcon />
                      Connect
                    </Button>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No broker can be connected on this server right now.</p>
        )}
        {others.length > 0 ? <NotAvailableList rows={others} /> : null}
      </div>
    );
  } else {
    body = (
      <div className="grid gap-5">
        {ready.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {ready.map((r) => (
              <Card key={r.broker.id} size="sm" className="gap-3">
                <div className="flex items-start gap-3 px-3">
                  <BrokerMark id={r.broker.id} size="md" />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {r.broker.name}
                      {r.available.length === 1 ? <ChoiceBadges choice={r.available[0]} /> : null}
                    </span>
                    {r.available.length === 1 ? <p className="text-xs text-muted-foreground">{r.available[0].spec.summary}</p> : null}
                  </div>
                </div>
                {r.available.length === 1 ? (
                  <div className="flex items-center justify-end gap-2 px-3">
                    <Button size="sm" onClick={() => connect(r.broker.id, r.available[0])}>
                      <PlugZapIcon />
                      Connect
                    </Button>
                  </div>
                ) : (
                  <ul className="grid gap-2 px-3" aria-label={`Ways to connect ${r.broker.name}`}>
                    {r.available.map((choice, i) => (
                      <li key={`${choice.spec.method}-${choice.spec.client ?? "none"}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-2">
                        <div className="grid min-w-0 flex-1 basis-40 gap-0.5">
                          <span className="flex flex-wrap items-center gap-2 text-sm">
                            {choice.spec.title}
                            <ChoiceBadges choice={choice} />
                          </span>
                          <span className="text-xs text-muted-foreground">{choice.spec.summary}</span>
                        </div>
                        <Button size="sm" variant={i === 0 ? "default" : "outline"} onClick={() => connect(r.broker.id, choice)} aria-label={`Connect ${r.broker.name}: ${choice.spec.title}`}>
                          <PlugZapIcon />
                          Connect
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No broker can be connected on this server right now.</p>
        )}
        {others.length > 0 ? (
          <div className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Not available yet: Nasscord cannot connect to these brokers for you right now.</p>
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {others.map((r) => (
                <li key={r.broker.id} className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2">
                  <BrokerMark id={r.broker.id} size="sm" className="mt-0.5 opacity-60" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="truncate text-sm">{r.broker.name}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{reasonText(r)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className={className}>{body}</div>
      {open ? <ConnectFlowDialog key={`${open.brokerId}-${open.round}`} brokerId={open.brokerId} choice={open.choice} onClose={close} /> : null}
    </>
  );
}

/**
 * The list layout's (onboarding) brokers that cannot be connected yet: their names in one line that
 * opens to each broker's reason, so the step stays short and every reason is still one tap away.
 */
function NotAvailableList({ rows }: { rows: BrokerRow[] }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2">
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" size="sm" className="h-auto w-fit -ml-2.5 items-start justify-start py-1 text-left whitespace-normal text-muted-foreground hover:text-foreground" />}
      >
        <ChevronDownIcon className={cn("mt-px shrink-0 transition-transform", open && "rotate-180")} />
        <span className="text-xs">Not available yet: {rows.map((r) => r.broker.short).join(", ")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="grid gap-2" aria-label="Brokers not available yet">
          {rows.map((r) => (
            <li key={r.broker.id} className="flex items-start gap-2">
              <BrokerMark id={r.broker.id} size="sm" className="mt-0.5 opacity-60" />
              <span className="grid min-w-0 gap-0.5">
                <span className="text-sm">{r.broker.name}</span>
                <span className="text-xs leading-snug text-muted-foreground">{reasonText(r)}</span>
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** "via SnapTrade" for an aggregator way, "Owner only" for a way only the platform owner can use yet. */
function ChoiceBadges({ choice }: { choice: ConnectChoice }) {
  return (
    <>
      {choice.spec.via === "snaptrade" ? <Badge variant="secondary">via SnapTrade</Badge> : null}
      {isOwnerOnly(choice.option) ? (
        <Badge variant="outline" title="Only you, the platform owner, can connect this way until the broker approves Nasscord.">
          Owner only
        </Badge>
      ) : null}
    </>
  );
}

/** The dialog of one way of connecting, by its flow. */
export function ConnectFlowDialog({ brokerId, choice, onClose }: { brokerId: BrokerId; choice: ConnectChoice; onClose: () => void }) {
  const onOpenChange = (o: boolean) => {
    if (!o) onClose();
  };
  const ownerOnly = isOwnerOnly(choice.option);
  switch (choice.spec.flow) {
    case "gateway_login":
      return <IbkrConnectDialog open onOpenChange={onOpenChange} />;
    case "oauth1_verifier":
      return <EtradeConnectDialog open onOpenChange={onOpenChange} />;
    case "api_key":
      return <ApiKeyDialog open onOpenChange={onOpenChange} brokerId={brokerId} spec={choice.spec} environments={choice.environments} ownerOnly={ownerOnly} />;
    case "oauth2_user_app":
    case "oauth2_platform":
      return <OAuthDialog open onOpenChange={onOpenChange} brokerId={brokerId} spec={choice.spec} option={choice.option} environments={choice.environments} ownerOnly={ownerOnly} />;
    case "aggregator_portal":
      return <AggregatorDialog open onOpenChange={onOpenChange} brokerId={brokerId} spec={choice.spec} environments={choice.environments} ownerOnly={ownerOnly} />;
  }
}

function ConnectSkeleton({ layout }: { layout: "grid" | "list" }) {
  return (
    <div className={cn("grid gap-3", layout === "grid" && "sm:grid-cols-2")} aria-busy="true" aria-label="Checking which brokers you can connect">
      <Skeleton className={cn("w-full rounded-xl", layout === "grid" ? "h-28" : "h-16")} />
      <Skeleton className={cn("w-full rounded-xl", layout === "grid" ? "h-28" : "h-16")} />
    </div>
  );
}
