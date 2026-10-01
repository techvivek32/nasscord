"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState, PageHeader } from "@/components/page-header";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAudit, useUsers, useWorkspace } from "@/hooks/queries";
import { getBroker } from "@/lib/brokers";
import { fmtDateTime, maskEmail, timeAgo } from "@/lib/format";
import type { Tenant, User, Workspace } from "@/lib/types";
import { PlanBadge, ResultBadge, RoleBadge, TwoFactorBadge, WorkspaceStatusBadge } from "./badges";
import { DEMO_NOW, SUPER_ADMIN_EMAIL, workspaceHostFor } from "./lib";
import { ListSkeleton, SectionTitle, TableSkeleton } from "./primitives";
import { applyTenantOverrides, applyWorkspaceOverrides, useConsoleStore, useConsoleTenants, useTenantOverrides, useWorkspaceOverrides } from "./store";
import { TenantSource, TraderFacts, TraderSections } from "./trader-sections";

const USER_COLUMNS: ColumnDef<User>[] = [
  { accessorKey: "name", header: "Name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
  { accessorKey: "email", header: "Email", cell: ({ row }) => <span className="font-mono text-xs">{maskEmail(row.original.email)}</span> },
  { accessorKey: "role", header: "Role", cell: ({ row }) => <RoleBadge role={row.original.role} /> },
  { accessorKey: "twoFactor", header: "2FA", cell: ({ row }) => <TwoFactorBadge enabled={row.original.twoFactor} /> },
  { accessorKey: "lastActiveAt", header: "Last active", cell: ({ row }) => <span className="text-muted-foreground">{timeAgo(row.original.lastActiveAt, DEMO_NOW)}</span> },
];

/**
 * Full-page record for one trader's workspace. `initial` and `initialTenant` come from the server so
 * the first paint has the name, the facts and the right host.
 */
export function TraderDetail({ initial, initialTenant }: { initial: Workspace; initialTenant: Tenant | null }) {
  const query = useWorkspace(initial.id);
  const overrides = useWorkspaceOverrides();
  const tenantOverrides = useTenantOverrides();
  const { byId: tenantById } = useConsoleTenants();
  const users = useUsers();
  const audit = useAudit();
  const invited = useConsoleStore((s) => s.invitedUsers);
  const removed = useConsoleStore((s) => s.removedUserIds);
  const reset2fa = useConsoleStore((s) => s.reset2fa);

  const workspace = React.useMemo(() => applyWorkspaceOverrides(query.data ?? initial, overrides), [query.data, initial, overrides]);
  const tenant = React.useMemo(() => {
    if (!workspace.tenantId) return null;
    const fromList = tenantById.get(workspace.tenantId);
    if (fromList) return fromList;
    return initialTenant ? applyTenantOverrides(initialTenant, tenantOverrides) : null;
  }, [workspace.tenantId, tenantById, initialTenant, tenantOverrides]);

  const workspaceUsers = React.useMemo(
    () =>
      [...invited, ...(users.data ?? [])]
        .filter((u) => u.workspaceId === workspace.id && !removed.includes(u.id))
        .map((u) => (reset2fa.includes(u.id) ? { ...u, twoFactor: false } : u)),
    [users.data, invited, removed, reset2fa, workspace.id],
  );

  const activity = React.useMemo(() => (audit.data ?? []).filter((a) => a.target.includes(workspace.name) || a.actor.endsWith(`@${workspace.owner.email.split("@")[1]}`)), [audit.data, workspace.name, workspace.owner.email]);

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
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs">
              {workspace.id} · {workspaceHostFor(workspace, tenant)}
            </span>
            <span className="text-xs">
              <TenantSource workspace={workspace} tenant={tenant} />
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" render={<Link href="/admin/traders" />}>
              <ArrowLeft data-icon="inline-start" />
              All traders
            </Button>
            <Button variant="outline" size="sm" onClick={() => toast(`Email drafted to ${workspace.owner.email}`)}>
              Email owner
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>Owner {workspace.owner.name}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <TraderFacts workspace={workspace} tenant={tenant} />
            <div className="grid gap-2">
              <SectionTitle>Connected brokers</SectionTitle>
              {workspace.brokers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No broker connected yet.</p>
              ) : (
                <ul className="grid gap-2">
                  {workspace.brokers.map((b) => (
                    <li key={b} className="flex items-center gap-2 text-sm">
                      <BrokerMark id={b} size="sm" />
                      <span className="font-medium">{getBroker(b).name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">{getBroker(b).mode === "aggregator" ? "Read-only sync" : "Direct API"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
            <CardDescription>Changes apply immediately and are written to the audit log as {SUPER_ADMIN_EMAIL}. Branding comes from the tenant and is set on the White-label page.</CardDescription>
          </CardHeader>
          <CardContent>
            <TraderSections workspace={workspace} idPrefix={`detail-${workspace.id}`} columns />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            {workspaceUsers.length} of {workspace.seatLimit} seats in use.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {users.isLoading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : workspaceUsers.length === 0 ? (
            <EmptyState title="No users in this workspace" description="The owner has not invited anyone yet." />
          ) : (
            <DataTable columns={USER_COLUMNS} data={workspaceUsers} searchable={workspaceUsers.length > 6} pageSize={10} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Audit events that touched this workspace or came from its users.</CardDescription>
        </CardHeader>
        <CardContent>
          {audit.isLoading ? (
            <ListSkeleton rows={3} />
          ) : activity.length === 0 ? (
            <EmptyState title="No recent activity" description="Nothing in the audit log mentions this workspace in the last 30 days." />
          ) : (
            <ul className="divide-y divide-border">
              {activity.map((a) => (
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
