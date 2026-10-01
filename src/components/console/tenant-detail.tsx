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
import { useAudit, usePartners, useTenant, useUsers } from "@/hooks/queries";
import { getBroker } from "@/lib/brokers";
import { fmtDateTime, maskEmail, timeAgo } from "@/lib/format";
import type { Tenant, User } from "@/lib/types";
import { PlanBadge, ResultBadge, RoleBadge, TenantStatusBadge, TwoFactorBadge } from "./badges";
import { DEMO_NOW, tenantHost } from "./lib";
import { ListSkeleton, SectionTitle, TableSkeleton } from "./primitives";
import { applyTenantOverrides, useConsoleStore, useTenantOverrides } from "./store";
import { TenantFacts, TenantSections } from "./tenant-sections";

const USER_COLUMNS: ColumnDef<User>[] = [
  { accessorKey: "name", header: "Name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
  { accessorKey: "email", header: "Email", cell: ({ row }) => <span className="font-mono text-xs">{maskEmail(row.original.email)}</span> },
  { accessorKey: "role", header: "Role", cell: ({ row }) => <RoleBadge role={row.original.role} /> },
  { accessorKey: "twoFactor", header: "2FA", cell: ({ row }) => <TwoFactorBadge enabled={row.original.twoFactor} /> },
  { accessorKey: "lastActiveAt", header: "Last active", cell: ({ row }) => <span className="text-muted-foreground">{timeAgo(row.original.lastActiveAt, DEMO_NOW)}</span> },
];

/** Full-page tenant record. `initial` comes from the server so the first paint has the name and facts. */
export function TenantDetail({ initial }: { initial: Tenant }) {
  const query = useTenant(initial.id);
  const overrides = useTenantOverrides();
  const partners = usePartners();
  const users = useUsers();
  const audit = useAudit();
  const invited = useConsoleStore((s) => s.invitedUsers);
  const removed = useConsoleStore((s) => s.removedUserIds);
  const roles = useConsoleStore((s) => s.userRoles);

  const tenant = React.useMemo(() => applyTenantOverrides(query.data ?? initial, overrides), [query.data, initial, overrides]);
  const partnerName = tenant.partnerId ? partners.data?.partners.find((p) => p.id === tenant.partnerId)?.name : undefined;

  const tenantUsers = React.useMemo(
    () =>
      [...invited, ...(users.data ?? [])]
        .filter((u) => u.tenantId === tenant.id && !removed.includes(u.id))
        .map((u) => ({ ...u, role: roles[u.id] ?? u.role })),
    [users.data, invited, removed, roles, tenant.id],
  );

  const activity = React.useMemo(() => (audit.data ?? []).filter((a) => a.target.includes(tenant.name) || a.actor.endsWith(`@${tenant.owner.email.split("@")[1]}`)), [audit.data, tenant.name, tenant.owner.email]);

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {tenant.name}
            <TenantStatusBadge status={tenant.status} />
            <PlanBadge plan={tenant.plan} />
          </span>
        }
        description={
          <span className="font-mono text-xs">
            {tenant.id} · {tenantHost(tenant.slug, tenant.branding?.domain)}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" render={<Link href="/admin/tenants" />}>
              <ArrowLeft data-icon="inline-start" />
              All tenants
            </Button>
            <Button variant="outline" size="sm" onClick={() => toast(`Email drafted to ${tenant.owner.email}`)}>
              Email owner
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>Owner {tenant.owner.name}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <TenantFacts tenant={tenant} partnerName={partnerName} />
            <div className="grid gap-2">
              <SectionTitle>Connected brokers</SectionTitle>
              {tenant.brokers.length === 0 ? (
                <p className="text-sm text-muted-foreground">No broker connected yet.</p>
              ) : (
                <ul className="grid gap-2">
                  {tenant.brokers.map((b) => (
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
            <CardDescription>Changes apply immediately and are written to the audit log as ops@nasscord.com.</CardDescription>
          </CardHeader>
          <CardContent>
            <TenantSections tenant={tenant} idPrefix={`detail-${tenant.id}`} columns />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>
            {tenantUsers.length} of {tenant.seatLimit} seats in use.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {users.isLoading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : tenantUsers.length === 0 ? (
            <EmptyState title="No users in this workspace" description="The owner has not invited anyone yet." />
          ) : (
            <DataTable columns={USER_COLUMNS} data={tenantUsers} searchable={tenantUsers.length > 6} pageSize={10} />
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
            <EmptyState title="No recent activity" description="Nothing in the audit log mentions this tenant in the last 30 days." />
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
