"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { BrokerMarks } from "@/components/brokers/broker-mark";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABEL } from "@/lib/roles";
import type { User, Workspace } from "@/lib/types";
import { fmtDay, PlanBadge, WorkspaceStatusBadge } from "./primitives";

/** A tenant workspace with the host its traders sign in on, resolved on the server. */
export type TenantTraderRow = Workspace & { host: string };
/** A member with the name of their workspace, resolved on the server. */
export type TenantMemberRow = User & { workspaceName: string | null };

const WORKSPACE_COLUMNS: ColumnDef<TenantTraderRow>[] = [
  {
    id: "name",
    accessorFn: (w) => `${w.name} ${w.host}`,
    header: "Workspace",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.host}</span>
      </div>
    ),
  },
  {
    id: "owner",
    accessorFn: (w) => `${w.owner.name} ${w.owner.email}`,
    header: "Owner",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span>{row.original.owner.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.owner.email}</span>
      </div>
    ),
  },
  { accessorKey: "plan", header: "Plan", cell: ({ row }) => <PlanBadge plan={row.original.plan} /> },
  {
    id: "brokers",
    accessorFn: (w) => w.brokers.join(" "),
    header: "Brokers",
    enableSorting: false,
    cell: ({ row }) => (row.original.brokers.length ? <BrokerMarks ids={row.original.brokers} /> : <span className="text-xs text-muted-foreground">None</span>),
  },
  { accessorKey: "seats", header: "Members", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{row.original.seats}</span> },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <WorkspaceStatusBadge status={row.original.status} /> },
  { accessorKey: "createdAt", header: "Joined", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.createdAt)}</span> },
];

const MEMBER_COLUMNS: ColumnDef<TenantMemberRow>[] = [
  {
    id: "who",
    accessorFn: (u) => `${u.name} ${u.email}`,
    header: "Name",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.email}</span>
      </div>
    ),
  },
  { accessorKey: "role", header: "Role", cell: ({ row }) => <Badge variant="outline">{ROLE_LABEL[row.original.role]}</Badge> },
  {
    id: "workspace",
    accessorFn: (u) => u.workspaceName ?? "",
    header: "Workspace",
    cell: ({ row }) => <span className={row.original.workspaceName ? undefined : "text-muted-foreground"}>{row.original.workspaceName ?? (row.original.role === "tenant" ? "Tenant portal" : "None")}</span>,
  },
  { accessorKey: "createdAt", header: "Joined", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.createdAt)}</span> },
];

export function TenantWorkspacesTable({ rows }: { rows: TenantTraderRow[] }) {
  if (rows.length === 0) return <EmptyState title="No traders yet" description="Workspaces appear here once a trader finishes signup with your code." />;
  return <DataTable columns={WORKSPACE_COLUMNS} data={rows} searchPlaceholder="Search workspace, owner, host…" pageSize={10} />;
}

export function TenantMembersTable({ rows }: { rows: TenantMemberRow[] }) {
  if (rows.length === 0) return <EmptyState title="No members yet" description="Everyone who signs in through your tenant is listed here." />;
  return <DataTable columns={MEMBER_COLUMNS} data={rows} searchPlaceholder="Search name or email…" pageSize={10} />;
}
