"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { BrokerMarks } from "@/components/brokers/broker-mark";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PLANS } from "@/lib/plans";
import type { PlanId, Workspace, WorkspaceStatus } from "@/lib/types";
import { PlanBadge, WhiteLabelBadge, WorkspaceStatusBadge } from "./badges";
import { fmtDay, WORKSPACE_STATUS, WORKSPACE_STATUSES } from "./lib";

/** A workspace with the tenant it came through and the host its terminal lives on, resolved on the server. */
export type TraderRow = Workspace & { tenantName: string | null; tenantWhiteLabel: boolean; host: string };

type PlanFilter = "all" | PlanId;
type StatusFilter = "all" | WorkspaceStatus;

const STATUS_ITEMS = [{ value: "all", label: "All statuses" }, ...WORKSPACE_STATUSES.map((s) => ({ value: s, label: WORKSPACE_STATUS[s].label }))];

const COLUMNS: ColumnDef<TraderRow>[] = [
  {
    id: "name",
    accessorFn: (w) => `${w.name} ${w.slug} ${w.host}`,
    header: "Trader",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        {/* A real link, so keyboard users can open the trader; the row click stays a mouse shortcut. */}
        <Link href={`/admin/traders/${row.original.id}`} className="font-medium underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
          {row.original.name}
        </Link>
        <span className="font-mono text-xs text-muted-foreground">{row.original.host}</span>
      </div>
    ),
  },
  {
    id: "owner",
    accessorFn: (w) => `${w.owner.name} ${w.owner.email}`,
    header: "Owner",
    cell: ({ row }) =>
      row.original.owner.email ? (
        <div className="grid gap-0.5">
          <span>{row.original.owner.name}</span>
          <span className="text-xs text-muted-foreground">{row.original.owner.email}</span>
        </div>
      ) : (
        <span className="text-muted-foreground">No owner on file</span>
      ),
  },
  {
    id: "tenant",
    accessorFn: (w) => w.tenantName ?? (w.tenantId ? w.tenantId : "Organic"),
    header: "Tenant",
    cell: ({ row }) =>
      row.original.tenantId ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{row.original.tenantName ?? <span className="font-mono text-xs">{row.original.tenantId}</span>}</span>
          {row.original.tenantWhiteLabel ? <WhiteLabelBadge on /> : null}
        </span>
      ) : (
        <span className="text-muted-foreground">Organic</span>
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
  {
    id: "seats",
    accessorFn: (w) => w.seats,
    header: "Members",
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="tabular">
        {row.original.seats}
        {row.original.seatLimit !== undefined ? <span className="text-muted-foreground"> / {row.original.seatLimit}</span> : null}
      </span>
    ),
  },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <WorkspaceStatusBadge status={row.original.status} /> },
  { accessorKey: "createdAt", header: "Created", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.createdAt)}</span> },
];

export function TradersTable({ rows: all }: { rows: TraderRow[] }) {
  const router = useRouter();
  const [plan, setPlan] = React.useState<PlanFilter>("all");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const rows = React.useMemo(() => all.filter((w) => (plan === "all" || w.plan === plan) && (status === "all" || w.status === status)), [all, plan, status]);

  if (all.length === 0) return <EmptyState title="No traders yet" description="Workspaces appear here when someone finishes signup." />;

  return (
    <DataTable
      columns={COLUMNS}
      data={rows}
      searchPlaceholder="Search traders, owners, tenants, hosts…"
      pageSize={15}
      onRowClick={(w) => router.push(`/admin/traders/${w.id}`)}
      emptyMessage="No traders match these filters."
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            variant="outline"
            spacing={0}
            value={[plan]}
            onValueChange={(next) => {
              const v = next[0] as PlanFilter | undefined;
              if (v) setPlan(v);
            }}
            aria-label="Filter by plan"
            className="overflow-x-auto"
          >
            <ToggleGroupItem value="all" size="sm" className="px-3 data-pressed:bg-muted aria-pressed:bg-muted">
              All
            </ToggleGroupItem>
            {PLANS.map((p) => (
              <ToggleGroupItem key={p.id} value={p.id} size="sm" className="px-3 data-pressed:bg-muted aria-pressed:bg-muted">
                {p.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select items={STATUS_ITEMS} value={status} onValueChange={(v) => v && setStatus(v as StatusFilter)}>
            <SelectTrigger aria-label="Filter by status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_ITEMS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground tabular">
            {rows.length} of {all.length}
          </span>
        </div>
      }
    />
  );
}
