"use client";

import * as React from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check, Copy, Globe, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatCard } from "@/components/stat-card";
import { TenantTheme } from "@/components/tenant-theme";
import { Logo } from "@/components/brand/logo";
import type { TenantBranding } from "@/lib/types";
import { cn } from "@/lib/utils";
import { copyText } from "./clipboard";
import { useCurrentTenant } from "./current";
import { ErrorState, Field, FormSkeleton, ToneBadge } from "./primitives";
import { useTenantStore, type SavedBranding } from "./store";
import { WhiteLabelGate } from "./white-label-gate";

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = z.string().trim().regex(HEX, "Use a 6-digit hex color like #1A2B3C.");

const schema = z.object({
  name: z.string().trim().min(2, "Enter your brand name.").max(40, "Keep it under 40 characters."),
  accent: hex,
  accentDark: hex,
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, "Enter a hostname like trade.yourbrand.com."),
  supportEmail: z.email("Enter a valid support email."),
  logoText: z.string().trim().min(1, "1 to 4 characters.").max(4, "1 to 4 characters.").toUpperCase(),
});
type Input = z.input<typeof schema>;
type Values = z.output<typeof schema>;

const EDGE_HOST = "edge.nasscord.com";
const VERIFY_TOKEN = "nasscord-verify=7f3a9c2e1b4d";

/**
 * The current tenant's white-label branding. `fallback` is Nasscord's own (lib/tenant DEFAULT_BRANDING),
 * passed from the server page, for a tenant that has not set a color yet.
 */
export function BrandingPage({ fallback }: { fallback: TenantBranding }) {
  const { tenant, isLoading, isError } = useCurrentTenant();
  const saved = useTenantStore((s) => s.branding);

  if (isError) return <ErrorState />;
  if (isLoading || !tenant) {
    return (
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Brand</CardTitle>
          </CardHeader>
          <CardContent>
            <FormSkeleton fields={6} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Live preview</CardTitle>
          </CardHeader>
          <CardContent>
            <FormSkeleton fields={3} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!tenant.whiteLabel) {
    return (
      <WhiteLabelGate
        title="Branding needs white-label"
        description="Your referral link already carries your code. Your own name, accent color, domain and branded emails are part of white-label."
      />
    );
  }

  const own = tenant.branding;
  const defaults: SavedBranding = saved ?? {
    name: own?.name ?? tenant.name,
    accent: own?.accent ?? fallback.accent,
    accentDark: own?.accentDark ?? fallback.accentDark,
    domain: own?.domain ?? "",
    supportEmail: own?.supportEmail ?? tenant.contact,
    logoText: initialsOf(own?.name ?? tenant.name),
  };

  return <BrandingForm key={tenant.id} defaults={defaults} />;
}

function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function BrandingForm({ defaults }: { defaults: SavedBranding }) {
  const saveBranding = useTenantStore((s) => s.saveBranding);
  const ids = { name: React.useId(), accent: React.useId(), accentDark: React.useId(), domain: React.useId(), support: React.useId(), logo: React.useId() };

  const form = useForm<Input, unknown, Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: defaults.name, accent: defaults.accent, accentDark: defaults.accentDark, domain: defaults.domain ?? "", supportEmail: defaults.supportEmail ?? "", logoText: defaults.logoText },
    mode: "onTouched",
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  const live = useWatch({ control: form.control });

  const preview: SavedBranding = {
    name: (live.name ?? "").trim() || defaults.name,
    accent: HEX.test(live.accent ?? "") ? (live.accent as string) : defaults.accent,
    accentDark: HEX.test(live.accentDark ?? "") ? (live.accentDark as string) : defaults.accentDark,
    domain: (live.domain ?? "").trim().toLowerCase(),
    supportEmail: (live.supportEmail ?? "").trim(),
    logoText: ((live.logoText ?? "").trim() || defaults.logoText).toUpperCase().slice(0, 4),
  };

  async function onSubmit(v: Values) {
    await new Promise((r) => setTimeout(r, 500));
    saveBranding({ ...v, accent: v.accent.toUpperCase(), accentDark: v.accentDark.toUpperCase() });
    form.reset({ ...v });
    toast.success("Branding saved for this session", { description: "The demo keeps it until you reload. Your traders' terminal still shows the brand on file." });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="grid gap-4 lg:col-span-3">
        <Card>
          <CardHeader>
            <CardTitle>Brand</CardTitle>
            <CardDescription>Applied to the terminal, sign-in page, alert emails and the mobile app icon for your traders.</CardDescription>
          </CardHeader>
          <CardContent>
            <form id="branding-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:grid-cols-2">
              <Field id={ids.name} label="Brand name" error={errors.name?.message} className="sm:col-span-2">
                <Input id={ids.name} autoComplete="organization" aria-invalid={!!errors.name} {...form.register("name")} />
              </Field>
              <ColorField id={ids.accent} label="Accent (light theme)" error={errors.accent?.message} value={live.accent ?? ""} register={form.register("accent")} onPick={(v) => form.setValue("accent", v, { shouldDirty: true, shouldValidate: true })} />
              <ColorField
                id={ids.accentDark}
                label="Accent (dark theme)"
                error={errors.accentDark?.message}
                value={live.accentDark ?? ""}
                register={form.register("accentDark")}
                onPick={(v) => form.setValue("accentDark", v, { shouldDirty: true, shouldValidate: true })}
              />
              <Field id={ids.domain} label="Custom domain" hint="Where your traders sign in. Point it at Nasscord below." error={errors.domain?.message}>
                <Input id={ids.domain} className="font-mono" placeholder="trade.yourbrand.com" autoComplete="off" spellCheck={false} aria-invalid={!!errors.domain} {...form.register("domain")} />
              </Field>
              <Field id={ids.support} label="Support email" hint="Shown in the terminal footer and every alert email." error={errors.supportEmail?.message}>
                <Input id={ids.support} type="email" autoComplete="off" aria-invalid={!!errors.supportEmail} {...form.register("supportEmail")} />
              </Field>
              <Field id={ids.logo} label="Logo text" hint="Up to 4 characters for the app icon and email header until you upload an SVG." error={errors.logoText?.message}>
                <Input id={ids.logo} className="w-28 font-mono uppercase" maxLength={4} autoComplete="off" aria-invalid={!!errors.logoText} {...form.register("logoText")} />
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

        <DnsCard domain={preview.domain ?? ""} />
      </div>

      <div className="lg:col-span-2">
        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>Live preview</CardTitle>
            <CardDescription>Updates as you type. Follows the theme toggle in the header.</CardDescription>
          </CardHeader>
          <CardContent>
            <TerminalPreview branding={preview} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ColorField({
  id,
  label,
  error,
  value,
  register,
  onPick,
}: {
  id: string;
  label: string;
  error?: string;
  value: string;
  register: React.ComponentProps<typeof Input>;
  onPick: (v: string) => void;
}) {
  const valid = HEX.test(value);
  return (
    <Field id={id} label={label} error={error}>
      <div className="flex items-center gap-2">
        <Input id={id} className="font-mono uppercase" maxLength={7} autoComplete="off" spellCheck={false} aria-invalid={!!error} {...register} />
        <input
          type="color"
          aria-label={`Pick ${label.toLowerCase()}`}
          value={valid ? value : "#000000"}
          onChange={(e) => onPick(e.target.value.toUpperCase())}
          className="size-8 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
        />
      </div>
    </Field>
  );
}

function TerminalPreview({ branding }: { branding: SavedBranding }) {
  const tenantBranding: TenantBranding = { name: branding.name, accent: branding.accent, accentDark: branding.accentDark, domain: branding.domain, supportEmail: branding.supportEmail };
  return (
    <TenantTheme branding={tenantBranding}>
      <div className="overflow-hidden rounded-xl border border-border bg-background" aria-label="Terminal preview">
        <div className="flex items-center justify-between gap-2 border-b bg-background/90 px-3 py-2">
          <Logo name={branding.name} sub="Terminal" href="/tenant/branding" size={24} className="text-base" />
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-brand-soft text-primary">
              Paper
            </Badge>
            <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-primary font-heading text-[10px] font-bold text-primary-foreground">
              {branding.logoText}
            </span>
          </div>
        </div>
        <div className="grid gap-3 p-3">
          <StatCard label="Net liquidation" value="$248,910.22" delta={1.24} deltaLabel="% today" spark={[100, 101, 100.4, 101.8, 102.2, 101.9, 102.6, 103.1]} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Place verified order</Button>
            <Badge variant="outline" className="font-mono">
              NVDA · 15m · Score 82
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-xs">
            <span className="text-muted-foreground">Stop 2.2 x ATR, target at 0.72 R</span>
            <span className="font-medium text-primary">View alert</span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">
            Support: {branding.supportEmail || "not set"}
            {branding.domain ? ` · ${branding.domain}` : ""}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
        <Swatch hex={branding.accent} label="Light" />
        <Swatch hex={branding.accentDark} label="Dark" />
      </div>
    </TenantTheme>
  );
}

function Swatch({ hex, label }: { hex: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-3.5 rounded-sm border border-border" style={{ background: hex }} />
      {label} <span className="font-mono">{hex.toUpperCase()}</span>
    </span>
  );
}

function DnsCard({ domain }: { domain: string }) {
  const verified = useTenantStore((s) => s.verifiedDomains);
  const markDomainVerified = useTenantStore((s) => s.markDomainVerified);
  const [verifying, setVerifying] = React.useState(false);
  const isValid = domain.length > 3 && domain.includes(".");
  const isVerified = isValid && verified.includes(domain);
  const host = domain || "trade.yourbrand.com";

  async function onVerify() {
    if (!isValid) {
      toast.error("Enter a custom domain first");
      return;
    }
    if (isVerified) {
      toast.info(`${domain} is already verified`, { description: "TLS certificate is active and renews automatically." });
      return;
    }
    setVerifying(true);
    await new Promise((r) => setTimeout(r, 1200));
    setVerifying(false);
    markDomainVerified(domain);
    toast.success(`DNS verified for ${domain}`, { description: "Certificate is issuing. The domain usually answers within 10 minutes." });
  }

  const rows = [
    { type: "CNAME", host, value: EDGE_HOST, note: "Routes the domain to Nasscord's edge." },
    { type: "TXT", host: `_nasscord.${host}`, value: VERIFY_TOKEN, note: "Proves you control the domain." },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>DNS</CardTitle>
        <CardDescription>Add both records at your DNS provider, then verify. Changes can take up to an hour to propagate.</CardDescription>
        <CardAction>
          {isVerified ? (
            <ToneBadge tone="good">
              <ShieldCheck /> Verified
            </ToneBadge>
          ) : (
            <ToneBadge tone="warn">
              <Globe /> Pending
            </ToneBadge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">Type</TableHead>
                <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">Host</TableHead>
                <TableHead className="text-xs tracking-wide text-muted-foreground uppercase">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.type}>
                  <TableCell className="font-mono text-xs font-medium">{r.type}</TableCell>
                  <TableCell className="font-mono text-xs">{r.host}</TableCell>
                  <TableCell>
                    <CopyValue value={r.value} label={`${r.type} value`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={isVerified ? "outline" : "default"} size="sm" onClick={onVerify} disabled={verifying}>
            {verifying ? "Checking records" : isVerified ? "Re-check" : "Verify"}
          </Button>
          <span className="text-xs text-muted-foreground">Wildcard certificates are not needed; Nasscord issues one per verified host.</span>
        </div>
      </CardContent>
    </Card>
  );
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <span className="inline-flex items-center gap-1.5">
      <code className="font-mono text-xs">{value}</code>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          const ok = await copyText(value);
          if (ok) {
            setCopied(true);
            toast.success(`${label} copied`);
            window.setTimeout(() => setCopied(false), 1500);
          } else toast.error("Could not copy automatically", { description: value });
        }}
      >
        {copied ? <Check className={cn("text-gain-foreground")} /> : <Copy />}
      </Button>
    </span>
  );
}
