"use client";

import Link from "next/link";
import { useConnections } from "@/hooks/queries";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusDot } from "@/components/status-dot";
import { getBroker } from "@/lib/brokers";
import { DEMO_NOW } from "@/lib/demo-clock";
import { fmtTimeET, timeAgo } from "@/lib/format";
import type { BrokerConnection, ConnectionStatus } from "@/lib/types";
import { CardSkeleton } from "@/components/terminal/skeletons";

export const CONNECTION_TONE: Record<ConnectionStatus, { tone: "good" | "warn" | "bad" | "brand"; label: string }> = {
  connected: { tone: "good", label: "Connected" },
  expiring: { tone: "warn", label: "Expiring" },
  disconnected: { tone: "bad", label: "Disconnected" },
  syncing: { tone: "brand", label: "Syncing" },
};

/** One line of session/token timing for a connection, measured from the demo clock the connection data is pinned to. */
export function connectionTiming(c: BrokerConnection, now: Date = DEMO_NOW) {
  if (c.tokenRenewsAt) return `Token renews ${fmtTimeET(c.tokenRenewsAt)}`;
  if (c.sessionExpiresAt) {
    const ms = new Date(c.sessionExpiresAt).getTime() - now.getTime();
    const h = Math.max(0, Math.round(ms / 3_600_000));
    return h > 0 ? `Gateway session · ${h} h left` : "Gateway session · re-login due";
  }
  return `Connected ${timeAgo(c.connectedAt, now)}`;
}

export function BrokerHealthCard() {
  const { data, isLoading } = useConnections();
  if (isLoading || !data) return <CardSkeleton lines={3} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Broker health</CardTitle>
        <CardDescription>Sessions and tokens behind your orders.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {data.map((c) => {
          const s = CONNECTION_TONE[c.status];
          return (
            <div key={c.brokerId} className="flex items-start gap-3">
              <BrokerMark id={c.brokerId} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{getBroker(c.brokerId).name}</span>
                  <StatusDot tone={s.tone} label={<span className="text-xs">{s.label}</span>} pulse={c.status === "syncing"} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.accounts.length} {c.accounts.length === 1 ? "account" : "accounts"} · {connectionTiming(c)}
                </p>
              </div>
            </div>
          );
        })}
      </CardContent>
      <CardContent>
        <Button variant="outline" size="sm" className="w-full" render={<Link href="/app/brokers" />}>
          Manage brokers
        </Button>
      </CardContent>
    </Card>
  );
}
