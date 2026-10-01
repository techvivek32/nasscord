import { Badge } from "@/components/ui/badge";
import { TONE_BADGE } from "@/components/status-dot";
import { PLAN_LABEL } from "@/lib/plans";
import type { HealthStatus, Incident, InvoiceStatus, PartnerStatus, PlanId, Role, TenantStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { HEALTH, INCIDENT_SEVERITY, INCIDENT_STATUS, INVOICE_STATUS, PARTNER_STATUS, PLAN_TONE, ROLE_LABEL, TENANT_STATUS, type Tone } from "./lib";

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(TONE_BADGE[tone], className)}>
      {children}
    </Badge>
  );
}

export function TenantStatusBadge({ status, className }: { status: TenantStatus; className?: string }) {
  const s = TENANT_STATUS[status];
  return (
    <ToneBadge tone={s.tone} className={className}>
      {s.label}
    </ToneBadge>
  );
}

export function PlanBadge({ plan, className }: { plan: PlanId; className?: string }) {
  return (
    <ToneBadge tone={PLAN_TONE[plan]} className={className}>
      {PLAN_LABEL[plan]}
    </ToneBadge>
  );
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const s = INVOICE_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

export function PartnerStatusBadge({ status }: { status: PartnerStatus }) {
  const s = PARTNER_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

export function HealthBadge({ status }: { status: HealthStatus }) {
  const s = HEALTH[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

export function SeverityBadge({ severity }: { severity: Incident["severity"] }) {
  const s = INCIDENT_SEVERITY[severity];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

export function IncidentStatusBadge({ status }: { status: Incident["status"] }) {
  const s = INCIDENT_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge variant="outline" className="font-medium">
      {ROLE_LABEL[role]}
    </Badge>
  );
}

export function TwoFactorBadge({ enabled }: { enabled: boolean }) {
  return <ToneBadge tone={enabled ? "good" : "warn"}>{enabled ? "2FA on" : "2FA off"}</ToneBadge>;
}

export function ResultBadge({ result }: { result: "ok" | "denied" | "error" }) {
  const map = { ok: { tone: "good", label: "OK" }, denied: { tone: "warn", label: "Denied" }, error: { tone: "bad", label: "Error" } } as const;
  return <ToneBadge tone={map[result].tone}>{map[result].label}</ToneBadge>;
}

export const MODEL_LABEL = { white_label: "White-label", referral: "Referral", embedded: "Embedded" } as const;

export function ModelBadge({ model }: { model: keyof typeof MODEL_LABEL }) {
  const tone: Tone = model === "white_label" ? "brand" : model === "referral" ? "good" : "neutral";
  return <ToneBadge tone={tone}>{MODEL_LABEL[model]}</ToneBadge>;
}
