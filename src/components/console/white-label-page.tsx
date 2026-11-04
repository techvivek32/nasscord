"use client";

import * as React from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { LogoMark } from "@/components/brand/logo";
import { TenantTheme } from "@/components/tenant-theme";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setTenantWhiteLabel, updateTenantBranding } from "@/lib/server/console-actions";
import { brandingSchema, DEFAULT_BRANDING, whiteLabelBranding, type BrandingInput } from "@/lib/branding";
import { fmtNum } from "@/lib/format";
import type { Tenant, TenantBranding } from "@/lib/types";
import { TenantStatusBadge, WhiteLabelBadge } from "./badges";
import { attempt } from "./lib";

/* ------------------------------------------------------------------
   White-label: the super admin's switch for a tenant's brand. Granting
   saves the branding, then turns white-label on; the terminal of every
   workspace that came through the tenant shows that brand. Revoking puts
   Nasscord back and keeps the branding for a later grant.
   ------------------------------------------------------------------ */

const HEX = /^#[0-9a-fA-F]{6}$/;
type Output = ReturnType<typeof brandingSchema.parse>;
type EditorMode = "grant" | "edit";
const FIELDS = ["name", "accent", "accentDark", "domain", "supportEmail"] as const;

export function WhiteLabelPage({ tenants, appDomain, firstSlugByTenant }: { tenants: Tenant[]; appDomain: string; firstSlugByTenant: Record<string, string> }) {
  // `session` remounts the form on every open so its defaults come from the tenant as it is now.
  const [editor, setEditor] = React.useState<{ tenantId: string; mode: EditorMode; session: number } | null>(null);
  const [revokeId, setRevokeId] = React.useState<string | null>(null);
  const byId = React.useMemo(() => new Map(tenants.map((t) => [t.id, t])), [tenants]);
  const openEditor = React.useCallback((tenantId: string, mode: EditorMode) => setEditor((e) => ({ tenantId, mode, session: (e?.session ?? 0) + 1 })), []);

  const columns = React.useMemo<ColumnDef<Tenant>[]>(
    () => [
      {
        id: "name",
        accessorFn: (t) => `${t.name} ${t.contact ?? ""}`,
        header: "Tenant",
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">{row.original.contact ?? "No owner on file"}</span>
          </div>
        ),
      },
      { accessorKey: "status", header: "Status", cell: ({ row }) => <TenantStatusBadge status={row.original.status} /> },
      { id: "whiteLabel", accessorFn: (t) => (t.whiteLabel ? "on" : "off"), header: "White-label", cell: ({ row }) => <WhiteLabelBadge on={row.original.whiteLabel} compact /> },
      {
        id: "brand",
        accessorFn: (t) => t.branding?.name ?? "",
        header: "Brand",
        cell: ({ row }) => {
          const t = row.original;
          if (!t.branding) return <span className="text-xs text-muted-foreground">Not set</span>;
          return (
            <span className="flex items-center gap-2" title={`Light ${t.branding.accent.toUpperCase()}, dark ${t.branding.accentDark.toUpperCase()}`}>
              <Swatch color={t.branding.accent} label="Light accent" />
              <Swatch color={t.branding.accentDark} label="Dark accent" />
              <span className={t.whiteLabel ? "font-medium" : "text-muted-foreground"}>{t.branding.name}</span>
            </span>
          );
        },
      },
      {
        id: "domain",
        accessorFn: (t) => t.branding?.domain ?? "",
        header: "Domain",
        cell: ({ row }) =>
          row.original.branding?.domain ? <span className="font-mono text-xs">{row.original.branding.domain}</span> : <span className="text-xs text-muted-foreground">Subdomains of {appDomain}</span>,
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
    [openEditor, appDomain],
  );

  const editing = editor ? byId.get(editor.tenantId) : undefined;
  const revoking = revokeId ? byId.get(revokeId) : undefined;

  if (tenants.length === 0) {
    return (
      <EmptyState
        title="No tenants yet"
        description="White-label is granted to an existing tenant. Create one on the Tenants page first."
        action={
          <Button size="sm" variant="outline" render={<Link href="/admin/tenants" />}>
            Open Tenants
          </Button>
        }
      />
    );
  }

  return (
    <>
      <DataTable columns={columns} data={tenants} searchPlaceholder="Search tenant, brand, domain…" pageSize={10} />

      {editing && editor ? (
        <BrandingDialog
          key={`${editing.id}-${editor.session}`}
          tenant={editing}
          mode={editor.mode}
          fallbackHost={firstSlugByTenant[editing.id] ? `${firstSlugByTenant[editing.id]}.${appDomain}` : `your-trader.${appDomain}`}
          onClose={() => setEditor(null)}
        />
      ) : null}

      <RevokeDialog tenant={revoking} appDomain={appDomain} onClose={() => setRevokeId(null)} />
    </>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  // The tenant's own brand color: the one place a user-chosen hex is rendered inline.
  return <span role="img" aria-label={`${label} ${color.toUpperCase()}`} className="size-4 shrink-0 rounded ring-1 ring-foreground/10" style={{ background: color }} />;
}

function BrandingDialog({ tenant, mode, fallbackHost, onClose }: { tenant: Tenant; mode: EditorMode; fallbackHost: string; onClose: () => void }) {
  const [open, setOpen] = React.useState(true);
  const grant = mode === "grant";
  const base = tenant.branding;
  const form = useForm<BrandingInput, unknown, Output>({
    resolver: zodResolver(brandingSchema),
    defaultValues: {
      name: base?.name ?? tenant.name,
      accent: (base?.accent ?? DEFAULT_BRANDING.accent).toUpperCase(),
      accentDark: (base?.accentDark ?? DEFAULT_BRANDING.accentDark).toUpperCase(),
      domain: base?.domain ?? "",
      supportEmail: base?.supportEmail ?? "",
    },
  });
  const { errors, isSubmitting } = form.formState;
  const [name, accent, accentDark, domain] = useWatch({ control: form.control, name: ["name", "accent", "accentDark", "domain"] });

  const preview: TenantBranding = {
    name: name?.trim() || tenant.name,
    accent: HEX.test(accent ?? "") ? (accent as string) : DEFAULT_BRANDING.accent,
    accentDark: HEX.test(accentDark ?? "") ? (accentDark as string) : DEFAULT_BRANDING.accentDark,
  };
  const host = domain?.trim().toLowerCase() || fallbackHost;

  const close = () => {
    setOpen(false);
    onClose();
  };

  async function onSubmit(v: Output) {
    const branding: BrandingInput = { name: v.name, accent: v.accent.toUpperCase(), accentDark: v.accentDark.toUpperCase(), domain: v.domain ?? "", supportEmail: v.supportEmail ?? "" };
    const saved = await attempt(() => updateTenantBranding(tenant.id, branding));
    if (!saved.ok) {
      const field = FIELDS.find((f) => f === saved.field);
      if (field) form.setError(field, { message: saved.error });
      else toast.error(saved.error);
      return;
    }
    if (grant) {
      const on = await attempt(() => setTenantWhiteLabel(tenant.id, true));
      if (!on.ok) {
        toast.error(on.error, { description: "The branding was saved; white-label is still off." });
        return;
      }
    }
    toast.success(grant ? `White-label on for ${tenant.name}` : `Branding saved for ${tenant.name}`, {
      description: `Their traders see ${v.name} on their next page load.`,
    });
    close();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !isSubmitting && close()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{grant ? `Grant white-label to ${tenant.name}` : `Edit ${tenant.name}'s branding`}</DialogTitle>
          <DialogDescription>
            {grant ? `Saves this brand and turns white-label on. Commission stays at ${tenant.commissionPct}%.` : "Saved to the tenant. Their traders see it on their next page load."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-2">
          <form id="white-label-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid content-start gap-4">
            <FormField id="wl-name" label="Brand name" error={errors.name?.message}>
              <Input id="wl-name" placeholder={tenant.name} maxLength={60} aria-invalid={!!errors.name} {...form.register("name")} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <ColorField id="wl-accent" label="Light accent" error={errors.accent?.message} value={accent ?? ""} register={form.register("accent")} onPick={(v) => form.setValue("accent", v, { shouldDirty: true, shouldValidate: true })} />
              <ColorField id="wl-accent-dark" label="Dark accent" error={errors.accentDark?.message} value={accentDark ?? ""} register={form.register("accentDark")} onPick={(v) => form.setValue("accentDark", v, { shouldDirty: true, shouldValidate: true })} />
            </div>
            <FormField id="wl-domain" label="Custom domain" error={errors.domain?.message} help="Optional. The domain must point at this app and be added to the hosting project before traders can sign in there. Empty keeps them on their own subdomains.">
              <Input id="wl-domain" placeholder="trade.example.com" autoComplete="off" spellCheck={false} className="font-mono" aria-invalid={!!errors.domain} {...form.register("domain")} />
            </FormField>
            <FormField id="wl-support" label="Support email" error={errors.supportEmail?.message} help="Optional. Shown to their traders as the place to ask for help.">
              <Input id="wl-support" type="email" autoComplete="off" aria-invalid={!!errors.supportEmail} {...form.register("supportEmail")} />
            </FormField>
          </form>
          <div className="grid content-start gap-1.5">
            <span className="text-xs text-muted-foreground">Preview. Follows the theme toggle: light accent in light mode, dark accent in dark mode.</span>
            <BrandPreview branding={preview} host={host} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={isSubmitting} onClick={close}>
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

/** The terminal's header and navigation through TenantTheme, so the accent flows through the real tokens. No account data. */
function BrandPreview({ branding, host }: { branding: TenantBranding; host: string }) {
  return (
    <TenantTheme branding={branding}>
      <div className="overflow-hidden rounded-lg bg-background ring-1 ring-foreground/10" aria-label={`Preview of ${branding.name}'s terminal`}>
        <div className="border-b bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{host}</div>
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <LogoMark size={20} />
          <span className="truncate font-heading text-sm font-bold tracking-tight">{branding.name}</span>
          <span className="ml-0.5 border-l border-input pl-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Terminal</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-primary">Positions</span>
          <span className="text-muted-foreground">Orders</span>
          <span className="text-muted-foreground">Brokers</span>
        </div>
        <div className="grid gap-2 border-t px-3 py-3">
          <span className="text-xs font-medium text-primary">A link in the accent color</span>
          <Button size="sm" className="pointer-events-none w-full" tabIndex={-1} aria-hidden="true">
            Connect a broker
          </Button>
        </div>
      </div>
    </TenantTheme>
  );
}

function RevokeDialog({ tenant, appDomain, onClose }: { tenant: Tenant | undefined; appDomain: string; onClose: () => void }) {
  const [saving, startSaving] = React.useTransition();
  const domain = tenant ? whiteLabelBranding(tenant)?.domain : undefined;
  return (
    <Dialog open={!!tenant} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke white-label for {tenant?.name}?</DialogTitle>
          <DialogDescription>Their traders go back to the Nasscord brand. Their commission does not change.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1.5 text-xs text-muted-foreground">
          {domain ? <li>{domain} stops serving their brand; traders sign in on their {appDomain} subdomains.</li> : null}
          <li>The branding is kept, so granting white-label again restores it.</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={saving}
            onClick={() => {
              if (!tenant) return;
              startSaving(async () => {
                const r = await attempt(() => setTenantWhiteLabel(tenant.id, false));
                if (!r.ok) {
                  toast.error(r.error);
                  return;
                }
                toast.success(`White-label revoked for ${tenant.name}`);
                onClose();
              });
            }}
          >
            {saving ? "Revoking" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
