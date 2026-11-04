"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { createTenant, decideTenantApplication, viewTenantPortal } from "@/lib/server/console-actions";
import { setTenantReferralCode } from "@/lib/server/console-extra";
import { fmtNum, slugify } from "@/lib/format";
import { COMMISSION_PCT } from "@/lib/plans";
import type { Tenant, TenantApplication, TenantApplicationStatus } from "@/lib/types";
import { ApplicationStatusBadge, TenantStatusBadge, ToneBadge, WhiteLabelBadge } from "./badges";
import { attempt, fmtDay } from "./lib";

/* ------------------------------------------------------------------
   Tenants and tenant applications, read on the server and changed
   through the console server actions. Approving an application only
   records the decision; the tenant is created separately, once the
   applicant has signed up, because the tenant's login is their account.
   ------------------------------------------------------------------ */

function tenantColumns(onEditCode: (t: Tenant) => void, onView: (t: Tenant) => void): ColumnDef<Tenant>[] {
  return [
    {
      id: "name",
      accessorFn: (t) => `${t.name} ${t.slug} ${t.contact ?? ""}`,
      header: "Tenant",
      cell: ({ row }) => (
        <div className="grid gap-0.5">
          <span className="font-medium">{row.original.name}</span>
          <span className="text-xs text-muted-foreground">{row.original.contact ?? <span className="font-mono">{row.original.slug}</span>}</span>
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
          <Link href="/admin/white-label" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
            Manage
          </Link>
        </span>
      ),
    },
    {
      accessorKey: "referralCode",
      header: "Code",
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          {row.original.referralCode ? <span className="font-mono text-xs">{row.original.referralCode}</span> : <span className="text-xs text-muted-foreground">None</span>}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={row.original.referralCode ? `Change the referral code of ${row.original.name}` : `Add a referral code for ${row.original.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onEditCode(row.original);
            }}
          >
            <Pencil />
          </Button>
        </span>
      ),
    },
    { accessorKey: "status", header: "Status", cell: ({ row }) => <TenantStatusBadge status={row.original.status} /> },
    { accessorKey: "createdAt", header: "Created", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.createdAt)}</span> },
    {
      id: "portal",
      header: "",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) => (
        <Button
          size="xs"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            onView(row.original);
          }}
        >
          View portal
        </Button>
      ),
    },
  ];
}

type AppFilter = "all" | TenantApplicationStatus;
type Decision = { application: TenantApplication; decision: "approved" | "declined" } | null;

export function TenantsPage({ tenants, applications }: { tenants: Tenant[]; applications: TenantApplication[] }) {
  const [createFrom, setCreateFrom] = React.useState<{ key: number; defaults: Partial<CreateValues> } | null>(null);
  const [filter, setFilter] = React.useState<AppFilter>("pending");
  const [decision, setDecision] = React.useState<Decision>(null);
  const [deciding, startDeciding] = React.useTransition();
  const [editCode, setEditCode] = React.useState<{ key: number; tenant: Tenant } | null>(null);
  const router = useRouter();
  const viewPortal = React.useCallback(
    async (tenant: Tenant) => {
      const r = await attempt(() => viewTenantPortal(tenant.id));
      if (!r.ok) {
        toast.error(`${tenant.name}'s portal did not open`, { description: r.error });
        return;
      }
      router.push("/tenant");
    },
    [router],
  );
  const tenantCols = React.useMemo(
    () =>
      tenantColumns(
        (tenant) => setEditCode((c) => ({ key: (c?.key ?? 0) + 1, tenant })),
        (tenant) => void viewPortal(tenant),
      ),
    [viewPortal],
  );

  const ownerEmails = React.useMemo(() => new Set(tenants.map((t) => t.contact?.toLowerCase()).filter(Boolean)), [tenants]);
  const shown = React.useMemo(() => (filter === "all" ? applications : applications.filter((a) => a.status === filter)), [applications, filter]);
  const openCreate = React.useCallback((defaults: Partial<CreateValues> = {}) => setCreateFrom((c) => ({ key: (c?.key ?? 0) + 1, defaults })), []);

  const fromApplication = React.useCallback(
    (a: TenantApplication) => openCreate({ name: a.company || a.name, slug: slugFrom(a.company || a.name), ownerEmail: a.email, whiteLabel: false }),
    [openCreate],
  );

  const appColumns = React.useMemo<ColumnDef<TenantApplication>[]>(
    () => [
      {
        id: "who",
        accessorFn: (a) => `${a.company} ${a.name} ${a.email}`,
        header: "Applicant",
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span className="font-medium">{row.original.company}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.name} · {row.original.email}
            </span>
          </div>
        ),
      },
      {
        id: "offer",
        accessorFn: (a) => a.offer,
        header: "Asked for",
        cell: ({ row }) => (row.original.wantsWhiteLabel ? <ToneBadge tone="brand">White-label</ToneBadge> : <ToneBadge tone="neutral">Commission</ToneBadge>),
      },
      {
        id: "expected",
        accessorFn: (a) => a.expectedTraders ?? -1,
        header: "Expected traders",
        meta: { align: "right" },
        cell: ({ row }) => <span className="tabular">{row.original.expectedTraders !== undefined ? fmtNum(row.original.expectedTraders) : ""}</span>,
      },
      {
        id: "notes",
        accessorFn: (a) => a.notes ?? "",
        header: "Notes",
        enableSorting: false,
        cell: ({ row }) => <span className="line-clamp-2 max-w-72 text-xs whitespace-normal text-muted-foreground">{row.original.notes}</span>,
      },
      { accessorKey: "submittedAt", header: "Submitted", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.submittedAt)}</span> },
      { accessorKey: "status", header: "Status", cell: ({ row }) => <ApplicationStatusBadge status={row.original.status} /> },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => {
          const a = row.original;
          if (a.status === "pending") {
            return (
              <span className="flex justify-end gap-1.5">
                <Button size="xs" onClick={() => setDecision({ application: a, decision: "approved" })}>
                  Approve
                </Button>
                <Button size="xs" variant="outline" onClick={() => setDecision({ application: a, decision: "declined" })}>
                  Decline
                </Button>
              </span>
            );
          }
          if (a.status === "approved") {
            return ownerEmails.has(a.email.toLowerCase()) ? (
              <span className="text-xs text-muted-foreground">Tenant created</span>
            ) : (
              <Button size="xs" variant="outline" onClick={() => fromApplication(a)}>
                Create tenant
              </Button>
            );
          }
          return null;
        },
      },
    ],
    [ownerEmails, fromApplication],
  );

  function decide() {
    if (!decision) return;
    const { application, decision: next } = decision;
    startDeciding(async () => {
      const r = await attempt(() => decideTenantApplication(application.id, next));
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setDecision(null);
      if (next === "approved") {
        toast.success(`${application.company} approved`, {
          description: "Create the tenant once they have signed up with their email.",
          action: { label: "Create tenant", onClick: () => fromApplication(application) },
        });
      } else {
        toast.success(`${application.company} declined`);
      }
    });
  }

  const counts = { pending: applications.filter((a) => a.status === "pending").length, approved: applications.filter((a) => a.status === "approved").length, declined: applications.filter((a) => a.status === "declined").length };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Tenants</CardTitle>
          <CardDescription>Every tenant on the platform, with the traders whose workspace came through their code. White-label is granted on the White-label page.</CardDescription>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 ? (
            <EmptyState
              title="No tenants yet"
              description="Create one directly, or approve an application and create the tenant from it."
              action={
                <Button size="sm" onClick={() => openCreate()}>
                  <Plus data-icon="inline-start" />
                  Create tenant
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={tenantCols}
              data={tenants}
              searchPlaceholder="Search tenant, slug, owner, code…"
              pageSize={10}
              toolbar={
                <Button size="sm" className="ml-auto" onClick={() => openCreate()}>
                  <Plus data-icon="inline-start" />
                  Create tenant
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Applications</CardTitle>
          <CardDescription>Sent from the public tenants page. Approving or declining records the decision; nobody is emailed, so reply to the applicant yourself.</CardDescription>
        </CardHeader>
        <CardContent>
          {applications.length === 0 ? (
            <EmptyState title="No applications yet" description="Applications appear here when someone applies on the public tenants page." />
          ) : (
            <DataTable
              columns={appColumns}
              data={shown}
              searchPlaceholder="Search company, name, email…"
              pageSize={10}
              emptyMessage={filter === "pending" ? "No applications are waiting for a decision." : "No applications with this status."}
              toolbar={
                <ToggleGroup
                  variant="outline"
                  spacing={0}
                  value={[filter]}
                  onValueChange={(next) => {
                    const v = next[0] as AppFilter | undefined;
                    if (v) setFilter(v);
                  }}
                  aria-label="Filter by status"
                  className="overflow-x-auto"
                >
                  {(
                    [
                      ["pending", `Pending ${counts.pending}`],
                      ["approved", `Approved ${counts.approved}`],
                      ["declined", `Declined ${counts.declined}`],
                      ["all", "All"],
                    ] as const
                  ).map(([v, label]) => (
                    <ToggleGroupItem key={v} value={v} size="sm" className="px-3 whitespace-nowrap tabular data-pressed:bg-muted aria-pressed:bg-muted">
                      {label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              }
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payouts</CardTitle>
          <CardDescription>Commission owed to tenants on their traders&apos; subscriptions.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState title="Payouts are not connected yet" description="There is no billing source, so no commission has been earned or paid." />
        </CardContent>
      </Card>

      <Dialog open={decision !== null} onOpenChange={(o) => !o && !deciding && setDecision(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {decision?.decision === "approved" ? `Approve ${decision.application.company}?` : decision ? `Decline ${decision.application.company}?` : ""}
            </DialogTitle>
            <DialogDescription>
              {decision?.decision === "approved"
                ? `This records the approval. It does not create the tenant or email ${decision.application.email}. Create the tenant next; ${decision.application.name} needs an account with that email to become its login.`
                : decision
                  ? `This records the decision. Nasscord does not email the applicant; write to ${decision.application.email} yourself if you want to explain.`
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={deciding} onClick={() => setDecision(null)}>
              Cancel
            </Button>
            <Button variant={decision?.decision === "declined" ? "destructive" : "default"} disabled={deciding} onClick={decide}>
              {deciding ? "Saving" : decision?.decision === "approved" ? "Approve" : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {createFrom ? <CreateTenantDialog key={createFrom.key} defaults={createFrom.defaults} onClose={() => setCreateFrom(null)} /> : null}
      {editCode ? <ReferralCodeDialog key={editCode.key} tenant={editCode.tenant} onClose={() => setEditCode(null)} /> : null}
    </div>
  );
}

/* ---------------- create tenant ---------------- */

const createSchema = z.object({
  name: z.string().trim().min(2, "Enter the tenant's name").max(80, "Keep the name under 80 characters"),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, "Use 3 to 40 lowercase letters, numbers and hyphens"),
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[A-Z0-9-]{3,24}$/.test(v), "Codes are 3 to 24 letters, numbers or hyphens"),
  commissionPct: z
    .string()
    .trim()
    .refine((v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100, "Commission is a number from 0 to 100"),
  ownerEmail: z.string().trim().refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid owner email, or leave it empty"),
  whiteLabel: z.boolean(),
});
type CreateInput = z.input<typeof createSchema>;
type CreateValues = z.output<typeof createSchema>;
type CreateField = keyof CreateValues;

const CREATE_FIELDS: CreateField[] = ["name", "slug", "referralCode", "commissionPct", "ownerEmail", "whiteLabel"];

/** A tenant slug suggested from a name: never ends on a hyphen after truncation. */
function slugFrom(name: string) {
  return slugify(name).replace(/-+$/, "");
}

function codeFrom(name: string) {
  return name
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12)
    .toUpperCase();
}

function CreateTenantDialog({ defaults, onClose }: { defaults: Partial<CreateValues>; onClose: () => void }) {
  const [open, setOpen] = React.useState(true);
  const form = useForm<CreateInput, unknown, CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: defaults.name ?? "",
      slug: defaults.slug ?? "",
      referralCode: defaults.referralCode ?? (defaults.name ? codeFrom(defaults.name) : ""),
      commissionPct: defaults.commissionPct ?? String(COMMISSION_PCT),
      ownerEmail: defaults.ownerEmail ?? "",
      whiteLabel: defaults.whiteLabel ?? false,
    },
  });
  const { errors, isSubmitting } = form.formState;

  const close = () => {
    setOpen(false);
    onClose();
  };

  async function onSubmit(v: CreateValues) {
    const input = { name: v.name, slug: v.slug, referralCode: v.referralCode, commissionPct: Number(v.commissionPct), ownerEmail: v.ownerEmail, whiteLabel: v.whiteLabel };
    const r = await attempt(() => createTenant(input));
    if (!r.ok) {
      const field = CREATE_FIELDS.find((f) => f === r.field);
      if (field) form.setError(field, { message: r.error });
      else toast.error(r.error);
      return;
    }
    toast.success(`${v.name} created`, {
      description: v.ownerEmail ? `${v.ownerEmail} is its owner.` : "No owner was given, so nobody signs in to its portal yet.",
    });
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !isSubmitting && close()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a tenant</DialogTitle>
          <DialogDescription>The owner must already have a Nasscord account with no broker connected. Their login becomes the tenant&apos;s and opens only the tenant portal from then on; their trading workspace stays, without members.</DialogDescription>
        </DialogHeader>
        <form id="create-tenant-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <Field id="tenant-name" label="Name" error={errors.name?.message}>
            <Input
              id="tenant-name"
              placeholder="Company or brand"
              aria-invalid={!!errors.name}
              {...form.register("name", {
                onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
                  // Suggest a slug and a code from the name until they are typed.
                  if (!form.getValues("slug")) form.setValue("slug", slugFrom(e.target.value));
                  if (!form.getValues("referralCode")) form.setValue("referralCode", codeFrom(e.target.value));
                },
              })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="tenant-slug" label="Slug" error={errors.slug?.message} help="Lowercase, used in links.">
              <Input id="tenant-slug" autoComplete="off" spellCheck={false} className="font-mono" aria-invalid={!!errors.slug} {...form.register("slug")} />
            </Field>
            <Field id="tenant-code" label="Referral code" error={errors.referralCode?.message} help="Traders type it at signup. Optional.">
              <Input id="tenant-code" autoComplete="off" spellCheck={false} maxLength={24} className="font-mono uppercase" aria-invalid={!!errors.referralCode} {...form.register("referralCode")} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="tenant-owner" label="Owner email" error={errors.ownerEmail?.message} help="Optional. An existing account.">
              <Input id="tenant-owner" type="email" autoComplete="off" placeholder="owner@company.com" aria-invalid={!!errors.ownerEmail} {...form.register("ownerEmail")} />
            </Field>
            <Field id="tenant-commission" label="Commission, %" error={errors.commissionPct?.message} help={`Standard is ${COMMISSION_PCT}%.`}>
              <Input id="tenant-commission" inputMode="decimal" className="font-mono tabular" aria-invalid={!!errors.commissionPct} {...form.register("commissionPct")} />
            </Field>
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
            <label htmlFor="tenant-wl" className="grid cursor-pointer gap-0.5">
              <span className="text-sm font-medium">White-label</span>
              <span className="text-xs text-muted-foreground">Their traders see the tenant&apos;s brand once branding is set on the White-label page.</span>
            </label>
            <Controller control={form.control} name="whiteLabel" render={({ field }) => <Switch id="tenant-wl" checked={field.value} onCheckedChange={field.onChange} />} />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="create-tenant-form" disabled={isSubmitting}>
            {isSubmitting ? "Creating" : "Create tenant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- referral code ---------------- */

const codeSchema = z.object({
  referralCode: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[A-Z0-9-]{3,24}$/.test(v), "Codes are 3 to 24 letters, numbers or hyphens"),
});
type CodeInput = z.input<typeof codeSchema>;
type CodeValues = z.output<typeof codeSchema>;

/** Sets, changes or removes a tenant's referral code through setTenantReferralCode (audited). */
function ReferralCodeDialog({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const [open, setOpen] = React.useState(true);
  const form = useForm<CodeInput, unknown, CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { referralCode: tenant.referralCode ?? codeFrom(tenant.name) },
  });
  const { errors, isSubmitting } = form.formState;

  const close = () => {
    setOpen(false);
    onClose();
  };

  async function onSubmit(v: CodeValues) {
    const r = await attempt(() => setTenantReferralCode(tenant.id, v.referralCode));
    if (!r.ok) {
      if (r.field === "referralCode") form.setError("referralCode", { message: r.error });
      else toast.error(r.error);
      return;
    }
    toast.success(v.referralCode ? `${tenant.name} uses code ${v.referralCode}` : `${tenant.name} has no referral code now`);
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !isSubmitting && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Referral code for {tenant.name}</DialogTitle>
          <DialogDescription>
            Traders type this code at signup, or open a link that carries it, to join this tenant.
            {tenant.referralCode ? ` Saving a new code stops ${tenant.referralCode} from working at once; traders already on the tenant stay on it.` : ""} Leave it empty to remove the code.
          </DialogDescription>
        </DialogHeader>
        <form id="tenant-code-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <Field id="tenant-code-edit" label="Referral code" error={errors.referralCode?.message} help="3 to 24 letters, numbers or hyphens.">
            <Input id="tenant-code-edit" autoComplete="off" spellCheck={false} maxLength={24} className="font-mono uppercase" aria-invalid={!!errors.referralCode} {...form.register("referralCode")} />
          </Field>
          {tenant.status !== "active" ? <p className="text-sm text-warn-foreground">This tenant is not active, so signup does not accept its code until it is.</p> : null}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="tenant-code-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving" : "Save code"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ id, label, error, help, children }: { id: string; label: string; error?: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}
