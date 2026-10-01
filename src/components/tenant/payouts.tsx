"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Download, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/data-table";
import { StatCard } from "@/components/stat-card";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { Payout } from "@/lib/types";
import { PROGRAM, useCurrentTenant } from "./current";
import { payoutDateFor, periodStart, sortByPeriod } from "./program";
import { ErrorState, Field, KV, PayoutStatusBadge, StatGridSkeleton, TableSkeleton } from "./primitives";
import { useTenantStore } from "./store";

const COLUMNS: ColumnDef<Payout>[] = [
  {
    accessorKey: "period",
    header: "Period",
    sortingFn: (a, b) => periodStart(a.original.period).getTime() - periodStart(b.original.period).getTime(),
    cell: ({ row }) => <span className="font-medium">{row.original.period}</span>,
  },
  { accessorKey: "amount", header: "Amount", meta: { align: "right" }, cell: ({ row }) => <span className="font-medium tabular">{fmtMoney(row.original.amount)}</span> },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <PayoutStatusBadge status={row.original.status} /> },
  {
    id: "paidAt",
    header: "Paid",
    accessorFn: (p) => p.paidAt ?? payoutDateFor(p.period),
    cell: ({ row }) => {
      const p = row.original;
      if (p.status === "paid" && p.paidAt) return <span className="tabular">{fmtDate(p.paidAt)}</span>;
      if (p.status === "on_hold") return <span className="text-muted-foreground">Held, see statement</span>;
      return <span className="text-muted-foreground tabular">Expected {fmtDate(payoutDateFor(p.period))}</span>;
    },
  },
  {
    id: "statement",
    header: "Statement",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Download statement for ${row.original.period}`}
        onClick={() => toast.success(`Statement for ${row.original.period} is downloading`, { description: `${row.original.id.toUpperCase()}.pdf, includes every referred subscription and adjustment.` })}
      >
        <Download data-icon="inline-start" />
        PDF
      </Button>
    ),
  },
];

export function PayoutsPage() {
  const { tenant, payouts, isLoading, isError } = useCurrentTenant();

  if (isError) return <ErrorState />;
  if (isLoading || !tenant) {
    return (
      <div className="flex flex-col gap-5">
        <StatGridSkeleton count={2} />
        <TableSkeleton rows={6} cols={5} />
      </div>
    );
  }

  const ordered = sortByPeriod(payouts);
  const paidTotal = ordered.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);
  const scheduled = ordered.filter((p) => p.status === "scheduled");
  const scheduledTotal = scheduled.reduce((s, p) => s + p.amount, 0);
  const held = ordered.filter((p) => p.status === "on_hold").reduce((s, p) => s + p.amount, 0);
  const nextDate = scheduled[0] ? payoutDateFor(scheduled[0].period) : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Paid to date" value={fmtMoney(paidTotal)} delta={`${ordered.filter((p) => p.status === "paid").length} payouts`} />
        <StatCard label="Scheduled" value={fmtMoney(scheduledTotal)} delta={nextDate ? fmtDate(nextDate) : "Nothing scheduled"} />
        <StatCard label="On hold" value={fmtMoney(held)} delta={held > 0 ? "Action needed" : "Nothing held"} upIsGood={false} className="hidden xl:flex" />
        <StatCard label="Minimum payout" value={fmtMoney(PROGRAM.minimumPayout, { digits: 0 })} delta="Smaller balances roll over" className="hidden xl:flex" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DataTable
            columns={COLUMNS}
            data={[...ordered].reverse()}
            searchable={false}
            pageSize={8}
            emptyMessage="No payouts yet. Commission accrues once a referred account has paid for a full month."
          />
        </div>
        <div className="grid gap-4 self-start">
          <PayoutMethodCard />
          <Card>
            <CardHeader>
              <CardTitle>Schedule</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm text-muted-foreground">
              <p>
                Commission accrues through the last day of each month and is paid on the {PROGRAM.payoutDay}th of the following month by ACH. Transfers usually settle in 1 to 2
                business days.
              </p>
              <p>Balances under {fmtMoney(PROGRAM.minimumPayout, { digits: 0 })} roll into the next month. Refunds and chargebacks on referred accounts are netted against the next payout.</p>
              <p>Statements are posted on the 1st and list every referred subscription, its plan and the commission applied.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

const methodSchema = z.object({
  holder: z.string().trim().min(2, "Enter the account holder name.").max(80, "Keep it under 80 characters."),
  bank: z.string().trim().min(2, "Enter the bank name.").max(80, "Keep it under 80 characters."),
  routing: z.string().trim().regex(/^\d{9}$/, "Routing numbers are 9 digits."),
  account: z.string().trim().regex(/^\d{6,17}$/, "Account numbers are 6 to 17 digits."),
});
type MethodValues = z.output<typeof methodSchema>;

function PayoutMethodCard() {
  const method = useTenantStore((s) => s.payoutMethod);
  const setPayoutMethod = useTenantStore((s) => s.setPayoutMethod);
  const [open, setOpen] = React.useState(false);
  const ids = { holder: React.useId(), bank: React.useId(), routing: React.useId(), account: React.useId() };
  const form = useForm<MethodValues>({ resolver: zodResolver(methodSchema), defaultValues: { holder: method.holder, bank: method.bank, routing: "", account: "" } });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(v: MethodValues) {
    await new Promise((r) => setTimeout(r, 500));
    setPayoutMethod({ holder: v.holder, bank: v.bank, last4: v.account.slice(-4) });
    toast.success("Payout method updated", { description: `ACH to ${v.bank} ending ${v.account.slice(-4)}. A $0.01 verification deposit arrives within 2 business days.` });
    form.reset({ holder: v.holder, bank: v.bank, routing: "", account: "" });
    setOpen(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payout method</CardTitle>
        <CardDescription>Where commissions are sent.</CardDescription>
        <CardAction>
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              if (!o) form.reset({ holder: method.holder, bank: method.bank, routing: "", account: "" });
            }}
          >
            <DialogTrigger render={<Button variant="outline" size="sm" />}>Edit</DialogTrigger>
            <DialogContent>
              <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
                <DialogHeader>
                  <DialogTitle>Update payout method</DialogTitle>
                  <DialogDescription>US bank accounts only. The change applies from the next scheduled payout after a verification deposit clears.</DialogDescription>
                </DialogHeader>
                <Field id={ids.holder} label="Account holder" error={errors.holder?.message}>
                  <Input id={ids.holder} autoComplete="organization" aria-invalid={!!errors.holder} {...form.register("holder")} />
                </Field>
                <Field id={ids.bank} label="Bank" error={errors.bank?.message}>
                  <Input id={ids.bank} autoComplete="off" aria-invalid={!!errors.bank} {...form.register("bank")} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id={ids.routing} label="Routing number" error={errors.routing?.message}>
                    <Input id={ids.routing} inputMode="numeric" className="font-mono" autoComplete="off" aria-invalid={!!errors.routing} {...form.register("routing")} />
                  </Field>
                  <Field id={ids.account} label="Account number" error={errors.account?.message}>
                    <Input id={ids.account} inputMode="numeric" className="font-mono" autoComplete="off" aria-invalid={!!errors.account} {...form.register("account")} />
                  </Field>
                </div>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Saving" : "Save method"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Landmark className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              ACH <span className="font-mono">•••• {method.last4}</span>
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {method.bank} · {method.holder}
            </p>
          </div>
        </div>
        <KV className="mt-3" items={[{ label: "Verified", value: "Mar 6, 2026" }, { label: "Tax form", value: "W-9 on file" }]} />
      </CardContent>
    </Card>
  );
}
