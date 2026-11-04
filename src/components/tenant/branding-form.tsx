"use client";

import * as React from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TenantTheme } from "@/components/tenant-theme";
import { Logo } from "@/components/brand/logo";
import { updateMyTenantBranding } from "@/lib/server/tenant-actions";
import { brandingSchema, DEFAULT_BRANDING, type BrandingInput } from "@/lib/branding";
import type { TenantBranding } from "@/lib/types";
import { Field } from "./primitives";

const HEX = /^#[0-9a-fA-F]{6}$/;
type Output = ReturnType<typeof brandingSchema.parse>;
const FIELDS = ["name", "accent", "accentDark", "domain", "supportEmail"] as const;

/**
 * The tenant's white-label branding, saved to the tenant through updateMyTenantBranding. Only rendered
 * when white-label is on. `tenantId` lets the super admin save for the tenant they belong to.
 */
export function BrandingForm({ tenantId, tenantName, branding, appDomain }: { tenantId: string; tenantName: string; branding: TenantBranding | null; appDomain: string }) {
  const defaults: BrandingInput = {
    name: branding?.name ?? tenantName,
    accent: (branding?.accent ?? DEFAULT_BRANDING.accent).toUpperCase(),
    accentDark: (branding?.accentDark ?? DEFAULT_BRANDING.accentDark).toUpperCase(),
    domain: branding?.domain ?? "",
    supportEmail: branding?.supportEmail ?? "",
  };
  const form = useForm<BrandingInput, unknown, Output>({ resolver: zodResolver(brandingSchema), defaultValues: defaults, mode: "onTouched" });
  const { errors, isSubmitting, isDirty } = form.formState;
  const [name, accent, accentDark, domain, supportEmail] = useWatch({ control: form.control, name: ["name", "accent", "accentDark", "domain", "supportEmail"] });

  const preview: TenantBranding = {
    name: name?.trim() || tenantName,
    accent: HEX.test(accent ?? "") ? (accent as string) : DEFAULT_BRANDING.accent,
    accentDark: HEX.test(accentDark ?? "") ? (accentDark as string) : DEFAULT_BRANDING.accentDark,
  };

  async function onSubmit(v: Output) {
    const next: BrandingInput = { name: v.name, accent: v.accent.toUpperCase(), accentDark: v.accentDark.toUpperCase(), domain: v.domain ?? "", supportEmail: v.supportEmail ?? "" };
    let r: Awaited<ReturnType<typeof updateMyTenantBranding>>;
    try {
      r = await updateMyTenantBranding(next, tenantId);
    } catch {
      r = { ok: false, error: "The server did not answer. Check your connection and try again." };
    }
    if (!r.ok) {
      const field = FIELDS.find((f) => f === r.field);
      if (field) form.setError(field, { message: r.error });
      else toast.error(r.error);
      return;
    }
    form.reset(next);
    toast.success("Branding saved", { description: "Your traders see it on their next page load." });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Brand</CardTitle>
          <CardDescription>What your traders see on the terminal instead of Nasscord.</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="branding-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:grid-cols-2">
            <Field id="brand-name" label="Brand name" error={errors.name?.message} className="sm:col-span-2">
              <Input id="brand-name" autoComplete="organization" maxLength={60} aria-invalid={!!errors.name} {...form.register("name")} />
            </Field>
            <ColorField id="brand-accent" label="Accent (light theme)" error={errors.accent?.message} value={accent ?? ""} register={form.register("accent")} onPick={(v) => form.setValue("accent", v, { shouldDirty: true, shouldValidate: true })} />
            <ColorField id="brand-accent-dark" label="Accent (dark theme)" error={errors.accentDark?.message} value={accentDark ?? ""} register={form.register("accentDark")} onPick={(v) => form.setValue("accentDark", v, { shouldDirty: true, shouldValidate: true })} />
            <Field id="brand-domain" label="Custom domain" hint="Optional. Your traders reach the terminal there once the domain points at Nasscord; ask Nasscord's super admin to connect it." error={errors.domain?.message}>
              <Input id="brand-domain" className="font-mono" placeholder="trade.yourbrand.com" autoComplete="off" spellCheck={false} aria-invalid={!!errors.domain} {...form.register("domain")} />
            </Field>
            <Field id="brand-support" label="Support email" hint="Optional. Where your traders ask for help." error={errors.supportEmail?.message}>
              <Input id="brand-support" type="email" autoComplete="off" aria-invalid={!!errors.supportEmail} {...form.register("supportEmail")} />
            </Field>
          </form>
        </CardContent>
        <div className="flex flex-wrap items-center gap-2 border-t px-4 pt-4">
          <Button type="submit" form="branding-form" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? "Saving" : "Save branding"}
          </Button>
          <Button type="button" variant="ghost" disabled={!isDirty || isSubmitting} onClick={() => form.reset()}>
            Discard changes
          </Button>
          {!isDirty ? <span className="text-xs text-muted-foreground">No unsaved changes</span> : null}
        </div>
      </Card>

      <div className="lg:col-span-2">
        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>Updates as you type. Follows the theme toggle in the header.</CardDescription>
          </CardHeader>
          <CardContent>
            <TerminalPreview branding={preview} host={domain?.trim().toLowerCase() || `your-trader.${appDomain}`} supportEmail={supportEmail?.trim() ?? ""} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ColorField({ id, label, error, value, register, onPick }: { id: string; label: string; error?: string; value: string; register: React.ComponentProps<typeof Input>; onPick: (v: string) => void }) {
  const valid = HEX.test(value);
  return (
    <Field id={id} label={label} error={error}>
      <div className="flex items-center gap-2">
        <Input id={id} className="font-mono uppercase" maxLength={7} autoComplete="off" spellCheck={false} aria-invalid={!!error} {...register} />
        <input
          type="color"
          aria-label={`Pick ${label.toLowerCase()}`}
          value={valid ? value.toLowerCase() : "#000000"}
          onChange={(e) => onPick(e.target.value.toUpperCase())}
          className="size-8 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
        />
      </div>
    </Field>
  );
}

/** The terminal's header and navigation in the brand, through the real tokens. No account data. */
function TerminalPreview({ branding, host, supportEmail }: { branding: TenantBranding; host: string; supportEmail: string }) {
  return (
    <TenantTheme branding={branding}>
      <div className="overflow-hidden rounded-xl border border-border bg-background" aria-label="Terminal preview">
        <div className="border-b bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{host}</div>
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <Logo name={branding.name} sub="Terminal" href="/tenant/branding" size={24} className="text-base" />
        </div>
        <div className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-primary">Positions</span>
          <span className="text-muted-foreground">Orders</span>
          <span className="text-muted-foreground">Brokers</span>
        </div>
        <div className="grid gap-2 border-t p-3">
          <span className="text-xs font-medium text-primary">A link in your accent color</span>
          <Button size="sm" className="pointer-events-none w-full" tabIndex={-1} aria-hidden="true">
            Connect a broker
          </Button>
          <p className="truncate text-[11px] text-muted-foreground">Support: {supportEmail || "not set"}</p>
        </div>
      </div>
    </TenantTheme>
  );
}
