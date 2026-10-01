"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { EmptyState } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePlatformOverview } from "@/hooks/queries";
import { BROKERS, getBroker } from "@/lib/brokers";
import { fmtNum } from "@/lib/format";
import type { BrokerId, BrokerMode } from "@/lib/types";
import { ToneBadge } from "./badges";
import { TableSkeleton } from "./primitives";
import { useConsoleStore } from "./store";

const MODE_LABEL: Record<BrokerMode, string> = { direct: "Direct API", aggregator: "Aggregator", planned: "Planned" };

/** OAuth client registration per broker. Missing = the integration exists but no production client id is stored yet. */
const OAUTH_MISSING: BrokerId[] = ["webull", "moomoo", "public"];

/** Requests per minute allowed by each broker and the platform's current use. */
const RATE_LIMITS: Record<BrokerId, { used: number; limit: number; unit: string }> = {
  ibkr: { used: 41, limit: 60, unit: "req/s per session" },
  schwab: { used: 74, limit: 120, unit: "req/min" },
  etrade: { used: 22, limit: 60, unit: "req/min" },
  tastytrade: { used: 18, limit: 120, unit: "req/min" },
  tradier: { used: 31, limit: 120, unit: "req/min" },
  alpaca: { used: 96, limit: 200, unit: "req/min" },
  tradestation: { used: 9, limit: 60, unit: "req/min" },
  webull: { used: 3, limit: 30, unit: "req/min" },
  fidelity: { used: 12, limit: 40, unit: "syncs/min" },
  robinhood: { used: 6, limit: 40, unit: "syncs/min" },
  moomoo: { used: 0, limit: 0, unit: "" },
  public: { used: 0, limit: 0, unit: "" },
};

const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export function BrokersPage() {
  const overview = usePlatformOverview();
  const enabled = useConsoleStore((s) => s.brokerEnabled);
  const setEnabled = useConsoleStore((s) => s.setBrokerEnabled);
  const health = React.useMemo(() => new Map((overview.data?.brokerHealth ?? []).map((h) => [h.brokerId, h] as const)), [overview.data]);

  return (
    <div className="flex flex-col gap-5">
      <Alert>
        <Info />
        <AlertTitle>Three integration modes</AlertTitle>
        <AlertDescription>
          <span className="font-medium text-foreground">Direct API</span> brokers trade through their own OAuth or session API. <span className="font-medium text-foreground">Aggregator</span> brokers (Fidelity, Robinhood) have no public trading API, so positions and balances sync read-only through a licensed aggregator. <span className="font-medium text-foreground">Coming soon</span> brokers are on the roadmap and hidden from traders until enabled here.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Broker registry</CardTitle>
          <CardDescription>All 12 integrations. Disabling a broker hides it from the connect flow for every trader; existing connections keep syncing.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.isLoading ? (
            <TableSkeleton rows={8} cols={7} />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Broker</TableHead>
                    <TableHead className={TH}>Mode</TableHead>
                    <TableHead className={TH}>Status</TableHead>
                    <TableHead className={TH}>OAuth client</TableHead>
                    <TableHead className={`${TH} text-right`}>Connected accounts</TableHead>
                    <TableHead className={`${TH} w-52`}>Rate limit</TableHead>
                    <TableHead className={`${TH} text-right`}>Enabled for traders</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {BROKERS.map((b) => {
                    const h = health.get(b.id);
                    const rl = RATE_LIMITS[b.id];
                    const oauthMissing = OAUTH_MISSING.includes(b.id);
                    const id = `broker-enabled-${b.id}`;
                    return (
                      <TableRow key={b.id}>
                        <TableCell>
                          <span className="flex items-center gap-2.5">
                            <BrokerMark id={b.id} size="md" />
                            <span className="grid gap-0.5">
                              <span className="font-medium">{b.name}</span>
                              <span className="max-w-64 truncate text-xs text-muted-foreground">{b.blurb}</span>
                            </span>
                          </span>
                        </TableCell>
                        <TableCell>{MODE_LABEL[b.mode]}</TableCell>
                        <TableCell>
                          <BrokerStatusBadge status={b.status} />
                        </TableCell>
                        <TableCell>{b.mode === "planned" && oauthMissing ? <ToneBadge tone="neutral">Not started</ToneBadge> : oauthMissing ? <ToneBadge tone="warn">Missing</ToneBadge> : <ToneBadge tone="good">Configured</ToneBadge>}</TableCell>
                        <TableCell className="text-right tabular">{h ? fmtNum(h.accounts) : <span className="text-muted-foreground">0</span>}</TableCell>
                        <TableCell>
                          {rl.limit > 0 ? (
                            <span className="grid gap-1">
                              <Progress value={(rl.used / rl.limit) * 100} aria-label={`${rl.used} of ${rl.limit} ${rl.unit}`} className="flex-nowrap" />
                              <span className="text-xs text-muted-foreground tabular">
                                {rl.used} / {rl.limit} {rl.unit}
                              </span>
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not connected</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            id={id}
                            checked={enabled[b.id]}
                            aria-label={`${b.name} enabled for traders`}
                            onCheckedChange={(on) => {
                              setEnabled(b.id, on);
                              toast.success(on ? `${b.name} is available to traders` : `${b.name} hidden from the connect flow`, {
                                description: b.mode === "planned" && on ? "Traders will see it as coming soon." : undefined,
                              });
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gateway pools</CardTitle>
          <CardDescription>Each IBKR login needs its own gateway session, so pools scale per trader login rather than per request. Other brokers share stateless OAuth clients.</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.isLoading ? (
            <TableSkeleton rows={3} cols={6} />
          ) : (overview.data?.gatewayPools ?? []).length === 0 ? (
            <EmptyState title="No gateway pools" description="Pools appear when the first IBKR trader connects." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Pool</TableHead>
                    <TableHead className={TH}>Broker</TableHead>
                    <TableHead className={TH}>Ports</TableHead>
                    <TableHead className={`${TH} text-right`}>Sessions</TableHead>
                    <TableHead className={`${TH} w-56`}>Healthy</TableHead>
                    <TableHead className={TH}>Region</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.data!.gatewayPools.map((p) => {
                    const pct = p.sessions ? (p.healthy / p.sessions) * 100 : 0;
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-xs">{p.id}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <BrokerMark id={p.broker} size="xs" />
                            {getBroker(p.broker).short}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular">{p.ports}</TableCell>
                        <TableCell className="text-right tabular">{p.sessions}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-3">
                            <Progress value={pct} aria-label={`${p.healthy} of ${p.sessions} healthy`} className="flex-1 flex-nowrap" />
                            <span className="w-14 text-right text-xs tabular">
                              {p.healthy}/{p.sessions}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="font-mono text-[11px]">
                            {p.region}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
