"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePlatformOverview } from "@/hooks/queries";
import { fmtDate, fmtMoney, fmtNum, timeAgo } from "@/lib/format";
import { COMMISSION_PCT } from "@/lib/plans";
import type { Payout, Tenant } from "@/lib/types";
import { TenantStatusBadge, ToneBadge, WhiteLabelBadge } from "./badges";
import { DEMO_NOW, shortId } from "./lib";
import { KV, ListSkeleton, StatGridSkeleton, TableSkeleton } from "./primitives";
import { useConsoleStore, useConsoleTenants } from "./store";

const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

const TENANT_COLUMNS: ColumnDef<Tenant>[] = [
  {
    id: "name",
    accessorFn: (t) => `${t.name} ${t.contact}`,
    header: "Tenant",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.contact}</span>
      </div>
    ),
  },
  { accessorKey: "workspaces", header: "Traders", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{fmtNum(row.original.workspaces)}</span> },
  { accessorKey: "commissionPct", header: "Commission", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{row.original.commissionPct}%</span> },
  {
    id: "whiteLabel",
    accessorFn: (t) => (t.whiteLabel ? "white-label" : ""),
    header: "White-label",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <WhiteLabelBadge on={row.original.whiteLabel} compact />
        <Link href="/admin/white-label" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Manage
        </Link>
      </span>
    ),
  },
  { accessorKey: "mtdRevenue", header: "MTD revenue", meta: { align: "right" }, cell: ({ row }) => <span className="font-medium tabular">{fmtMoney(row.original.mtdRevenue, { digits: 0 })}</span> },
  { accessorKey: "mtdPayout", header: "MTD payout", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{row.original.mtdPayout > 0 ? fmtMoney(row.original.mtdPayout) : <span className="text-muted-foreground">None</span>}</span> },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <TenantStatusBadge status={row.original.status} /> },
  { accessorKey: "referralCode", header: "Code", cell: ({ row }) => <span className="font-mono text-xs">{row.original.referralCode}</span> },
];

const PAYOUT_STATUS = { scheduled: { label: "Scheduled", tone: "brand" }, paid: { label: "Paid", tone: "good" }, on_hold: { label: "On hold", tone: "warn" } } as const;

const CODE = /^[A-Z0-9]{3,12}$/;

const addSchema = z.object({
  name: z.string().trim().min(2, "Enter the tenant's name.").max(60),
  contact: z.email("Enter a valid contact email."),
  referralCode: z.string().trim().toUpperCase().regex(CODE, "3 to 12 letters or digits, like ACME."),
});
type AddInput = z.input<typeof addSchema>;
type AddValues = z.output<typeof addSchema>;

/** Referral code suggested from a name: letters and digits, upper case. */
function codeFrom(name: string) {
  return name.replace(/[^a-z0-9]/gi, "").slice(0, 10).toUpperCase();
}

/** `base`, or `base` with a number on the end when another tenant already uses it. */
function uniqueCode(base: string, taken: Set<string>) {
  const root = base.length >= 3 ? base : `${base}TNT`.slice(0, 10);
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) if (!taken.has(`${root}${i}`)) return `${root}${i}`;
}

/** A fresh tenant, as created by the Add dialog or by approving an application. White-label starts off. */
function newTenant(p: Pick<Tenant, "name" | "contact" | "referralCode">): Tenant {
  return {
    id: shortId("t"),
    ...p,
    workspaces: 0,
    commissionPct: COMMISSION_PCT,
    mtdRevenue: 0,
    mtdPayout: 0,
    status: "active",
    createdAt: DEMO_NOW.toISOString(),
    whiteLabel: false,
  };
}

export function TenantsPage() {
  const router = useRouter();
  const overview = usePlatformOverview();
  const { query, tenants: rows } = useConsoleTenants();
  const added = useConsoleStore((s) => s.addedTenants);
  const decisions = useConsoleStore((s) => s.tenantDecisions);
  const decide = useConsoleStore((s) => s.decideTenant);
  const addTenant = useConsoleStore((s) => s.addTenant);
  const [addOpen, setAddOpen] = React.useState(false);

  const k = overview.data?.kpis;
  const allApplications = query.data?.applications ?? [];
  const applications = allApplications.filter((a) => !decisions[a.id]);
  const decided = allApplications.filter((a) => decisions[a.id]);
  const tenantName = React.useMemo(() => new Map(rows.map((t) => [t.id, t.name] as const)), [rows]);
  const takenCodes = React.useMemo(() => new Set(rows.map((t) => t.referralCode.toUpperCase())), [rows]);
  const pendingCount = k ? Math.max(0, k.pendingApplications - decided.length) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {k ? (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard label="Tenants" value={fmtNum(k.tenants + added.length)} hint={<span className="text-[11px] text-muted-foreground">{COMMISSION_PCT}% commission</span>} />
          <StatCard label="Tenant-sourced MRR" value={fmtMoney(k.tenantSourcedMrr, { digits: 0 })} delta={`${Math.round((k.tenantSourcedMrr / k.mrr) * 100)}% of MRR`} />
          <StatCard label="Payouts MTD" value={fmtMoney(k.payoutsMtd, { digits: 0 })} hint={<span className="text-[11px] text-muted-foreground">paid on the 5th</span>} />
          <StatCard label="Pending applications" value={pendingCount ?? k.pendingApplications} />
        </div>
      ) : (
        <StatGridSkeleton count={4} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Tenants</CardTitle>
          <CardDescription>
            Every tenant earns {COMMISSION_PCT}% of the subscription revenue of the traders they bring. White-label is an add-on that only the super admin grants, on the White-label page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <TableSkeleton rows={6} cols={8} />
          ) : rows.length === 0 ? (
            <EmptyState title="No tenants yet" description="Approve an application or add a tenant directly." action={<Button size="sm" onClick={() => setAddOpen(true)}>Add tenant</Button>} />
          ) : (
            <DataTable
              columns={TENANT_COLUMNS}
              data={rows}
              searchPlaceholder="Search tenant, contact, code…"
              pageSize={10}
              toolbar={
                <Button size="sm" className="ml-auto" onClick={() => setAddOpen(true)}>
                  <Plus data-icon="inline-start" />
                  Add tenant
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Applications</CardTitle>
            <CardDescription>
              Submitted through the public tenants page. Approving creates the tenant at {COMMISSION_PCT}% commission with white-label off. A white-label request is granted separately on the White-label page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <ListSkeleton rows={3} />
            ) : applications.length === 0 ? (
              <EmptyState title="Inbox clear" description="No applications waiting for a decision." />
            ) : (
              <ul className="divide-y divide-border">
                {applications.map((a) => (
                  <li key={a.id} className="grid gap-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="grid gap-0.5">
                        <span className="text-sm font-medium">{a.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {a.contact} · {a.audience}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {a.wantsWhiteLabel ? <ToneBadge tone="brand">Also asked for white-label</ToneBadge> : null}
                        <span className="text-xs text-muted-foreground">{timeAgo(a.submittedAt, DEMO_NOW)}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          decide(a.id, "approved");
                          addTenant(newTenant({ name: a.name, contact: a.contact, referralCode: uniqueCode(codeFrom(a.name), takenCodes) }));
                          if (a.wantsWhiteLabel) {
                            toast.success(`${a.name} approved`, {
                              description: `Tenant created at ${COMMISSION_PCT}% commission. They also asked for white-label: grant it on the White-label page.`,
                              action: { label: "Open White-label", onClick: () => router.push("/admin/white-label") },
                            });
                          } else {
                            toast.success(`${a.name} approved`, { description: `Tenant created at ${COMMISSION_PCT}% commission. Welcome email and portal invite sent.` });
                          }
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          decide(a.id, "declined");
                          toast(`${a.name} declined`, { description: "A short note went to the applicant." });
                        }}
                      >
                        Decline
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {decided.length > 0 ? (
              <ul className="mt-2 divide-y divide-border border-t">
                {decided.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <span className="text-muted-foreground">{a.name}</span>
                    <span className="flex items-center gap-2">
                      {decisions[a.id] === "approved" && a.wantsWhiteLabel ? (
                        <Link href="/admin/white-label" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                          Grant white-label
                        </Link>
                      ) : null}
                      <ToneBadge tone={decisions[a.id] === "approved" ? "good" : "neutral"}>{decisions[a.id] === "approved" ? "Approved" : "Declined"}</ToneBadge>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payout schedule</CardTitle>
            <CardDescription>Commission for the previous month: {COMMISSION_PCT}% of the subscription revenue of each tenant&apos;s traders.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <KV
              items={[
                { label: "Cadence", value: "Monthly, on the 5th" },
                { label: "Minimum", value: fmtMoney(100, { digits: 0 }) },
                { label: "Method", value: "ACH (US bank account)" },
                { label: "Next run", value: fmtDate("2026-10-05T00:00:00Z") },
              ]}
            />
            {query.isLoading ? (
              <ListSkeleton rows={3} />
            ) : (query.data?.payouts ?? []).length === 0 ? (
              <EmptyState title="No payouts yet" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className={TH}>Tenant</TableHead>
                      <TableHead className={TH}>Period</TableHead>
                      <TableHead className={`${TH} text-right`}>Amount</TableHead>
                      <TableHead className={TH}>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(query.data?.payouts ?? []).map((p: Payout) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{tenantName.get(p.tenantId) ?? p.tenantId}</TableCell>
                        <TableCell className="text-muted-foreground">{p.period}</TableCell>
                        <TableCell className="text-right tabular">{fmtMoney(p.amount)}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <ToneBadge tone={PAYOUT_STATUS[p.status].tone}>{PAYOUT_STATUS[p.status].label}</ToneBadge>
                            {p.paidAt ? <span className="text-xs text-muted-foreground">{fmtDate(p.paidAt)}</span> : null}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AddTenantDialog open={addOpen} onOpenChange={setAddOpen} takenCodes={takenCodes} />
    </div>
  );
}

function AddTenantDialog({ open, onOpenChange, takenCodes }: { open: boolean; onOpenChange: (o: boolean) => void; takenCodes: Set<string> }) {
  const addTenant = useConsoleStore((s) => s.addTenant);
  const form = useForm<AddInput, unknown, AddValues>({ resolver: zodResolver(addSchema), defaultValues: { name: "", contact: "", referralCode: "" } });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(v: AddValues) {
    if (takenCodes.has(v.referralCode)) {
      form.setError("referralCode", { message: `${v.referralCode} is already in use. Pick another code.` });
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
    addTenant(newTenant({ name: v.name, contact: v.contact, referralCode: v.referralCode }));
    toast.success(`${v.name} added`, { description: `Portal invite sent to ${v.contact}. Commission ${COMMISSION_PCT}%, white-label off.` });
    form.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a tenant</DialogTitle>
          <DialogDescription>Creates the tenant and sends a portal invite. The agreement is attached afterwards.</DialogDescription>
        </DialogHeader>
        <form id="add-tenant-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="tenant-name">Name</Label>
            <Input
              id="tenant-name"
              placeholder="Company or brand"
              aria-invalid={!!errors.name}
              {...form.register("name", {
                onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
                  // Suggest a code from the name until one is typed.
                  if (!form.getValues("referralCode")) {
                    const code = codeFrom(e.target.value);
                    if (code) form.setValue("referralCode", uniqueCode(code, takenCodes));
                  }
                },
              })}
            />
            {errors.name ? <p className="text-xs text-destructive" role="alert">{errors.name.message}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tenant-contact">Contact email</Label>
            <Input id="tenant-contact" type="email" placeholder="team@company.com" aria-invalid={!!errors.contact} {...form.register("contact")} />
            {errors.contact ? <p className="text-xs text-destructive" role="alert">{errors.contact.message}</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="tenant-code">Referral code</Label>
              <Input id="tenant-code" placeholder="ACME" maxLength={12} autoComplete="off" spellCheck={false} className="font-mono uppercase" aria-invalid={!!errors.referralCode} {...form.register("referralCode")} />
              {errors.referralCode ? <p className="text-xs text-destructive" role="alert">{errors.referralCode.message}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="tenant-commission">Commission</Label>
              <Input id="tenant-commission" value={`${COMMISSION_PCT}%`} readOnly aria-describedby="tenant-commission-help" className="font-mono tabular text-muted-foreground" />
            </div>
          </div>
          <p id="tenant-commission-help" className="text-xs text-muted-foreground">
            Every tenant earns {COMMISSION_PCT}%. White-label starts off; turn it on from the White-label page.
          </p>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-tenant-form" disabled={isSubmitting}>
            {isSubmitting ? "Adding" : "Add tenant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
