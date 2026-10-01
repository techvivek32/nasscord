"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LogoMark } from "@/components/brand/logo";
import { TenantTheme } from "@/components/tenant-theme";
import { fmtDate, fmtMoney } from "@/lib/format";
import { getPlan, PLANS, PLAN_LABEL } from "@/lib/plans";
import type { PlanId, Tenant, TenantFeatures } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ControlRow, KV, SectionTitle } from "./primitives";
import { PlanBadge, TenantStatusBadge } from "./badges";
import { useConsoleStore } from "./store";
import { tenantHost } from "./lib";

const PLAN_ITEMS = PLANS.map((p) => ({ value: p.id, label: p.name }));

const FEATURE_ROWS: Array<{ key: keyof TenantFeatures; label: string; help: string }> = [
  { key: "tradescope", label: "TradeScope alerts", help: "15m scan across the 44-symbol universe, min score 70." },
  { key: "options", label: "Options desk", help: "Option chains, capital-risk sizing and multi-leg tickets." },
  { key: "extendedHours", label: "Extended hours", help: "Orders outside 09:30–16:00 ET where the broker allows it." },
  { key: "paperDefault", label: "Paper mode default", help: "New seats start in paper mode until they switch." },
];

/** Next invoice lands on the signup day-of-month in the coming month. */
function nextInvoiceDate(t: Tenant) {
  const day = new Date(t.createdAt).getUTCDate();
  return fmtDate(new Date(Date.UTC(2026, 9, Math.min(day, 28))).toISOString());
}

export function TenantFacts({ tenant, partnerName }: { tenant: Tenant; partnerName?: string }) {
  return (
    <KV
      items={[
        { label: "MRR", value: fmtMoney(tenant.mrr, { digits: 0 }) },
        { label: "Seats", value: `${tenant.seats} / ${tenant.seatLimit}` },
        { label: "Created", value: fmtDate(tenant.createdAt) },
        { label: "Partner", value: partnerName ?? (tenant.partnerId ? <span className="font-mono text-xs">{tenant.partnerId}</span> : <span className="text-muted-foreground">Direct</span>) },
        { label: "Timezone", value: tenant.timezone.replace("America/", "").replace("_", " ") },
        { label: "Host", value: <span className="font-mono text-xs">{tenantHost(tenant.slug, tenant.branding?.domain)}</span> },
      ]}
    />
  );
}

export function WhiteLabelSection({ tenant, idPrefix }: { tenant: Tenant; idPrefix: string }) {
  const setWL = useConsoleStore((s) => s.setTenantWhiteLabel);
  const wl = useConsoleStore((s) => s.tenantWhiteLabel[tenant.id]);
  const enabled = tenant.whiteLabel;
  const brandName = wl?.brandName ?? tenant.branding?.name ?? "";
  const domain = wl?.domain ?? tenant.branding?.domain ?? "";
  const accent = wl?.accent ?? tenant.branding?.accent ?? "";
  const validAccent = /^#[0-9a-fA-F]{6}$/.test(accent);

  return (
    <section className="grid gap-2">
      <SectionTitle>White-label</SectionTitle>
      <div className="divide-y divide-border">
        <ControlRow id={`${idPrefix}-wl`} label="White-label enabled" help="Custom brand, domain and email sender for this workspace.">
          <Switch
            id={`${idPrefix}-wl`}
            checked={enabled}
            onCheckedChange={(on) => {
              setWL(tenant.id, { enabled: on });
              toast.success(on ? `White-label on for ${tenant.name}` : `White-label off for ${tenant.name}`);
            }}
          />
        </ControlRow>
        <div className={cn("grid gap-3 py-3", !enabled && "opacity-60")}>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-brand`}>Brand name</Label>
            <Input id={`${idPrefix}-brand`} value={brandName} disabled={!enabled} placeholder={tenant.name} onChange={(e) => setWL(tenant.id, { brandName: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-domain`}>Custom domain</Label>
            <Input id={`${idPrefix}-domain`} value={domain} disabled={!enabled} placeholder={`trade.${tenant.slug}.com`} className="font-mono" onChange={(e) => setWL(tenant.id, { domain: e.target.value.trim() })} />
            <p className="text-xs text-muted-foreground">CNAME to edge.nasscord.com. Certificates issue automatically once DNS resolves.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-accent`}>Accent color</Label>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="size-8 shrink-0 rounded-lg ring-1 ring-foreground/10" style={validAccent ? { background: accent } : undefined} />
              <Input id={`${idPrefix}-accent`} value={accent} disabled={!enabled} placeholder="#RRGGBB" className="font-mono uppercase" maxLength={7} aria-invalid={enabled && accent.length > 0 && !validAccent} onChange={(e) => setWL(tenant.id, { accent: e.target.value.trim() })} />
            </div>
          </div>
          <AccentPreview name={brandName || tenant.name} accent={validAccent ? accent : undefined} />
        </div>
      </div>
    </section>
  );
}

/** Mini terminal header rendered through TenantTheme so the accent flows through the real tokens. */
function AccentPreview({ name, accent }: { name: string; accent?: string }) {
  const inner = (
    <div className="rounded-lg bg-background ring-1 ring-foreground/10">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <LogoMark size={20} />
        <span className="font-heading text-sm font-bold tracking-tight">{name}</span>
        <span className="ml-0.5 border-l border-input pl-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Terminal</span>
        <Button size="xs" className="ml-auto pointer-events-none" tabIndex={-1} aria-hidden="true">
          Buy
        </Button>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        <span className="rounded-md bg-brand-soft px-1.5 py-0.5 font-medium text-primary">Alerts</span>
        <span className="text-muted-foreground">Positions</span>
        <span className="text-muted-foreground">Orders</span>
      </div>
    </div>
  );
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-muted-foreground">Preview</span>
      {accent ? <TenantTheme branding={{ name, accent, accentDark: accent }}>{inner}</TenantTheme> : inner}
    </div>
  );
}

export function LimitsSection({ tenant, idPrefix }: { tenant: Tenant; idPrefix: string }) {
  const setLimits = useConsoleStore((s) => s.setTenantLimits);
  const plan = getPlan(tenant.plan);
  const brokerLimit = plan.limits.brokers === "unlimited" ? "Unlimited" : String(plan.limits.brokers);
  return (
    <section className="grid gap-2">
      <SectionTitle hint={<PlanBadge plan={tenant.plan} />}>Limits</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-seats`}>Seat limit</Label>
          <Input
            id={`${idPrefix}-seats`}
            type="number"
            inputMode="numeric"
            min={tenant.seats}
            className="font-mono tabular"
            value={tenant.seatLimit}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) setLimits(tenant.id, { seatLimit: n });
            }}
          />
          <p className="text-xs text-muted-foreground">{tenant.seats} in use. Plan default: {plan.limits.seats === "unlimited" ? "unlimited" : plan.limits.seats}.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-brokers`}>Broker connections</Label>
          <Input id={`${idPrefix}-brokers`} value={brokerLimit} readOnly className="font-mono tabular" />
          <p className="text-xs text-muted-foreground">{tenant.brokers.length} connected. Set by the plan.</p>
        </div>
      </div>
    </section>
  );
}

export function FeatureFlagsSection({ tenant, idPrefix }: { tenant: Tenant; idPrefix: string }) {
  const setFeature = useConsoleStore((s) => s.setTenantFeature);
  return (
    <section className="grid gap-2">
      <SectionTitle>Feature flags</SectionTitle>
      <div className="divide-y divide-border">
        {FEATURE_ROWS.map((row) => {
          const id = `${idPrefix}-flag-${row.key}`;
          return (
            <ControlRow key={row.key} id={id} label={row.label} help={row.help}>
              <Switch
                id={id}
                checked={tenant.features[row.key]}
                aria-describedby={`${id}-help`}
                onCheckedChange={(on) => {
                  setFeature(tenant.id, row.key, on);
                  toast.success(`${row.label} ${on ? "enabled" : "disabled"} for ${tenant.name}`);
                }}
              />
            </ControlRow>
          );
        })}
      </div>
    </section>
  );
}

export function BillingSection({ tenant, idPrefix }: { tenant: Tenant; idPrefix: string }) {
  const setPlan = useConsoleStore((s) => s.setTenantPlan);
  const plan = getPlan(tenant.plan);
  return (
    <section className="grid gap-2">
      <SectionTitle>Billing</SectionTitle>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-plan`}>Plan</Label>
          <Select
            items={PLAN_ITEMS}
            value={tenant.plan}
            onValueChange={(v) => {
              if (!v) return;
              setPlan(tenant.id, v as PlanId);
              toast.success(`${tenant.name} moved to ${PLAN_LABEL[v as PlanId]}`, { description: "Proration applies on the next invoice." });
            }}
          >
            <SelectTrigger id={`${idPrefix}-plan`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_ITEMS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <KV
          items={[
            { label: "List price", value: plan.monthly === null ? "Custom" : plan.monthly === 0 ? "Free" : `${fmtMoney(plan.monthly, { digits: 0 })} / mo` },
            { label: "Current MRR", value: fmtMoney(tenant.mrr, { digits: 0 }) },
            { label: "Next invoice", value: tenant.status === "suspended" ? <span className="text-muted-foreground">Paused</span> : nextInvoiceDate(tenant) },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => toast.success(`Invoice sent to ${tenant.owner.email}`, { description: `${fmtMoney(tenant.mrr, { digits: 0 })} due in 14 days.` })}>
            Send invoice
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast("Opened in Stripe", { description: `Customer ${tenant.id.replace("t_", "cus_")}` })}>
            Open in Stripe
          </Button>
        </div>
      </div>
    </section>
  );
}

export function DangerSection({ tenant }: { tenant: Tenant }) {
  const setStatus = useConsoleStore((s) => s.setTenantStatus);
  const [confirm, setConfirm] = React.useState(false);
  const suspended = tenant.status === "suspended";

  return (
    <section className="grid gap-2">
      <SectionTitle hint={<TenantStatusBadge status={tenant.status} />}>Danger zone</SectionTitle>
      <div className="grid gap-2 rounded-xl border border-dashed border-input p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-0.5">
            <p className="text-sm font-medium">Impersonate owner</p>
            <p className="text-xs text-muted-foreground">Read-only session as {tenant.owner.name}. Logged to the audit trail.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => toast(`Impersonation session started`, { description: `${tenant.owner.email} · read-only · expires in 30 min` })}>
            Impersonate
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <div className="grid gap-0.5">
            <p className="text-sm font-medium">{suspended ? "Reactivate workspace" : "Suspend workspace"}</p>
            <p className="text-xs text-muted-foreground">{suspended ? "Restores logins and resumes billing." : "Blocks every login and pauses billing. Broker tokens stay stored."}</p>
          </div>
          <Button variant={suspended ? "default" : "destructive"} size="sm" onClick={() => setConfirm(true)}>
            {suspended ? "Reactivate" : "Suspend"}
          </Button>
        </div>
      </div>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{suspended ? `Reactivate ${tenant.name}?` : `Suspend ${tenant.name}?`}</DialogTitle>
            <DialogDescription>
              {suspended
                ? `${tenant.seats} seat${tenant.seats === 1 ? "" : "s"} regain access immediately and the next invoice resumes on schedule.`
                : `${tenant.seats} seat${tenant.seats === 1 ? "" : "s"} lose access at once. Working orders at the brokers are not cancelled. The owner receives an email.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant={suspended ? "default" : "destructive"}
              onClick={() => {
                setStatus(tenant.id, suspended ? "active" : "suspended");
                setConfirm(false);
                toast.success(suspended ? `${tenant.name} reactivated` : `${tenant.name} suspended`);
              }}
            >
              {suspended ? "Reactivate" : "Suspend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** All editable sections in order. `columns` lays them out two-up on wide detail pages. */
export function TenantSections({ tenant, idPrefix, columns = false }: { tenant: Tenant; idPrefix: string; columns?: boolean }) {
  return (
    <div className={cn("grid gap-6", columns && "lg:grid-cols-2")}>
      <WhiteLabelSection tenant={tenant} idPrefix={idPrefix} />
      <div className="grid gap-6">
        <LimitsSection tenant={tenant} idPrefix={idPrefix} />
        <FeatureFlagsSection tenant={tenant} idPrefix={idPrefix} />
      </div>
      <BillingSection tenant={tenant} idPrefix={idPrefix} />
      <DangerSection tenant={tenant} />
    </div>
  );
}
