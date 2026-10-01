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
import { usePartners, useTenants } from "@/hooks/queries";
import { fmtDate, fmtMoney } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import type { PlanId, Tenant, TenantStatus } from "@/lib/types";
import { PlanBadge, TenantStatusBadge } from "./badges";
import { TENANT_STATUS, tenantHost } from "./lib";
import { TableSkeleton } from "./primitives";
import { applyTenantOverrides, useTenantOverrides } from "./store";
import { TenantFacts, TenantSections } from "./tenant-sections";

type PlanFilter = "all" | PlanId;
type StatusFilter = "all" | TenantStatus;

const STATUS_ITEMS = [{ value: "all", label: "All statuses" }, ...(Object.keys(TENANT_STATUS) as TenantStatus[]).map((s) => ({ value: s, label: TENANT_STATUS[s].label }))];

const COLUMNS: ColumnDef<Tenant>[] = [
  {
    accessorKey: "name",
    header: "Tenant",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{tenantHost(row.original.slug, row.original.branding?.domain)}</span>
      </div>
    ),
  },
  {
    id: "owner",
    accessorFn: (t) => `${t.owner.name} ${t.owner.email}`,
    header: "Owner",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span>{row.original.owner.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.owner.email}</span>
      </div>
    ),
  },
  { accessorKey: "plan", header: "Plan", cell: ({ row }) => <PlanBadge plan={row.original.plan} /> },
  { id: "brokers", accessorFn: (t) => t.brokers.join(" "), header: "Brokers", enableSorting: false, cell: ({ row }) => <BrokerMarks ids={row.original.brokers} /> },
  {
    id: "seats",
    accessorFn: (t) => t.seats,
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
  { accessorKey: "status", header: "Status", cell: ({ row }) => <TenantStatusBadge status={row.original.status} /> },
  { accessorKey: "createdAt", header: "Created", cell: ({ row }) => <span className="text-muted-foreground">{fmtDate(row.original.createdAt)}</span> },
];

export function TenantsTable() {
  const tenants = useTenants();
  const partners = usePartners();
  const overrides = useTenantOverrides();
  const [plan, setPlan] = React.useState<PlanFilter>("all");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const rows = React.useMemo(() => {
    const list = (tenants.data ?? []).map((t) => applyTenantOverrides(t, overrides));
    return list.filter((t) => (plan === "all" || t.plan === plan) && (status === "all" || t.status === status));
  }, [tenants.data, overrides, plan, status]);

  const selected = React.useMemo(() => rows.find((t) => t.id === selectedId) ?? (tenants.data ?? []).map((t) => applyTenantOverrides(t, overrides)).find((t) => t.id === selectedId) ?? null, [rows, tenants.data, overrides, selectedId]);
  const partnerName = selected?.partnerId ? partners.data?.partners.find((p) => p.id === selected.partnerId)?.name : undefined;

  if (tenants.isLoading) return <TableSkeleton rows={8} cols={8} />;
  if (tenants.isError) return <EmptyState title="Tenants could not be loaded" description="The tenants service did not answer. Retry in a moment." action={<Button variant="outline" size="sm" onClick={() => tenants.refetch()}>Retry</Button>} />;
  if ((tenants.data ?? []).length === 0) return <EmptyState title="No tenants yet" description="Workspaces appear here when the first customer finishes onboarding." />;

  return (
    <>
      <DataTable
        columns={COLUMNS}
        data={rows}
        searchPlaceholder="Search tenants, owners, domains…"
        pageSize={10}
        onRowClick={(t) => setSelectedId(t.id)}
        emptyMessage="No tenants match these filters."
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
              {rows.length} of {tenants.data?.length ?? 0}
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
                  <TenantStatusBadge status={selected.status} />
                  <PlanBadge plan={selected.plan} />
                </div>
                <SheetDescription className="font-mono text-xs">{tenantHost(selected.slug, selected.branding?.domain)}</SheetDescription>
                <div className="pt-2">
                  <Button variant="outline" size="sm" render={<Link href={`/admin/tenants/${selected.id}`} />}>
                    Open full page
                    <ExternalLink data-icon="inline-end" />
                  </Button>
                </div>
              </SheetHeader>
              <div className="grid gap-6 px-4 pb-6">
                <TenantFacts tenant={selected} partnerName={partnerName} />
                <TenantSections tenant={selected} idPrefix={`sheet-${selected.id}`} />
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
