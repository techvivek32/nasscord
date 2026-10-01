"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { ShieldCheck } from "lucide-react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { LogoMark } from "@/components/brand/logo";
import { TenantTheme } from "@/components/tenant-theme";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkspaces } from "@/hooks/queries";
import { fmtMoney, fmtNum, timeAgo } from "@/lib/format";
import { COMMISSION_PCT, WHITE_LABEL_FEE } from "@/lib/plans";
import { DEFAULT_BRANDING, whiteLabelBranding } from "@/lib/branding";
import type { Tenant, TenantBranding } from "@/lib/types";
import { TenantStatusBadge, ToneBadge, WhiteLabelBadge } from "./badges";
import { DEMO_NOW, PLATFORM_DOMAIN } from "./lib";
import { KV, ListSkeleton, StatGridSkeleton, TableSkeleton } from "./primitives";
import { useConsoleStore, useConsoleTenants } from "./store";

/* ------------------------------------------------------------------
   White-label: the super admin's switch for a tenant's brand. Granting it
   puts the tenant's name, accent colors and domain on the terminal their
   traders use; revoking it puts Nasscord back. Commission never changes.
   ------------------------------------------------------------------ */

const HEX = /^#[0-9a-fA-F]{6}$/;
const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EDGE_HOST = `edge.${PLATFORM_DOMAIN}`;
const hex = z.string().trim().regex(HEX, "Use a 6-digit hex color like #0F766E.");

const schema = z.object({
  name: z.string().trim().min(2, "Enter the brand name traders see.").max(40, "Keep it under 40 characters."),
  accent: hex,
  accentDark: hex,
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === "" || HOST.test(v), "Enter a hostname like trade.acmecap.com, or leave it empty."),
  supportEmail: z
    .string()
    .trim()
    .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid support email, or leave it empty."),
});
type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

type EditorMode = "grant" | "edit";

export function WhiteLabelPage() {
  const { query, tenants, byId } = useConsoleTenants();
  const workspaces = useWorkspaces();
  const decisions = useConsoleStore((s) => s.tenantDecisions);
  const addedTenants = useConsoleStore((s) => s.addedTenants);
  // `session` remounts the form on every open so its defaults come from the tenant as it is now.
  const [editor, setEditor] = React.useState<{ tenantId: string; mode: EditorMode; session: number; open: boolean } | null>(null);
  const [revokeId, setRevokeId] = React.useState<string | null>(null);

  const openEditor = React.useCallback((tenantId: string, mode: EditorMode) => setEditor((e) => ({ tenantId, mode, session: (e?.session ?? 0) + 1, open: true })), []);

  const stats = React.useMemo(() => {
    const on = tenants.filter((t) => t.whiteLabel);
    const branded = (workspaces.data ?? []).filter((w) => w.tenantId && byId.get(w.tenantId)?.whiteLabel);
    return {
      on: on.length,
      domains: on.filter((t) => t.branding?.domain).length,
      seats: branded.reduce((s, w) => s + w.seats, 0),
      brandedWorkspaces: branded.length,
    };
  }, [tenants, workspaces.data, byId]);

  const requests = React.useMemo(() => (query.data?.applications ?? []).filter((a) => a.wantsWhiteLabel && decisions[a.id] !== "declined"), [query.data, decisions]);
  const pendingRequests = requests.filter((a) => !decisions[a.id]).length;

  const columns = React.useMemo<ColumnDef<Tenant>[]>(
    () => [
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
      { accessorKey: "status", header: "Status", cell: ({ row }) => <TenantStatusBadge status={row.original.status} /> },
      {
        id: "whiteLabel",
        accessorFn: (t) => (t.whiteLabel ? "on" : "off"),
        header: "White-label",
        cell: ({ row }) => <WhiteLabelBadge on={row.original.whiteLabel} compact />,
      },
      {
        id: "brand",
        accessorFn: (t) => whiteLabelBranding(t)?.name ?? "Nasscord",
        header: "Brand name",
        cell: ({ row }) => {
          const b = whiteLabelBranding(row.original);
          return b ? <span className="font-medium">{b.name}</span> : <span className="text-muted-foreground">Nasscord</span>;
        },
      },
      {
        id: "domain",
        accessorFn: (t) => whiteLabelBranding(t)?.domain ?? "",
        header: "Domain",
        cell: ({ row }) => {
          const b = whiteLabelBranding(row.original);
          if (b?.domain) return <span className="font-mono text-xs">{b.domain}</span>;
          return <span className="text-xs text-muted-foreground">{b ? `Subdomains of ${PLATFORM_DOMAIN}` : "None"}</span>;
        },
      },
      {
        id: "accent",
        accessorFn: (t) => whiteLabelBranding(t)?.accent ?? "",
        header: "Accent",
        enableSorting: false,
        cell: ({ row }) => {
          const b = whiteLabelBranding(row.original);
          if (!b) return <span className="text-xs text-muted-foreground">Nasscord default</span>;
          return (
            <span className="flex items-center gap-1.5" title={`Light ${b.accent.toUpperCase()}, dark ${b.accentDark.toUpperCase()}`}>
              <Swatch color={b.accent} label="Light accent" />
              <Swatch color={b.accentDark} label="Dark accent" />
              <span className="font-mono text-xs text-muted-foreground uppercase">{b.accent}</span>
            </span>
          );
        },
      },
      { accessorKey: "workspaces", header: "Traders", meta: { align: "right" }, cell: ({ row }) => <span className="tabular">{fmtNum(row.original.workspaces)}</span> },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => {
          const t = row.original;
          return t.whiteLabel ? (
            <span className="flex justify-end gap-1.5">
              <Button variant="outline" size="xs" onClick={() => openEditor(t.id, "edit")}>
                Edit branding
              </Button>
              <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => setRevokeId(t.id)}>
                Revoke
              </Button>
            </span>
          ) : (
            <Button size="xs" onClick={() => openEditor(t.id, "grant")}>
              Grant white-label
            </Button>
          );
        },
      },
    ],
    [openEditor],
  );

  const editing = editor ? byId.get(editor.tenantId) : undefined;
  const revoking = revokeId ? byId.get(revokeId) : undefined;
  /** Domains other tenants already serve, so two tenants never claim the same host. */
  const takenDomains = React.useMemo(() => {
    const out = new Set<string>();
    for (const t of tenants) {
      const d = t.id === editor?.tenantId ? undefined : whiteLabelBranding(t)?.domain;
      if (d) out.add(d.toLowerCase());
    }
    return out;
  }, [tenants, editor?.tenantId]);
  /** Without a custom domain, a tenant's traders keep their own subdomain; the preview shows the first one. */
  const subdomainHost = React.useMemo(() => {
    const slug = (workspaces.data ?? []).find((w) => w.tenantId === editor?.tenantId)?.slug;
    return slug ? `${slug}.${PLATFORM_DOMAIN}` : `yourtrader.${PLATFORM_DOMAIN}`;
  }, [workspaces.data, editor?.tenantId]);
  const loading = query.isLoading || workspaces.isLoading;

  return (
    <div className="flex flex-col gap-5">
      {loading ? (
        <StatGridSkeleton count={4} />
      ) : (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard label="White-label tenants" value={fmtNum(stats.on)} hint={<span className="text-[11px] text-muted-foreground">of {fmtNum(tenants.length)} tenants</span>} />
          <StatCard label="Trader seats on white-label" value={fmtNum(stats.seats)} hint={<span className="text-[11px] text-muted-foreground">in {fmtNum(stats.brandedWorkspaces)} workspaces</span>} />
          <StatCard label="Custom domains" value={fmtNum(stats.domains)} hint={<span className="text-[11px] text-muted-foreground">CNAME to edge</span>} />
          <StatCard label="Applications asking for it" value={fmtNum(pendingRequests)} hint={<span className="text-[11px] text-muted-foreground">awaiting approval</span>} />
        </div>
      )}

      <Alert>
        <ShieldCheck />
        <AlertTitle>Only the super admin can turn white-label on</AlertTitle>
        <AlertDescription>
          Tenants can ask for white-label when they apply, but they cannot switch it on themselves. Granting it puts the tenant&apos;s name, colors and domain on the terminal their traders use and adds the {fmtMoney(WHITE_LABEL_FEE, { digits: 0 })}/mo platform fee. Their {COMMISSION_PCT}% commission stays the same either way.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Tenants</CardTitle>
          <CardDescription>Every tenant, with or without white-label. Grant it, edit the brand their traders see, or revoke it.</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <TableSkeleton rows={6} cols={8} />
          ) : query.isError ? (
            <EmptyState title="Tenants could not be loaded" description="The tenants service did not answer. Retry in a moment." action={<Button variant="outline" size="sm" onClick={() => query.refetch()}>Retry</Button>} />
          ) : tenants.length === 0 ? (
            <EmptyState title="No tenants yet" description="Approve an application on the Tenants page first. White-label is granted to an existing tenant." action={<Button size="sm" variant="outline" render={<Link href="/admin/tenants" />}>Open Tenants</Button>} />
          ) : (
            <DataTable columns={columns} data={tenants} searchPlaceholder="Search tenant, brand, domain…" pageSize={10} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Asking for white-label</CardTitle>
            <CardDescription>Applications that asked for white-label on top of commission. White-label can be granted once the tenant is approved on the Tenants page.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <ListSkeleton rows={2} />
            ) : requests.length === 0 ? (
              <EmptyState title="No requests" description="No open application is asking for white-label." />
            ) : (
              <ul className="divide-y divide-border">
                {requests.map((a) => {
                  // An approved application becomes a tenant added in this session; match it by contact email.
                  const tenant = decisions[a.id] === "approved" ? byId.get(addedTenants.find((t) => t.contact === a.contact)?.id ?? "") : undefined;
                  return (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="grid min-w-0 gap-0.5">
                        <span className="text-sm font-medium">{a.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {a.contact} · {a.audience} · {timeAgo(a.submittedAt, DEMO_NOW)}
                        </span>
                      </div>
                      {!decisions[a.id] ? (
                        <span className="flex items-center gap-2">
                          <ToneBadge tone="warn">Awaiting approval</ToneBadge>
                          <Button variant="outline" size="xs" render={<Link href="/admin/tenants" />}>
                            Review on Tenants
                          </Button>
                        </span>
                      ) : tenant?.whiteLabel ? (
                        <WhiteLabelBadge on />
                      ) : tenant ? (
                        <Button size="xs" onClick={() => openEditor(tenant.id, "grant")}>
                          Grant white-label
                        </Button>
                      ) : (
                        <ToneBadge tone="good">Approved</ToneBadge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What a grant changes</CardTitle>
            <CardDescription>For every trader whose workspace came through the tenant.</CardDescription>
          </CardHeader>
          <CardContent>
            <KV
              items={[
                { label: "Brand name", value: "Terminal header, sign-in page, emails" },
                { label: "Accent colors", value: "Buttons, links, focus rings, light and dark" },
                { label: "Custom domain", value: <span className="font-mono text-xs">CNAME to {EDGE_HOST}</span> },
                { label: "Platform fee", value: `${fmtMoney(WHITE_LABEL_FEE, { digits: 0 })} / mo plus per-seat` },
                { label: "Commission", value: `Unchanged, ${COMMISSION_PCT}%` },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      {editing && editor ? (
        <BrandingDialog
          key={`${editing.id}-${editor.session}`}
          tenant={editing}
          mode={editor.mode}
          takenDomains={takenDomains}
          subdomainHost={subdomainHost}
          open={editor.open}
          onOpenChange={(o) => setEditor((e) => (e ? { ...e, open: o } : e))}
        />
      ) : null}

      <RevokeDialog tenant={revoking} onClose={() => setRevokeId(null)} />
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  // The tenant's own brand color: the one place a user-chosen hex is rendered inline.
  return <span role="img" aria-label={`${label} ${color.toUpperCase()}`} className="size-4 shrink-0 rounded ring-1 ring-foreground/10" style={{ background: color }} />;
}

function BrandingDialog({
  tenant,
  mode,
  takenDomains,
  subdomainHost,
  open,
  onOpenChange,
}: {
  tenant: Tenant;
  mode: EditorMode;
  takenDomains: Set<string>;
  subdomainHost: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const setBranding = useConsoleStore((s) => s.setTenantBranding);
  const setWhiteLabel = useConsoleStore((s) => s.setTenantWhiteLabel);
  const base = tenant.branding;
  const defaults: FormInput = {
    name: base?.name ?? tenant.name,
    accent: (base?.accent ?? DEFAULT_BRANDING.accent).toUpperCase(),
    accentDark: (base?.accentDark ?? DEFAULT_BRANDING.accentDark).toUpperCase(),
    domain: base?.domain ?? "",
    supportEmail: base?.supportEmail ?? "",
  };
  const form = useForm<FormInput, unknown, FormValues>({ resolver: zodResolver(schema), defaultValues: defaults });
  const { errors, isSubmitting } = form.formState;
  const [name, accent, accentDark, domain] = useWatch({ control: form.control, name: ["name", "accent", "accentDark", "domain"] });
  const grant = mode === "grant";

  const preview: TenantBranding = {
    name: name?.trim() || tenant.name,
    accent: HEX.test(accent ?? "") ? accent : defaults.accent,
    accentDark: HEX.test(accentDark ?? "") ? accentDark : defaults.accentDark,
    domain: domain?.trim() || undefined,
  };

  async function onSubmit(v: FormValues) {
    if (v.domain && takenDomains.has(v.domain)) {
      form.setError("domain", { message: `${v.domain} already serves another tenant's traders.` });
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
    setBranding(tenant.id, {
      name: v.name,
      accent: v.accent.toUpperCase(),
      accentDark: v.accentDark.toUpperCase(),
      domain: v.domain || undefined,
      supportEmail: v.supportEmail || undefined,
    });
    if (grant) setWhiteLabel(tenant.id, true);
    toast.success(grant ? `White-label on for ${tenant.name}` : `Branding saved for ${tenant.name}`, {
      description: grant
        ? `Their traders now see ${v.name}${v.domain ? ` at ${v.domain}` : ""}. The ${fmtMoney(WHITE_LABEL_FEE, { digits: 0 })}/mo platform fee starts on the next invoice.`
        : "Their traders see the change on their next page load.",
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{grant ? `Grant white-label to ${tenant.name}` : `Edit ${tenant.name}'s branding`}</DialogTitle>
          <DialogDescription>
            {grant
              ? `Their traders see this brand instead of Nasscord's as soon as you save. Commission stays at ${tenant.commissionPct}%.`
              : "Changes reach their traders on the next page load."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-2">
          <form id="white-label-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid content-start gap-4">
            <FormField id="wl-name" label="Brand name" error={errors.name?.message}>
              <Input id="wl-name" placeholder={tenant.name} maxLength={40} aria-invalid={!!errors.name} {...form.register("name")} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField id="wl-accent" label="Light accent" error={errors.accent?.message} value={accent ?? ""} register={form.register("accent")} onPick={(v) => form.setValue("accent", v, { shouldDirty: true, shouldValidate: true })} />
              <ColorField id="wl-accent-dark" label="Dark accent" error={errors.accentDark?.message} value={accentDark ?? ""} register={form.register("accentDark")} onPick={(v) => form.setValue("accentDark", v, { shouldDirty: true, shouldValidate: true })} />
            </div>
            <FormField id="wl-domain" label="Custom domain" error={errors.domain?.message} help={`Optional. CNAME to ${EDGE_HOST}; the certificate issues once DNS resolves. Empty keeps traders on their ${PLATFORM_DOMAIN} subdomains.`}>
              <Input id="wl-domain" placeholder="trade.example.com" autoComplete="off" spellCheck={false} className="font-mono" aria-invalid={!!errors.domain} {...form.register("domain")} />
            </FormField>
            <FormField id="wl-support" label="Support email" error={errors.supportEmail?.message} help="Optional. Shown in the terminal footer and in emails to their traders.">
              <Input id="wl-support" type="email" placeholder={`help@${tenant.contact.split("@")[1] ?? "example.com"}`} autoComplete="off" aria-invalid={!!errors.supportEmail} {...form.register("supportEmail")} />
            </FormField>
          </form>
          <div className="grid content-start gap-1.5">
            <span className="text-xs text-muted-foreground">Preview. Follows the theme toggle: light accent in light mode, dark accent in dark mode.</span>
            <BrandPreview branding={preview} host={preview.domain ?? subdomainHost} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="white-label-form" disabled={isSubmitting}>
            {isSubmitting ? "Saving" : grant ? "Grant white-label" : "Save branding"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormField({ id, label, error, help, children }: { id: string; label: string; error?: string; help?: string; children: React.ReactNode }) {
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

/** Hex text input plus the native color picker, kept in sync. */
function ColorField({ id, label, error, value, register, onPick }: { id: string; label: string; error?: string; value: string; register: React.ComponentProps<typeof Input>; onPick: (v: string) => void }) {
  const valid = HEX.test(value);
  return (
    <FormField id={id} label={label} error={error}>
      <div className="flex items-center gap-2">
        <Input id={id} className="font-mono uppercase" maxLength={7} autoComplete="off" spellCheck={false} placeholder="#RRGGBB" aria-invalid={!!error} {...register} />
        <input
          type="color"
          aria-label={`Pick ${label.toLowerCase()}`}
          value={valid ? value.toLowerCase() : "#000000"}
          onChange={(e) => onPick(e.target.value.toUpperCase())}
          className="size-8 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
        />
      </div>
    </FormField>
  );
}

/** Mini terminal rendered through TenantTheme, so the accent flows through the real tokens. */
function BrandPreview({ branding, host }: { branding: TenantBranding; host: string }) {
  return (
    <TenantTheme branding={branding}>
      <div className="overflow-hidden rounded-lg bg-background ring-1 ring-foreground/10" aria-label={`Preview of ${branding.name}'s terminal`}>
        <div className="border-b bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{host}</div>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <LogoMark size={20} />
          <span className="truncate font-heading text-sm font-bold tracking-tight">{branding.name}</span>
          <span className="ml-0.5 border-l border-input pl-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Terminal</span>
          <Button size="xs" className="pointer-events-none ml-auto" tabIndex={-1} aria-hidden="true">
            Buy
          </Button>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-primary">Alerts</span>
          <span className="text-muted-foreground">Positions</span>
          <span className="text-muted-foreground">Orders</span>
        </div>
        <div className="grid gap-2 border-t px-3 py-3">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-xs">
            <span className="font-mono tabular">NVDA · 15m · Score 82</span>
            <span className="font-medium text-primary">View alert</span>
          </div>
          <Button size="sm" className="pointer-events-none w-full" tabIndex={-1} aria-hidden="true">
            Place verified order
          </Button>
        </div>
      </div>
    </TenantTheme>
  );
}

function RevokeDialog({ tenant, onClose }: { tenant: Tenant | undefined; onClose: () => void }) {
  const setWhiteLabel = useConsoleStore((s) => s.setTenantWhiteLabel);
  const domain = tenant ? whiteLabelBranding(tenant)?.domain : undefined;
  return (
    <Dialog open={!!tenant} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke white-label for {tenant?.name}?</DialogTitle>
          <DialogDescription>Their traders go back to the Nasscord brand. Their commission does not change.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1.5 text-xs text-muted-foreground">
          {domain ? <li>{domain} stops serving the terminal; traders sign in on their {PLATFORM_DOMAIN} subdomain.</li> : null}
          <li>The {fmtMoney(WHITE_LABEL_FEE, { digits: 0 })}/mo platform fee stops from the next invoice.</li>
          <li>Their branding is kept, so granting white-label again restores it.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (!tenant) return;
              setWhiteLabel(tenant.id, false);
              toast.success(`White-label revoked for ${tenant.name}`, { description: `Their traders see Nasscord on their next page load. Commission stays at ${tenant.commissionPct}%.` });
              onClose();
            }}
          >
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
