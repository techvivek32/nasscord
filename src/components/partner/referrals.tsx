"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DataTable } from "@/components/data-table";
import { StatCard } from "@/components/stat-card";
import { fmtDate, fmtNum } from "@/lib/format";
import { copyText } from "./clipboard";
import { REFERRAL_BASE_URL, useCurrentPartner } from "./current";
import type { ReferralCode } from "./program";
import { ErrorState, Field, StatGridSkeleton, TableSkeleton, ToneBadge } from "./primitives";
import { usePartnerStore } from "./store";

function pct(part: number, whole: number) {
  return whole ? `${Math.round((part / whole) * 1000) / 10}%` : "0%";
}

export function ReferralsPage() {
  const { partner, program, isLoading, isError } = useCurrentPartner();
  const createdCodes = usePartnerStore((s) => s.createdCodes);
  const codeActive = usePartnerStore((s) => s.codeActive);
  const setCodeActive = usePartnerStore((s) => s.setCodeActive);

  const codes = React.useMemo<ReferralCode[]>(() => {
    const base = program?.codes ?? [];
    return [...createdCodes, ...base].map((c) => ({ ...c, active: codeActive[c.code] ?? c.active }));
  }, [program, createdCodes, codeActive]);

  const columns = React.useMemo<ColumnDef<ReferralCode>[]>(
    () => [
      {
        accessorKey: "code",
        header: "Code",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-mono text-sm font-medium">{row.original.code}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Copy link for ${row.original.code}`}
              onClick={async () => {
                const link = `${REFERRAL_BASE_URL}${row.original.code}`;
                const ok = await copyText(link);
                if (ok) toast.success("Link copied", { description: link });
                else toast.error("Could not copy automatically", { description: link });
              }}
            >
              <Copy />
            </Button>
          </span>
        ),
      },
      { accessorKey: "label", header: "Label", cell: ({ row }) => <span className="text-sm">{row.original.label}</span> },
      { accessorKey: "clicks", header: "Clicks", meta: { align: "right" }, cell: ({ row }) => fmtNum(row.original.clicks) },
      {
        accessorKey: "signups",
        header: "Signups",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span>
            {fmtNum(row.original.signups)} <span className="text-xs text-muted-foreground">({pct(row.original.signups, row.original.clicks)})</span>
          </span>
        ),
      },
      {
        accessorKey: "paid",
        header: "Paid",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span>
            {fmtNum(row.original.paid)} <span className="text-xs text-muted-foreground">({pct(row.original.paid, row.original.signups)})</span>
          </span>
        ),
      },
      { accessorKey: "createdAt", header: "Created", cell: ({ row }) => <span className="text-muted-foreground">{fmtDate(row.original.createdAt)}</span> },
      {
        accessorKey: "active",
        header: "Status",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="inline-flex items-center justify-end gap-2">
            <ToneBadge tone={row.original.active ? "good" : "neutral"}>{row.original.active ? "Active" : "Paused"}</ToneBadge>
            <Switch
              size="sm"
              checked={row.original.active}
              aria-label={`${row.original.active ? "Pause" : "Activate"} code ${row.original.code}`}
              onCheckedChange={(on) => {
                setCodeActive(row.original.code, on);
                toast.success(on ? `${row.original.code} is active` : `${row.original.code} paused`, {
                  description: on ? "New visits through this code are attributed to you again." : "Existing attributions keep their 90-day window.",
                });
              }}
            />
          </span>
        ),
      },
    ],
    [setCodeActive],
  );

  if (isError) return <ErrorState />;
  if (isLoading || !partner || !program) {
    return (
      <div className="flex flex-col gap-5">
        <StatGridSkeleton count={4} />
        <TableSkeleton rows={4} cols={7} />
      </div>
    );
  }

  const f = program.funnel;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Clicks" value={fmtNum(f.clicks)} delta="Last 90 days" />
        <StatCard label="Signups" value={fmtNum(f.signups)} delta={pct(f.signups, f.clicks)} deltaLabel="of clicks" />
        <StatCard label="Trials" value={fmtNum(f.trials)} delta={pct(f.trials, f.signups)} deltaLabel="of signups" />
        <StatCard label="Paid" value={fmtNum(f.paid)} delta={pct(f.paid, f.trials)} deltaLabel="of trials" />
      </div>

      <DataTable
        columns={columns}
        data={codes}
        searchPlaceholder="Search codes and labels"
        emptyMessage="No referral codes yet. Create one to start tracking a channel."
        toolbar={<CreateCodeDialog partnerCode={partner.referralCode} existing={codes.map((c) => c.code)} />}
      />
    </div>
  );
}

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,15}$/;

function normalizeCode(v: string) {
  return v
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 16);
}

function CreateCodeDialog({ partnerCode, existing }: { partnerCode: string; existing: string[] }) {
  const [open, setOpen] = React.useState(false);
  const addCode = usePartnerStore((s) => s.addCode);
  const ids = { label: React.useId(), code: React.useId() };

  const schema = React.useMemo(
    () =>
      z.object({
        label: z.string().trim().min(2, "Give the code a label you will recognise.").max(40, "Keep the label under 40 characters."),
        code: z
          .string()
          .trim()
          .regex(CODE_RE, "2 to 16 characters: letters, numbers and hyphens.")
          .refine((c) => !existing.includes(c), "That code is already in use."),
      }),
    [existing],
  );
  type Values = z.output<typeof schema>;

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { label: "", code: `${partnerCode}-` } });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(values: Values) {
    await new Promise((r) => setTimeout(r, 300));
    addCode({ code: values.code, label: values.label, clicks: 0, signups: 0, paid: 0, createdAt: new Date().toISOString(), active: true });
    toast.success(`Code ${values.code} created`, { description: `${REFERRAL_BASE_URL}${values.code}` });
    form.reset({ label: "", code: `${partnerCode}-` });
    setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) form.reset({ label: "", code: `${partnerCode}-` });
      }}
    >
      <DialogTrigger render={<Button size="sm" className="ml-auto" />}>
        <Plus data-icon="inline-start" />
        Create code
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create a referral code</DialogTitle>
            <DialogDescription>One code per channel keeps attribution readable: a podcast, a newsletter, an event.</DialogDescription>
          </DialogHeader>
          <Field id={ids.label} label="Label" error={errors.label?.message}>
            <Input id={ids.label} placeholder="Options webinar, October" autoComplete="off" aria-invalid={!!errors.label} {...form.register("label")} />
          </Field>
          <Field id={ids.code} label="Code" hint="Uppercased automatically. Traders see it in the link." error={errors.code?.message}>
            <Input
              id={ids.code}
              className="font-mono uppercase"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!errors.code}
              {...form.register("code", { onChange: (e) => form.setValue("code", normalizeCode(e.target.value), { shouldValidate: form.formState.isSubmitted }) })}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating" : "Create code"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
