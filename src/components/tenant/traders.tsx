"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table";
import { BrokerMarks } from "@/components/brokers/broker-mark";
import { fmtMoney, fmtNum, slugify } from "@/lib/format";
import type { TenantBranding, Workspace } from "@/lib/types";
import { hostFor, PROGRAM, useCurrentTenant } from "./current";
import { ErrorState, Field, KV, PlanBadge, TableSkeleton, WorkspaceStatusBadge } from "./primitives";
import { useTenantStore } from "./store";
import { WhiteLabelGate } from "./white-label-gate";

function columnsFor(branding: TenantBranding | null, appDomain: string): ColumnDef<Workspace>[] {
  return [
    {
      accessorKey: "name",
      header: "Workspace",
      cell: ({ row }) => (
        <div className="grid gap-0.5">
          <span className="font-medium">{row.original.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.original.slug}</span>
        </div>
      ),
    },
    {
      id: "host",
      header: "Sign-in host",
      accessorFn: (w) => hostFor(w, branding, appDomain),
      cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span>,
    },
    { accessorKey: "plan", header: "Plan", cell: ({ row }) => <PlanBadge plan={row.original.plan} /> },
    {
      accessorKey: "seats",
      header: "Seats",
      meta: { align: "right" },
      cell: ({ row }) => (
        <span>
          {fmtNum(row.original.seats)} <span className="text-xs text-muted-foreground">/ {fmtNum(row.original.seatLimit)}</span>
        </span>
      ),
    },
    { accessorKey: "mrr", header: "MRR", meta: { align: "right" }, cell: ({ row }) => <span className="font-medium tabular">{fmtMoney(row.original.mrr, { digits: 0 })}</span> },
    { id: "brokers", header: "Brokers", enableSorting: false, cell: ({ row }) => <BrokerMarks ids={row.original.brokers} max={4} /> },
    { accessorKey: "status", header: "Status", cell: ({ row }) => <WorkspaceStatusBadge status={row.original.status} /> },
  ];
}

/** The tenant's trader workspaces. They wear the tenant's brand, so this page needs white-label. */
export function TradersPage({ appDomain }: { appDomain: string }) {
  const { tenant, workspaces, branding, isLoading, isError } = useCurrentTenant();
  const columns = React.useMemo(() => columnsFor(branding, appDomain), [branding, appDomain]);

  if (isError) return <ErrorState />;
  if (isLoading || !tenant) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <TableSkeleton rows={3} cols={6} className="lg:col-span-2" />
      </div>
    );
  }

  if (!tenant.whiteLabel) {
    return (
      <WhiteLabelGate
        title="Trader workspaces need white-label"
        description="Your traders sign up on nasscord.com through your referral link and you earn commission on them. Running workspaces for them under your own brand is part of white-label."
      />
    );
  }

  const seats = workspaces.reduce((s, w) => s + w.seats, 0);
  const seatFee = seats * PROGRAM.perSeat;
  const invoice = PROGRAM.platformFee + seatFee;
  const billed = workspaces.reduce((s, w) => s + w.mrr, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <DataTable
          columns={columns}
          data={workspaces}
          searchPlaceholder="Search workspaces"
          emptyMessage="No trader workspaces yet. Add one to set up a workspace in your brand."
          toolbar={<AddWorkspaceDialog tenantId={tenant.id} branding={branding} appDomain={appDomain} />}
        />
      </div>
      <Card className="self-start">
        <CardHeader>
          <CardTitle>How seat billing works</CardTitle>
          <CardDescription>Nasscord invoices you once a month. You bill your traders on your own plans.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <KV
            items={[
              { label: "Platform fee", value: `${fmtMoney(PROGRAM.platformFee, { digits: 0 })}/mo` },
              { label: "Active seats", value: `${fmtNum(seats)} x ${fmtMoney(PROGRAM.perSeat, { digits: 0 })} = ${fmtMoney(seatFee, { digits: 0 })}` },
              { label: "Your invoice this month", value: fmtMoney(invoice, { digits: 0 }) },
              { label: "You bill your traders", value: fmtMoney(billed, { digits: 0 }) },
              { label: "You keep", value: <span className="text-gain-foreground">{fmtMoney(billed - invoice, { digits: 0 })}</span> },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            A seat is any trader who signed in during the month; suspended traders do not count. Seats above a workspace&apos;s limit are blocked at invite time, not billed.
          </p>
          <Button variant="outline" size="sm" render={<Link href="/tenant/plans" />}>
            Edit your plans and prices
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

const schema = z.object({
  name: z.string().trim().min(2, "Enter the customer or desk name.").max(60, "Keep it under 60 characters."),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/, "Lowercase letters, numbers and hyphens, 2 to 32 characters."),
  ownerEmail: z.email("Enter the trader's email."),
  seatLimit: z.coerce.number({ error: "Enter a number." }).int("Whole seats only.").min(1, "At least 1 seat.").max(1000, "Talk to us for more than 1,000 seats."),
});
type Input = z.input<typeof schema>;
type Values = z.output<typeof schema>;

function AddWorkspaceDialog({ tenantId, branding, appDomain }: { tenantId: string; branding: TenantBranding | null; appDomain: string }) {
  const [open, setOpen] = React.useState(false);
  const addWorkspace = useTenantStore((s) => s.addWorkspace);
  const ids = { name: React.useId(), slug: React.useId(), owner: React.useId(), seats: React.useId() };
  const form = useForm<Input, unknown, Values>({ resolver: zodResolver(schema), defaultValues: { name: "", slug: "", ownerEmail: "", seatLimit: 5 } });
  const { errors, isSubmitting } = form.formState;
  const [slugTouched, setSlugTouched] = React.useState(false);

  async function onSubmit(v: Values) {
    await new Promise((r) => setTimeout(r, 400));
    addWorkspace({
      id: `w_${v.slug}`,
      slug: v.slug,
      name: v.name,
      plan: "enterprise",
      status: "trial",
      createdAt: new Date().toISOString(),
      seats: 0,
      seatLimit: v.seatLimit,
      mrr: 0,
      brokers: [],
      tenantId,
      owner: { name: v.ownerEmail.split("@")[0], email: v.ownerEmail },
      features: { tradescope: true, options: true, extendedHours: true, paperDefault: true },
      timezone: "America/New_York",
    });
    toast.success(`${v.name} created`, { description: `Invite sent to ${v.ownerEmail}. The workspace is live at ${hostFor(v, branding, appDomain)} in trial.` });
    form.reset();
    setSlugTouched(false);
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) form.reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" className="ml-auto" />}>
        <Plus data-icon="inline-start" />
        Add trader workspace
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a trader workspace</DialogTitle>
            <DialogDescription>Sets up a workspace for one of your traders or desks, in your brand. The trader receives an invite; billing starts when the trial ends.</DialogDescription>
          </DialogHeader>
          <Field id={ids.name} label="Customer or desk name" error={errors.name?.message}>
            <Input
              id={ids.name}
              autoComplete="organization"
              aria-invalid={!!errors.name}
              {...form.register("name", {
                onChange: (e) => {
                  if (!slugTouched) form.setValue("slug", slugify(e.target.value));
                },
              })}
            />
          </Field>
          <Field
            id={ids.slug}
            label="Workspace subdomain"
            hint={branding?.domain ? `The workspace's own address. Its traders sign in at ${branding.domain}.` : "Traders sign in at this address until you attach a custom domain."}
            error={errors.slug?.message}
          >
            <div className="flex items-center gap-1.5">
              <Input
                id={ids.slug}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!errors.slug}
                {...form.register("slug", {
                  onChange: () => setSlugTouched(true),
                })}
              />
              <span className="shrink-0 text-xs text-muted-foreground">.{appDomain}</span>
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field id={ids.owner} label="Trader email" error={errors.ownerEmail?.message}>
              <Input id={ids.owner} type="email" autoComplete="off" aria-invalid={!!errors.ownerEmail} {...form.register("ownerEmail")} />
            </Field>
            <Field id={ids.seats} label="Seat limit" error={errors.seatLimit?.message}>
              <Input id={ids.seats} type="number" min={1} max={1000} inputMode="numeric" className="tabular" aria-invalid={!!errors.seatLimit} {...form.register("seatLimit")} />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating" : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
