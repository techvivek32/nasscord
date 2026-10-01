"use client";

import * as React from "react";
import { RotateCw } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePlatformOverview } from "@/hooks/queries";
import { fmtDateTime, timeAgo } from "@/lib/format";
import type { ServiceHealth } from "@/lib/types";
import { IncidentStatusBadge, SeverityBadge } from "./badges";
import { DEMO_NOW, HEALTH, MAINTENANCE_EXEMPT, MAINTENANCE_WINDOW } from "./lib";
import { MaintenanceSwitch } from "./maintenance-gate";
import { KV, ListSkeleton, TableSkeleton } from "./primitives";
import { useConsoleStore } from "./store";

const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export function HealthPage() {
  const overview = usePlatformOverview();
  const maintenanceOn = useConsoleStore((s) => s.maintenanceOn);
  const restartedAt = useConsoleStore((s) => s.restartedAt);
  const markRestarted = useConsoleStore((s) => s.markRestarted);
  const [pending, setPending] = React.useState<ServiceHealth | null>(null);
  const [restarting, setRestarting] = React.useState<string | null>(null);

  const services = overview.data?.services ?? [];
  const incidents = [...(overview.data?.incidents ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const degraded = services.filter((s) => s.status !== "healthy").length;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Services</CardTitle>
          <CardDescription>{overview.data ? (degraded === 0 ? "All services healthy." : `${degraded} of ${services.length} services degraded.`) : "Fleet status, refreshed every 30 seconds."}</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.isLoading ? (
            <TableSkeleton rows={8} cols={7} />
          ) : services.length === 0 ? (
            <EmptyState title="No services registered" />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Service</TableHead>
                    <TableHead className={`${TH} text-right`}>Instances</TableHead>
                    <TableHead className={TH}>Status</TableHead>
                    <TableHead className={`${TH} text-right`}>Uptime 30d</TableHead>
                    <TableHead className={`${TH} text-right`}>p95</TableHead>
                    <TableHead className={TH}>Last restart</TableHead>
                    <TableHead className="w-24" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map((s) => {
                    const last = restartedAt[s.id] ?? s.lastRestartAt;
                    const now = restartedAt[s.id] ? new Date() : DEMO_NOW;
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <span className="grid gap-0.5">
                            <span className="font-medium">{s.name}</span>
                            <span className="max-w-72 truncate text-xs text-muted-foreground">{s.role}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular">{s.instances}</TableCell>
                        <TableCell>
                          <StatusDot tone={HEALTH[s.status].tone} label={HEALTH[s.status].label} pulse={s.status === "degraded"} />
                        </TableCell>
                        <TableCell className={`text-right tabular ${s.uptime30d < 99.5 ? "text-warn-foreground" : ""}`}>{s.uptime30d.toFixed(2)}%</TableCell>
                        <TableCell className={`text-right font-mono text-xs tabular ${s.p95Ms >= 1000 ? "text-warn-foreground" : ""}`}>{s.p95Ms} ms</TableCell>
                        <TableCell className="text-muted-foreground">{timeAgo(last, now)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="xs" disabled={restarting === s.id} onClick={() => setPending(s)}>
                            <RotateCw data-icon="inline-start" className={restarting === s.id ? "animate-spin" : undefined} />
                            {restarting === s.id ? "Restarting" : "Restart"}
                          </Button>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Maintenance gate</CardTitle>
            <CardDescription>Blocks trader and tenant user terminals during regular hours while the fleet is being worked on. The super admin stays exempt.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <label htmlFor="health-maintenance" className="grid cursor-pointer gap-0.5">
                <span className="text-sm font-medium">{maintenanceOn ? "Gate is on" : "Gate is off"}</span>
                <span className="text-xs text-muted-foreground">{maintenanceOn ? "Terminals show the maintenance page in the active window." : "Terminals render normally."}</span>
              </label>
              <MaintenanceSwitch id="health-maintenance" />
            </div>
            <KV
              items={[
                { label: "Active window", value: MAINTENANCE_WINDOW },
                { label: "Exempt accounts", value: <span className="font-mono text-xs">{MAINTENANCE_EXEMPT.join(", ")}</span> },
                { label: "Exempt count", value: String(MAINTENANCE_EXEMPT.length) },
              ]}
            />
            <p className="text-xs text-muted-foreground">Pre-market, after-hours and weekends render normally regardless of the gate. Broker sessions and working orders are never touched.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Incidents</CardTitle>
            <CardDescription>Last 30 days, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {overview.isLoading ? (
              <ListSkeleton rows={4} />
            ) : incidents.length === 0 ? (
              <EmptyState title="No incidents in 30 days" />
            ) : (
              <ol className="relative grid gap-0 border-l border-border pl-4">
                {incidents.map((i) => (
                  <li key={i.id} className="relative grid gap-1 pb-4 last:pb-0">
                    <span aria-hidden="true" className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full ring-2 ring-card ${i.status === "resolved" ? "bg-muted-foreground/50" : i.status === "open" ? "bg-loss" : "bg-warn"}`} />
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={i.severity} />
                      <IncidentStatusBadge status={i.status} />
                      <span className="font-mono text-[11px] text-muted-foreground">{i.id}</span>
                    </div>
                    <p className="text-sm font-medium">{i.title}</p>
                    <p className="text-xs text-muted-foreground">{i.summary}</p>
                    <p className="text-xs text-muted-foreground tabular">
                      Started {fmtDateTime(i.startedAt)}
                      {i.resolvedAt ? ` · Resolved ${fmtDateTime(i.resolvedAt)}` : ` · Ongoing for ${timeAgo(i.startedAt, DEMO_NOW).replace(" ago", "")}`}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart {pending?.name}?</DialogTitle>
            <DialogDescription>
              {pending?.instances === 1
                ? "This service has a single instance, so it will be unavailable for roughly 20 seconds."
                : `Rolling restart across ${pending?.instances} instances. Traffic drains from each one first, so traders should not notice.`}
              {pending?.id === "svc_gw" ? " IBKR sessions re-authenticate with the stored credentials; traders with an expired second factor will be asked to log in again." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!pending) return;
                const svc = pending;
                setPending(null);
                setRestarting(svc.id);
                setTimeout(() => {
                  markRestarted(svc.id);
                  setRestarting(null);
                  toast.success(`${svc.name} restarted`, { description: `${svc.instances} instance${svc.instances === 1 ? "" : "s"} back in rotation.` });
                }, 1200);
              }}
            >
              Restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
