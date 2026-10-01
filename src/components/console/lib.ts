import type { HealthStatus, Incident, InvoiceStatus, PartnerStatus, PlanId, TenantStatus } from "@/lib/types";

/** All demo timestamps are relative to this "now" (2026-09-30 14:52 ET), so relative times stay stable. */
export { DEMO_NOW } from "@/lib/demo-clock";

export type Tone = "good" | "warn" | "bad" | "neutral" | "brand";

export const TENANT_STATUS: Record<TenantStatus, { label: string; tone: Tone }> = {
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

export const PARTNER_STATUS: Record<PartnerStatus, { label: string; tone: Tone }> = {
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

export const MAINTENANCE_WINDOW = "Weekdays 09:30–16:00 ET";
/** Same window, for mid-sentence use. */
export const MAINTENANCE_WINDOW_INLINE = "weekdays 09:30–16:00 ET";
export const MAINTENANCE_EXEMPT = ["ops@nasscord.com"];

export const PLATFORM_DOMAIN = "nasscord.com";

export function tenantHost(slug: string, domain?: string) {
  return domain ?? `${slug}.${PLATFORM_DOMAIN}`;
}

export function shortId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
