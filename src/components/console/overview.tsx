import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { EmptyState } from "@/components/page-header";
import { BrokerMark, BrokerMarks } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BrokerServiceStatus } from "@/lib/server/console";
import { BROKERS } from "@/lib/brokers";
import { fmtNum } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import { ROLES } from "@/lib/roles";
import type { PlatformCounts, Workspace } from "@/lib/types";
import { PlanBadge, ToneBadge } from "./badges";
import { CONNECTION_STATUS, CONNECTION_STATUSES, fmtDay, ROLE_LABEL, WORKSPACE_STATUS, WORKSPACE_STATUSES } from "./lib";
import { KV } from "./primitives";
import { ServiceFacts } from "./service-status";

/** Console overview: counts straight from the database and the broker service's own report. */
export function Overview({ counts, service, recent, checkedAt }: { counts: PlatformCounts; service: BrokerServiceStatus; recent: Workspace[]; checkedAt: string }) {
  const members = ROLES.reduce((n, r) => n + counts.membersByRole[r], 0);
  const connected = (counts.connectionsByStatus.connected ?? 0) + (counts.connectionsByStatus.expiring ?? 0);
  const brokersWithConnections = BROKERS.filter((b) => (counts.connectionsByBroker[b.id] ?? 0) > 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Traders" value={fmtNum(counts.workspaces)} hint={<span className="text-[11px] text-muted-foreground">{fmtNum(counts.workspacesByStatus.active)} active</span>} />
        <StatCard label="Tenants" value={fmtNum(counts.tenants)} />
        <StatCard label="Members" value={fmtNum(members)} hint={<span className="text-[11px] text-muted-foreground">can sign in</span>} />
        <StatCard label="Broker connections" value={fmtNum(counts.connections)} hint={<span className="text-[11px] text-muted-foreground">{fmtNum(connected)} live</span>} />
        <StatCard label="Pending applications" value={fmtNum(counts.pendingApplications)} />
        <StatCard label="Broker requests" value={fmtNum(counts.brokerRequests)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Traders by status</CardTitle>
            <CardDescription>Every workspace, organic or through a tenant.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/admin/traders" />}>
                All traders
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <KV items={WORKSPACE_STATUSES.map((s) => ({ label: WORKSPACE_STATUS[s].label, value: fmtNum(counts.workspacesByStatus[s]) }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Traders by plan</CardTitle>
            <CardDescription>The plan stored on each workspace. Billing is not connected.</CardDescription>
          </CardHeader>
          <CardContent>
            <KV items={PLANS.map((p) => ({ label: p.name, value: fmtNum(counts.workspacesByPlan[p.id]) }))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Members by role</CardTitle>
            <CardDescription>Everyone with a members row.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/admin/users" />}>
                All users
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <KV items={ROLES.map((r) => ({ label: ROLE_LABEL[r], value: fmtNum(counts.membersByRole[r]) }))} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Broker connections</CardTitle>
            <CardDescription>Stored connections by broker and status.</CardDescription>
            <CardAction>
              <Button variant="outline" size="sm" render={<Link href="/admin/brokers" />}>
                Brokers
                <ArrowRight data-icon="inline-end" />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-4">
            {counts.connections === 0 ? (
              <EmptyState title="No broker connections yet" description="Counts appear once a trader connects IBKR or E*TRADE." />
            ) : (
              <>
                <ul className="grid gap-2">
                  {brokersWithConnections.map((b) => (
                    <li key={b.id} className="flex items-center gap-2 text-sm">
                      <BrokerMark id={b.id} size="sm" />
                      <span className="font-medium">{b.name}</span>
                      <span className="ml-auto tabular">{fmtNum(counts.connectionsByBroker[b.id] ?? 0)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-1.5 border-t pt-3">
                  {CONNECTION_STATUSES.filter((s) => (counts.connectionsByStatus[s] ?? 0) > 0).map((s) => (
                    <ToneBadge key={s} tone={CONNECTION_STATUS[s].tone}>
                      {CONNECTION_STATUS[s].label} <span className="tabular">{fmtNum(counts.connectionsByStatus[s] ?? 0)}</span>
                    </ToneBadge>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Broker service</CardTitle>
            <CardDescription>The process that holds broker sessions and talks to IBKR and E*TRADE.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/admin/health" />}>
                System health
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ServiceFacts status={service} checkedAt={checkedAt} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Newest traders</CardTitle>
            <CardDescription>The last workspaces created.</CardDescription>
          </CardHeader>
          <CardContent>
            {recent.length === 0 ? (
              <EmptyState title="No traders yet" description="Workspaces appear here when someone finishes signup." />
            ) : (
              <ul className="divide-y divide-border">
                {recent.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <Link href={`/admin/traders/${w.id}`} className="block truncate text-sm font-medium hover:underline">
                        {w.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {w.owner.email || "No owner on file"} · {fmtDay(w.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <BrokerMarks ids={w.brokers} max={3} />
                      <PlanBadge plan={w.plan} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Revenue</CardTitle>
            <CardDescription>MRR, churn and payouts.</CardDescription>
          </CardHeader>
          <CardContent>
            <EmptyState title="Billing is not connected" description="Stripe is not connected yet, so there is no revenue, MRR or churn to show." />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
