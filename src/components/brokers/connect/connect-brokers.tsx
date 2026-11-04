"use client";

import * as React from "react";
import { PlugZapIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BROKERS, CONNECTABLE_BROKERS, isConnectable, type ConnectableBrokerId } from "@/lib/brokers";
import { cn } from "@/lib/utils";
import { EtradeConnectDialog } from "@/components/brokers/connect/etrade-dialog";
import { IbkrConnectDialog } from "@/components/brokers/connect/ibkr-dialog";

/** What each connectable broker asks of the user, in one line. */
export const CONNECT_HOW: Record<ConnectableBrokerId, string> = {
  ibkr: "Log in on IBKR's own page, with its second factor. Live or paper. A session lasts about a day.",
  etrade: "Use a consumer key you create on developer.etrade.com and approve Nasscord on E*TRADE. Sessions end at midnight Eastern.",
};

const NOT_YET = "Not available yet";

/**
 * The connect entry point, shared by onboarding step 3 and the terminal's Brokers page.
 * Only brokers where isConnectable() is true get a Connect button and open a real connect dialog;
 * every other broker in the registry says "Not available yet".
 * `layout="grid"`: every broker as a tile (Brokers page). `layout="list"`: the connectable brokers as
 * rows and the others as one compact line (onboarding).
 */
export function ConnectBrokers({ layout = "grid", className }: { layout?: "grid" | "list"; className?: string }) {
  const [open, setOpen] = React.useState<ConnectableBrokerId | null>(null);
  // A new key per open, so each dialog starts from its first step.
  const [round, setRound] = React.useState(0);
  const connect = (id: ConnectableBrokerId) => {
    setRound((r) => r + 1);
    setOpen(id);
  };
  const others = BROKERS.filter((b) => !isConnectable(b.id));

  return (
    <>
      {layout === "list" ? (
        <div className={cn("grid gap-3", className)}>
          <ul className="grid gap-3" aria-label="Brokers you can connect today">
            {CONNECTABLE_BROKERS.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-3">
                <BrokerMark id={b.id} size="md" />
                <div className="grid min-w-0 flex-1 basis-48 gap-0.5">
                  <span className="text-sm font-semibold">{b.name}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{CONNECT_HOW[b.id as ConnectableBrokerId]}</span>
                </div>
                <Button size="sm" onClick={() => connect(b.id as ConnectableBrokerId)}>
                  <PlugZapIcon />
                  Connect
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {NOT_YET}: {others.map((b) => b.name).join(", ")}.
          </p>
        </div>
      ) : (
        <div className={cn("grid gap-5", className)}>
          <div className="grid gap-3 sm:grid-cols-2">
            {CONNECTABLE_BROKERS.map((b) => (
              <Card key={b.id} size="sm" className="gap-3">
                <div className="flex items-start gap-3 px-3">
                  <BrokerMark id={b.id} size="md" />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{b.name}</span>
                    <p className="mt-0.5 text-xs text-muted-foreground">{CONNECT_HOW[b.id as ConnectableBrokerId]}</p>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 px-3">
                  <Button size="sm" onClick={() => connect(b.id as ConnectableBrokerId)}>
                    <PlugZapIcon />
                    Connect
                  </Button>
                </div>
              </Card>
            ))}
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-medium text-muted-foreground">Not available yet: Nasscord cannot connect to these brokers in this release.</p>
            <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              {others.map((b) => (
                <li key={b.id} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2">
                  <BrokerMark id={b.id} size="sm" className="opacity-60" />
                  <span className="grid min-w-0">
                    <span className="truncate text-sm">{b.name}</span>
                    <span className="text-[11px] text-muted-foreground">{NOT_YET}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {open === "ibkr" ? <IbkrConnectDialog key={`ibkr-${round}`} open onOpenChange={(o) => !o && setOpen(null)} /> : null}
      {open === "etrade" ? <EtradeConnectDialog key={`etrade-${round}`} open onOpenChange={(o) => !o && setOpen(null)} /> : null}
    </>
  );
}
