import Link from "next/link";
import { ArrowLeft, Mail } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/page-header";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getBroker } from "@/lib/brokers";
import { whiteLabelBranding } from "@/lib/branding";
import { fmtDateTime } from "@/lib/format";
import type { AuditEvent, BrokerConnection, Tenant, User, Workspace } from "@/lib/types";
import { ConnectionStatusBadge, PlanBadge, ResultBadge, RoleBadge, WhiteLabelBadge, WorkspaceStatusBadge } from "./badges";
import { ENVIRONMENT_LABEL, fmtDay, lastSignInLabel, METHOD_LABEL, workspaceHostFor } from "./lib";
import { KV, TH } from "./primitives";
import { WorkspaceControls } from "./trader-sections";

/** Who brought this trader: the tenant (linked to the Tenants page) or nobody. */
function TenantSource({ workspace, tenant }: { workspace: Workspace; tenant: Tenant | null }) {
  if (!workspace.tenantId) return <span className="text-muted-foreground">Organic, signed up directly</span>;
  if (!tenant) return <span className="font-mono text-xs">{workspace.tenantId}</span>;
  return (
    <Link href="/admin/tenants" className="underline-offset-4 hover:underline">
      {tenant.name}
    </Link>
  );
}

/** Full record for one trader's workspace. Everything here is read from the database on the server. */
export function TraderDetail({
  workspace,
  tenant,
  members,
  connections,
  events,
}: {
  workspace: Workspace;
  tenant: Tenant | null;
  members: User[];
  connections: BrokerConnection[];
  events: AuditEvent[];
}) {
  const brand = whiteLabelBranding(tenant);
  const host = workspaceHostFor(workspace, tenant);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {workspace.name}
            <WorkspaceStatusBadge status={workspace.status} />
            <PlanBadge plan={workspace.plan} />
          </span>
        }
        description={<span className="font-mono text-xs break-all">{host}</span>}
        actions={
          <>
            <Button variant="ghost" size="sm" render={<Link href="/admin/traders" />}>
              <ArrowLeft data-icon="inline-start" />
              All traders
            </Button>
            {workspace.owner.email ? (
              <Button variant="outline" size="sm" render={<a href={`mailto:${workspace.owner.email}`} />}>
                <Mail data-icon="inline-start" />
                Email owner
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>{workspace.owner.name ? `Owned by ${workspace.owner.name}` : "No owner on file"}</CardDescription>
          </CardHeader>
          <CardContent>
            <KV
              items={[
                { label: "Owner email", value: workspace.owner.email || <span className="text-muted-foreground">None</span> },
                { label: "Tenant", value: <TenantSource workspace={workspace} tenant={tenant} /> },
                {
                  label: "Brand",
                  value: brand ? (
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      {brand.name}
                      <WhiteLabelBadge on />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Nasscord</span>
                  ),
                },
                { label: "Members", value: workspace.seatLimit !== undefined ? `${workspace.seats} of ${workspace.seatLimit}` : `${workspace.seats}, no limit` },
                { label: "Timezone", value: workspace.timezone },
                { label: "Created", value: fmtDay(workspace.createdAt) },
                { label: "Slug", value: <span className="font-mono text-xs">{workspace.slug}</span> },
                { label: "Id", value: <span className="font-mono text-[11px] break-all">{workspace.id}</span> },
              ]}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Plan and status</CardTitle>
            <CardDescription>Each change asks first, is saved to the workspace and is written to the audit log under your login.</CardDescription>
          </CardHeader>
          <CardContent>
            <WorkspaceControls workspace={workspace} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Broker connections</CardTitle>
          <CardDescription>Stored connections and their accounts. Balances are not shown here: they need the trader&apos;s own session at the broker.</CardDescription>
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <EmptyState title="No broker connected" description="The trader has not connected IBKR or E*TRADE yet." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Broker</TableHead>
                    <TableHead className={TH}>Method</TableHead>
                    <TableHead className={TH}>Status</TableHead>
                    <TableHead className={`${TH} text-right`}>Accounts</TableHead>
                    <TableHead className={TH}>Last answered</TableHead>
                    <TableHead className={TH}>Session ends</TableHead>
                    <TableHead className={TH}>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <BrokerMark id={c.brokerId} size="sm" />
                          <span className="grid gap-0.5">
                            <span className="font-medium">{getBroker(c.brokerId).name}</span>
                            <span className="text-xs text-muted-foreground">{ENVIRONMENT_LABEL[c.environment]}</span>
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{METHOD_LABEL[c.method]}</TableCell>
                      <TableCell>
                        <span className="grid gap-1">
                          <ConnectionStatusBadge status={c.status} />
                          {c.statusDetail ? <span className="max-w-64 text-xs whitespace-normal text-muted-foreground">{c.statusDetail}</span> : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular">
                        {c.accounts.length}
                        {c.accounts.length ? <span className="text-muted-foreground"> ({c.accounts.filter((a) => a.included).length} included)</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{c.lastOkAt ? fmtDateTime(c.lastOkAt) : "Never"}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{c.sessionExpiresAt ? fmtDateTime(c.sessionExpiresAt) : ""}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{c.connectedAt ? fmtDay(c.connectedAt) : ""}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? "person signs" : "people sign"} in to this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <EmptyState title="No members" description="Nobody has this workspace as theirs." />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={TH}>Name</TableHead>
                    <TableHead className={TH}>Email</TableHead>
                    <TableHead className={TH}>Role</TableHead>
                    <TableHead className={TH}>Last sign-in</TableHead>
                    <TableHead className={TH}>Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell className="font-medium">{u.name}</TableCell>
                      <TableCell className="font-mono text-xs">{u.email}</TableCell>
                      <TableCell>
                        <RoleBadge role={u.role} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{lastSignInLabel(u)}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDay(u.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>The latest audit events recorded for this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <EmptyState title="No activity recorded" description="Nothing in the audit log names this workspace yet." />
          ) : (
            <ul className="divide-y divide-border">
              {events.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="w-36 shrink-0 text-xs text-muted-foreground tabular">{fmtDateTime(a.at)}</span>
                  <span className="font-mono text-xs">{a.action}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.target}</span>
                  <span className="text-xs text-muted-foreground">{a.actor}</span>
                  <ResultBadge result={a.result} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
