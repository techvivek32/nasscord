import { APP_DOMAIN, hostFor } from "@/lib/branding";
import type { HealthStatus, Incident, InvoiceStatus, PlanId, Tenant, TenantStatus, Workspace, WorkspaceStatus } from "@/lib/types";

/** All demo timestamps are relative to this "now" (2026-09-30 14:52 ET), so relative times stay stable. */
export { DEMO_NOW } from "@/lib/demo-clock";

export type Tone = "good" | "warn" | "bad" | "neutral" | "brand";

export const WORKSPACE_STATUS: Record<WorkspaceStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  trial: { label: "Trial", tone: "brand" },
  past_due: { label: "Past due", tone: "warn" },
  suspended: { label: "Suspended", tone: "bad" },
};

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "good" },
  open: { label: "Open", tone: "brand" },
  past_due: { label: "Past due", tone: "bad" },
  void: { label: "Void", tone: "neutral" },
};

export const TENANT_STATUS: Record<TenantStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  pending: { label: "Pending", tone: "warn" },
  paused: { label: "Paused", tone: "neutral" },
};

export const HEALTH: Record<HealthStatus, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "good" },
  degraded: { label: "Degraded", tone: "warn" },
  down: { label: "Down", tone: "bad" },
};

export const INCIDENT_SEVERITY: Record<Incident["severity"], { label: string; tone: Tone }> = {
  minor: { label: "Minor", tone: "neutral" },
  major: { label: "Major", tone: "warn" },
  critical: { label: "Critical", tone: "bad" },
};

export const INCIDENT_STATUS: Record<Incident["status"], { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "bad" },
  monitoring: { label: "Monitoring", tone: "warn" },
  resolved: { label: "Resolved", tone: "good" },
};

export { ROLE_LABEL } from "@/lib/roles";

export const PLAN_TONE: Record<PlanId, Tone> = {
  starter: "neutral",
  pro: "brand",
  desk: "good",
  enterprise: "warn",
};

/** The platform owner's login. Console changes are written to the audit log under it. */
export const SUPER_ADMIN_EMAIL = "vivek@nasscord.com";

export const MAINTENANCE_WINDOW = "Weekdays 09:30–16:00 ET";
/** Same window, for mid-sentence use. */
export const MAINTENANCE_WINDOW_INLINE = "weekdays 09:30–16:00 ET";
/** Logins the maintenance gate lets through. Traders and tenant users are blocked. */
export const MAINTENANCE_EXEMPT = [SUPER_ADMIN_EMAIL];

export const PLATFORM_DOMAIN = APP_DOMAIN;

/**
 * Where a workspace's terminal lives, given its tenant as the console currently sees it (white-label
 * grants and branding edits from this session included). Same rule as `workspaceHost` in lib/tenant.
 */
export function workspaceHostFor(workspace: Workspace, tenant: Tenant | null | undefined) {
  return hostFor(workspace, tenant);
}

export function shortId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
