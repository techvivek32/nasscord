"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fmtDate, fmtMoney } from "@/lib/format";
import { getPlan, PLANS, PLAN_LABEL } from "@/lib/plans";
import { whiteLabelBranding } from "@/lib/branding";
import type { PlanId, Tenant, Workspace, WorkspaceFeatures } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ControlRow, KV, SectionTitle } from "./primitives";
import { PlanBadge, WhiteLabelBadge, WorkspaceStatusBadge } from "./badges";
import { useConsoleStore } from "./store";
import { workspaceHostFor } from "./lib";

const PLAN_ITEMS = PLANS.map((p) => ({ value: p.id, label: p.name }));

const FEATURE_ROWS: Array<{ key: keyof WorkspaceFeatures; label: string; help: string }> = [
  { key: "tradescope", label: "TradeScope alerts", help: "15m scan across the 44-symbol universe, min score 70." },
  { key: "options", label: "Options desk", help: "Option chains, capital-risk sizing and multi-leg tickets." },
  { key: "extendedHours", label: "Extended hours", help: "Orders outside 09:30–16:00 ET where the broker allows it." },
  { key: "paperDefault", label: "Paper mode default", help: "New seats start in paper mode until they switch." },
];

/** Next invoice lands on the signup day-of-month in the coming month. */
function nextInvoiceDate(w: Workspace) {
  const day = new Date(w.createdAt).getUTCDate();
  return fmtDate(new Date(Date.UTC(2026, 9, Math.min(day, 28))).toISOString());
}

/** Who brought this trader: the tenant (linked to the Tenants page) or nobody. */
export function TenantSource({ workspace, tenant }: { workspace: Workspace; tenant: Tenant | null | undefined }) {
  if (!workspace.tenantId) return <span className="text-muted-foreground">Organic: signed up directly</span>;
  if (!tenant) return <span className="font-mono text-xs">{workspace.tenantId}</span>;
  return (
    <span>
      <span className="font-normal text-muted-foreground">Came through </span>
      <Link href="/admin/tenants" className="underline-offset-4 hover:underline">
        {tenant.name}
      </Link>
    </span>
  );
}

/**
 * Key facts for a trader's workspace. `tenant` is the tenant it came through as the console sees it
 * now (white-label grants included), so the host and brand follow the White-label page.
 */
export function TraderFacts({ workspace, tenant }: { workspace: Workspace; tenant: Tenant | null | undefined }) {
  const brand = whiteLabelBranding(tenant ?? null);
  return (
    <KV
      items={[
        { label: "MRR", value: fmtMoney(workspace.mrr, { digits: 0 }) },
        { label: "Seats", value: `${workspace.seats} / ${workspace.seatLimit}` },
        { label: "Created", value: fmtDate(workspace.createdAt) },
        { label: "Tenant", value: <TenantSource workspace={workspace} tenant={tenant} /> },
        {
          label: "Brand",
          value: brand ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              {brand.name}
              <WhiteLabelBadge on />
              <Link href="/admin/white-label" className="text-xs font-normal text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Manage
              </Link>
            </span>
          ) : (
            <span className="text-muted-foreground">Nasscord</span>
          ),
        },
        { label: "Timezone", value: workspace.timezone.replace("America/", "").replace("_", " ") },
        { label: "Host", value: <span className="font-mono text-xs">{workspaceHostFor(workspace, tenant)}</span> },
      ]}
    />
  );
}

export function LimitsSection({ workspace, idPrefix }: { workspace: Workspace; idPrefix: string }) {
  const setLimits = useConsoleStore((s) => s.setWorkspaceLimits);
  const plan = getPlan(workspace.plan);
  const brokerLimit = plan.limits.brokers === "unlimited" ? "Unlimited" : String(plan.limits.brokers);
  return (
    <section className="grid gap-2">
      <SectionTitle hint={<PlanBadge plan={workspace.plan} />}>Limits</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-seats`}>Seat limit</Label>
          <Input
            id={`${idPrefix}-seats`}
            type="number"
            inputMode="numeric"
            min={workspace.seats}
            className="font-mono tabular"
            value={workspace.seatLimit}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) setLimits(workspace.id, { seatLimit: n });
            }}
          />
          <p className="text-xs text-muted-foreground">{workspace.seats} in use. Plan default: {plan.limits.seats === "unlimited" ? "unlimited" : plan.limits.seats}.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-brokers`}>Broker connections</Label>
          <Input id={`${idPrefix}-brokers`} value={brokerLimit} readOnly className="font-mono tabular" />
          <p className="text-xs text-muted-foreground">{workspace.brokers.length} connected. Set by the plan.</p>
        </div>
      </div>
    </section>
  );
}

export function FeatureFlagsSection({ workspace, idPrefix }: { workspace: Workspace; idPrefix: string }) {
  const setFeature = useConsoleStore((s) => s.setWorkspaceFeature);
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
                checked={workspace.features[row.key]}
                aria-describedby={`${id}-help`}
                onCheckedChange={(on) => {
                  setFeature(workspace.id, row.key, on);
                  toast.success(`${row.label} ${on ? "enabled" : "disabled"} for ${workspace.name}`);
                }}
              />
            </ControlRow>
          );
        })}
      </div>
    </section>
  );
}

export function BillingSection({ workspace, idPrefix }: { workspace: Workspace; idPrefix: string }) {
  const setPlan = useConsoleStore((s) => s.setWorkspacePlan);
  const plan = getPlan(workspace.plan);
  return (
    <section className="grid gap-2">
      <SectionTitle>Billing</SectionTitle>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${idPrefix}-plan`}>Plan</Label>
          <Select
            items={PLAN_ITEMS}
            value={workspace.plan}
            onValueChange={(v) => {
              if (!v) return;
              setPlan(workspace.id, v as PlanId);
              toast.success(`${workspace.name} moved to ${PLAN_LABEL[v as PlanId]}`, { description: "Proration applies on the next invoice." });
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
            { label: "Current MRR", value: fmtMoney(workspace.mrr, { digits: 0 }) },
            { label: "Next invoice", value: workspace.status === "suspended" ? <span className="text-muted-foreground">Paused</span> : nextInvoiceDate(workspace) },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => toast.success(`Invoice sent to ${workspace.owner.email}`, { description: `${fmtMoney(workspace.mrr, { digits: 0 })} due in 14 days.` })}>
            Send invoice
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toast("Opened in Stripe", { description: `Customer ${workspace.id.replace("w_", "cus_")}` })}>
            Open in Stripe
          </Button>
        </div>
      </div>
    </section>
  );
}

export function DangerSection({ workspace }: { workspace: Workspace }) {
  const setStatus = useConsoleStore((s) => s.setWorkspaceStatus);
  const [confirm, setConfirm] = React.useState(false);
  const suspended = workspace.status === "suspended";

  return (
    <section className="grid gap-2">
      <SectionTitle hint={<WorkspaceStatusBadge status={workspace.status} />}>Danger zone</SectionTitle>
      <div className="grid gap-2 rounded-xl border border-dashed border-input p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-0.5">
            <p className="text-sm font-medium">Impersonate owner</p>
            <p className="text-xs text-muted-foreground">Read-only session as {workspace.owner.name}. Logged to the audit trail.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => toast(`Impersonation session started`, { description: `${workspace.owner.email} · read-only · expires in 30 min` })}>
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
            <DialogTitle>{suspended ? `Reactivate ${workspace.name}?` : `Suspend ${workspace.name}?`}</DialogTitle>
            <DialogDescription>
              {suspended
                ? `${workspace.seats} seat${workspace.seats === 1 ? "" : "s"} regain access immediately and the next invoice resumes on schedule.`
                : `${workspace.seats} seat${workspace.seats === 1 ? "" : "s"} lose access at once. Working orders at the brokers are not cancelled. The owner receives an email.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant={suspended ? "default" : "destructive"}
              onClick={() => {
                setStatus(workspace.id, suspended ? "active" : "suspended");
                setConfirm(false);
                toast.success(suspended ? `${workspace.name} reactivated` : `${workspace.name} suspended`);
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

/**
 * All editable sections in order. `columns` lays them out two-up on wide detail pages.
 * White-label is not here: it belongs to the tenant and is granted on the White-label page.
 */
export function TraderSections({ workspace, idPrefix, columns = false }: { workspace: Workspace; idPrefix: string; columns?: boolean }) {
  return (
    <div className={cn("grid gap-6", columns && "lg:grid-cols-2")}>
      <LimitsSection workspace={workspace} idPrefix={idPrefix} />
      <FeatureFlagsSection workspace={workspace} idPrefix={idPrefix} />
      <BillingSection workspace={workspace} idPrefix={idPrefix} />
      <DangerSection workspace={workspace} />
    </div>
  );
}
