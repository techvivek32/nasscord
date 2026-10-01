"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { BrokerMarks } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useWorkspaces } from "@/hooks/queries";
import { fmtDate, fmtMoney } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import type { PlanId, Tenant, Workspace, WorkspaceStatus } from "@/lib/types";
import { PlanBadge, WhiteLabelBadge, WorkspaceStatusBadge } from "./badges";
import { WORKSPACE_STATUS, workspaceHostFor } from "./lib";
import { TableSkeleton } from "./primitives";
import { applyWorkspaceOverrides, useConsoleTenants, useWorkspaceOverrides } from "./store";
import { TraderFacts, TraderSections } from "./trader-sections";

type PlanFilter = "all" | PlanId;
type StatusFilter = "all" | WorkspaceStatus;

/** A workspace row with the tenant it came through, resolved once for display, sorting and search. */
type Row = Workspace & { tenant: Tenant | null; tenantLabel: string; host: string };

const STATUS_ITEMS = [{ value: "all", label: "All statuses" }, ...(Object.keys(WORKSPACE_STATUS) as WorkspaceStatus[]).map((s) => ({ value: s, label: WORKSPACE_STATUS[s].label }))];

const COLUMNS: ColumnDef<Row>[] = [
  {
    id: "name",
    accessorFn: (w) => `${w.name} ${w.host}`,
    header: "Trader",
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
  {
    id: "tenant",
    accessorFn: (w) => w.tenantLabel,
    header: "Tenant",
    cell: ({ row }) =>
      row.original.tenantId ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{row.original.tenantLabel}</span>
          {row.original.tenant?.whiteLabel ? <WhiteLabelBadge on /> : null}
        </span>
      ) : (
        <span className="text-muted-foreground">Organic</span>
      ),
  },
  { accessorKey: "plan", header: "Plan", cell: ({ row }) => <PlanBadge plan={row.original.plan} /> },
  { id: "brokers", accessorFn: (w) => w.brokers.join(" "), header: "Brokers", enableSorting: false, cell: ({ row }) => <BrokerMarks ids={row.original.brokers} /> },
  {
    id: "seats",
    accessorFn: (w) => w.seats,
    header: "Seats",
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="tabular">
        {row.original.seats}
        <span className="text-muted-foreground"> / {row.original.seatLimit}</span>
      </span>
    ),
  },
  { accessorKey: "mrr", header: "MRR", meta: { align: "right" }, cell: ({ row }) => <span className="font-medium tabular">{fmtMoney(row.original.mrr, { digits: 0 })}</span> },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <WorkspaceStatusBadge status={row.original.status} /> },
  { accessorKey: "createdAt", header: "Created", cell: ({ row }) => <span className="text-muted-foreground">{fmtDate(row.original.createdAt)}</span> },
];

export function TradersTable() {
  const workspaces = useWorkspaces();
  const { byId: tenantById } = useConsoleTenants();
  const overrides = useWorkspaceOverrides();
  const [plan, setPlan] = React.useState<PlanFilter>("all");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const all = React.useMemo<Row[]>(
    () =>
      (workspaces.data ?? []).map((w) => {
        const ws = applyWorkspaceOverrides(w, overrides);
        const tenant = ws.tenantId ? (tenantById.get(ws.tenantId) ?? null) : null;
        return { ...ws, tenant, tenantLabel: tenant?.name ?? ws.tenantId ?? "Organic", host: workspaceHostFor(ws, tenant) };
      }),
    [workspaces.data, overrides, tenantById],
  );
  const rows = React.useMemo(() => all.filter((w) => (plan === "all" || w.plan === plan) && (status === "all" || w.status === status)), [all, plan, status]);
  const selected = React.useMemo(() => all.find((w) => w.id === selectedId) ?? null, [all, selectedId]);

  if (workspaces.isLoading) return <TableSkeleton rows={8} cols={9} />;
  if (workspaces.isError) return <EmptyState title="Traders could not be loaded" description="The workspaces service did not answer. Retry in a moment." action={<Button variant="outline" size="sm" onClick={() => workspaces.refetch()}>Retry</Button>} />;
  if (all.length === 0) return <EmptyState title="No traders yet" description="Workspaces appear here when the first trader finishes onboarding." />;

  return (
    <>
      <DataTable
        columns={COLUMNS}
        data={rows}
        searchPlaceholder="Search traders, owners, tenants, domains…"
        pageSize={10}
        onRowClick={(w) => setSelectedId(w.id)}
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

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelectedId(null)}>
        <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-lg">
          {selected ? (
            <>
              <SheetHeader className="pr-12">
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle>{selected.name}</SheetTitle>
                  <WorkspaceStatusBadge status={selected.status} />
                  <PlanBadge plan={selected.plan} />
                </div>
                <SheetDescription className="font-mono text-xs">{selected.host}</SheetDescription>
                <div className="pt-2">
                  <Button variant="outline" size="sm" render={<Link href={`/admin/traders/${selected.id}`} />}>
                    Open full page
                    <ExternalLink data-icon="inline-end" />
                  </Button>
                </div>
              </SheetHeader>
              <div className="grid gap-6 px-4 pb-6">
                <TraderFacts workspace={selected} tenant={selected.tenant} />
                <TraderSections workspace={selected} idPrefix={`sheet-${selected.id}`} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
