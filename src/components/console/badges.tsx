import { Badge } from "@/components/ui/badge";
import { TONE_BADGE } from "@/components/status-dot";
import { PLAN_LABEL } from "@/lib/plans";
import type { ConnectionStatus, PlanId, Role, TenantApplicationStatus, TenantStatus, WorkspaceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { APPLICATION_STATUS, CONNECTION_STATUS, PLAN_TONE, ROLE_LABEL, TENANT_STATUS, WORKSPACE_STATUS, type Tone } from "./lib";

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(TONE_BADGE[tone], className)}>
      {children}
    </Badge>
  );
}

export function WorkspaceStatusBadge({ status, className }: { status: WorkspaceStatus; className?: string }) {
  const s = WORKSPACE_STATUS[status];
  return (
    <ToneBadge tone={s.tone} className={className}>
      {s.label}
    </ToneBadge>
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

export function ApplicationStatusBadge({ status }: { status: TenantApplicationStatus }) {
  const s = APPLICATION_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const s = CONNECTION_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

/**
 * Whether a tenant has white-label. Default wording names the feature ("White-label");
 * `compact` reads On / Off for a column that is already headed White-label.
 */
export function WhiteLabelBadge({ on, compact = false, className }: { on: boolean; compact?: boolean; className?: string }) {
  return (
    <ToneBadge tone={on ? "brand" : "neutral"} className={className}>
      {compact ? (on ? "On" : "Off") : on ? "White-label" : "No white-label"}
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

export function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge variant="outline" className="font-medium">
      {ROLE_LABEL[role]}
    </Badge>
  );
}

export function ResultBadge({ result }: { result: "ok" | "denied" | "error" }) {
  const map = { ok: { tone: "good", label: "OK" }, denied: { tone: "warn", label: "Denied" }, error: { tone: "bad", label: "Error" } } as const;
  return <ToneBadge tone={map[result].tone}>{map[result].label}</ToneBadge>;
}
