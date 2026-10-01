"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePartners, usePlatformOverview } from "@/hooks/queries";
import { fmtDate, fmtMoney, fmtNum, timeAgo } from "@/lib/format";
import { PARTNER_MODELS, REFERRAL_SHARE_PCT } from "@/lib/plans";
import type { Partner, PartnerModel, Payout } from "@/lib/types";
import { ModelBadge, PartnerStatusBadge, ToneBadge } from "./badges";
import { DEMO_NOW, shortId } from "./lib";
import { KV, ListSkeleton, StatGridSkeleton, TableSkeleton } from "./primitives";
import { useConsoleStore } from "./store";

const MODEL_IDS = PARTNER_MODELS.map((m) => m.id) as [PartnerModel, ...PartnerModel[]];
const MODEL_ITEMS = PARTNER_MODELS.map((m) => ({ value: m.id, label: m.name }));
const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

const PARTNER_COLUMNS: ColumnDef<Partner>[] = [
  {
    accessorKey: "name",
    header: "Partner",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.name}</span>
        <span className="text-xs text-muted-foreground">{row.original.contact}</span>
      </div>
    ),
  },
  { accessorKey: "model", header: "Model", cell: ({ row }) => <ModelBadge model={row.original.model} /> },
  { accessorKey: "tenants", header: "Tenants", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{fmtNum(row.original.tenants)}</span> },
  { accessorKey: "revShare", header: "Rev share", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{row.original.revShare > 0 ? `${row.original.revShare}%` : <span className="text-muted-foreground">Platform fee</span>}</span> },
  { accessorKey: "mtdRevenue", header: "MTD revenue", meta: { align: "right" }, cell: ({ row }) => <span className="font-medium tabular">{fmtMoney(row.original.mtdRevenue, { digits: 0 })}</span> },
  { accessorKey: "mtdPayout", header: "MTD payout", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{row.original.mtdPayout > 0 ? fmtMoney(row.original.mtdPayout) : <span className="text-muted-foreground">None</span>}</span> },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <PartnerStatusBadge status={row.original.status} /> },
  { accessorKey: "referralCode", header: "Code", cell: ({ row }) => <span className="font-mono text-xs">{row.original.referralCode}</span> },
];

const PAYOUT_STATUS = { scheduled: { label: "Scheduled", tone: "brand" }, paid: { label: "Paid", tone: "good" }, on_hold: { label: "On hold", tone: "warn" } } as const;

const addSchema = z.object({
  name: z.string().trim().min(2, "Enter the partner's name.").max(60),
  model: z.enum(MODEL_IDS, { error: "Choose a model." }),
  revShare: z.coerce.number({ error: "Enter a percentage." }).min(0, "0 or more.").max(50, "Referral share tops out at 50%."),
  contact: z.email("Enter a valid contact email."),
});
type AddInput = z.input<typeof addSchema>;
type AddValues = z.output<typeof addSchema>;

/** A fresh partner record, as created by the Add dialog or by approving an application. */
function newPartner(p: Pick<Partner, "name" | "model" | "contact" | "revShare">): Partner {
  return {
    id: shortId("p"),
    ...p,
    tenants: 0,
    mtdRevenue: 0,
    mtdPayout: 0,
    status: "active",
    referralCode: p.name.replace(/[^a-z0-9]/gi, "").slice(0, 10).toUpperCase() || "PARTNER",
    createdAt: DEMO_NOW.toISOString(),
  };
}

export function PartnersPage() {
  const overview = usePlatformOverview();
  const partners = usePartners();
  const added = useConsoleStore((s) => s.addedPartners);
  const decisions = useConsoleStore((s) => s.partnerDecisions);
  const decide = useConsoleStore((s) => s.decidePartner);
  const addPartner = useConsoleStore((s) => s.addPartner);
  const [addOpen, setAddOpen] = React.useState(false);

  const k = overview.data?.kpis;
  const rows = React.useMemo(() => [...added, ...(partners.data?.partners ?? [])], [added, partners.data]);
  const applications = (partners.data?.applications ?? []).filter((a) => !decisions[a.id]);
  const decided = (partners.data?.applications ?? []).filter((a) => decisions[a.id]);
  const partnerName = React.useMemo(() => new Map(rows.map((p) => [p.id, p.name] as const)), [rows]);
  const pendingCount = k ? Math.max(0, k.pendingApplications - decided.length) : undefined;

  return (
    <div className="flex flex-col gap-5">
      {k ? (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard label="Partners" value={fmtNum(k.partners + added.length)} hint={<span className="text-[11px] text-muted-foreground">all models</span>} />
          <StatCard label="Partner-sourced MRR" value={fmtMoney(k.partnerSourcedMrr, { digits: 0 })} delta={`${Math.round((k.partnerSourcedMrr / k.mrr) * 100)}% of MRR`} />
          <StatCard label="Payouts MTD" value={fmtMoney(k.payoutsMtd, { digits: 0 })} hint={<span className="text-[11px] text-muted-foreground">paid on the 5th</span>} />
          <StatCard label="Pending applications" value={pendingCount ?? k.pendingApplications} />
        </div>
      ) : (
        <StatGridSkeleton count={4} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Partners</CardTitle>
          <CardDescription>White-label partners pay a platform fee; referral partners earn a share of subscription revenue; embedded partners are billed on usage.</CardDescription>
        </CardHeader>
        <CardContent>
          {partners.isLoading ? (
            <TableSkeleton rows={6} cols={8} />
          ) : rows.length === 0 ? (
            <EmptyState title="No partners yet" description="Approve an application or add a partner directly." action={<Button size="sm" onClick={() => setAddOpen(true)}>Add partner</Button>} />
          ) : (
            <DataTable
              columns={PARTNER_COLUMNS}
              data={rows}
              searchPlaceholder="Search partner, contact, code…"
              pageSize={10}
              toolbar={
                <Button size="sm" className="ml-auto" onClick={() => setAddOpen(true)}>
                  <Plus data-icon="inline-start" />
                  Add partner
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
            <CardDescription>Submitted through the public partners page. Approving creates the partner record with default terms for that model.</CardDescription>
          </CardHeader>
          <CardContent>
            {partners.isLoading ? (
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
                        <ModelBadge model={a.model} />
                        <span className="text-xs text-muted-foreground">{timeAgo(a.submittedAt, DEMO_NOW)}</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          decide(a.id, "approved");
                          addPartner(newPartner({ name: a.name, model: a.model, contact: a.contact, revShare: a.model === "referral" ? REFERRAL_SHARE_PCT : 0 }));
                          toast.success(`${a.name} approved`, { description: "Partner record created with default terms. Welcome email and portal invite sent." });
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
                  <li key={a.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span className="text-muted-foreground">{a.name}</span>
                    <ToneBadge tone={decisions[a.id] === "approved" ? "good" : "neutral"}>{decisions[a.id] === "approved" ? "Approved" : "Declined"}</ToneBadge>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payout schedule</CardTitle>
            <CardDescription>Referral commissions for the previous month.</CardDescription>
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
            {partners.isLoading ? (
              <ListSkeleton rows={3} />
            ) : (partners.data?.payouts ?? []).length === 0 ? (
              <EmptyState title="No payouts yet" />
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className={TH}>Partner</TableHead>
                      <TableHead className={TH}>Period</TableHead>
                      <TableHead className={`${TH} text-right`}>Amount</TableHead>
                      <TableHead className={TH}>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(partners.data?.payouts ?? []).map((p: Payout) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{partnerName.get(p.partnerId) ?? p.partnerId}</TableCell>
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

      <AddPartnerDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddPartnerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const addPartner = useConsoleStore((s) => s.addPartner);
  const form = useForm<AddInput, unknown, AddValues>({ resolver: zodResolver(addSchema), defaultValues: { name: "", model: "referral", revShare: 25, contact: "" } });
  const { errors, isSubmitting } = form.formState;
  const model = useWatch({ control: form.control, name: "model" });

  async function onSubmit(v: AddValues) {
    await new Promise((r) => setTimeout(r, 300));
    addPartner(newPartner({ name: v.name, model: v.model, contact: v.contact, revShare: v.revShare }));
    toast.success(`${v.name} added`, { description: "Portal invite sent to " + v.contact });
    form.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a partner</DialogTitle>
          <DialogDescription>Creates the partner record and sends a portal invite. Contract terms are attached afterwards.</DialogDescription>
        </DialogHeader>
        <form id="add-partner-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="partner-name">Name</Label>
            <Input id="partner-name" placeholder="Company or brand" aria-invalid={!!errors.name} {...form.register("name")} />
            {errors.name ? <p className="text-xs text-destructive" role="alert">{errors.name.message}</p> : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="partner-model">Model</Label>
              <Controller
                control={form.control}
                name="model"
                render={({ field }) => (
                  <Select
                    items={MODEL_ITEMS}
                    value={field.value ?? null}
                    onValueChange={(v) => {
                      field.onChange(v ?? undefined);
                      // Referral partners earn a share; the other models pay a platform or usage fee.
                      form.setValue("revShare", v === "referral" ? 25 : 0, { shouldDirty: true });
                    }}
                  >
                    <SelectTrigger id="partner-model" className="w-full" onBlur={field.onBlur}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_ITEMS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="partner-share">Rev share %</Label>
              <Input id="partner-share" type="number" inputMode="decimal" min={0} max={50} step={1} disabled={model !== "referral"} className="font-mono tabular" aria-invalid={!!errors.revShare} {...form.register("revShare")} />
              {errors.revShare ? <p className="text-xs text-destructive" role="alert">{errors.revShare.message}</p> : null}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="partner-contact">Contact email</Label>
            <Input id="partner-contact" type="email" placeholder="partners@company.com" aria-invalid={!!errors.contact} {...form.register("contact")} />
            {errors.contact ? <p className="text-xs text-destructive" role="alert">{errors.contact.message}</p> : null}
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-partner-form" disabled={isSubmitting}>
            {isSubmitting ? "Adding" : "Add partner"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
