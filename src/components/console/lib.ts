import { hostFor } from "@/lib/branding";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type {
  ConnectionEnvironment,
  ConnectionMethod,
  ConnectionStatus,
  PlanId,
  Tenant,
  TenantApplicationStatus,
  TenantStatus,
  User,
  Workspace,
  WorkspaceStatus,
} from "@/lib/types";

/* Labels and tones the console pages share. Pure: safe for server and client components. */

export type Tone = "good" | "warn" | "bad" | "neutral" | "brand";

export const WORKSPACE_STATUSES: WorkspaceStatus[] = ["active", "trial", "past_due", "suspended"];

export const WORKSPACE_STATUS: Record<WorkspaceStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  trial: { label: "Trial", tone: "brand" },
  past_due: { label: "Past due", tone: "warn" },
  suspended: { label: "Suspended", tone: "bad" },
};

export const TENANT_STATUS: Record<TenantStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  pending: { label: "Pending", tone: "warn" },
  suspended: { label: "Suspended", tone: "neutral" },
};

export const APPLICATION_STATUS: Record<TenantApplicationStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "good" },
  declined: { label: "Declined", tone: "neutral" },
};

export const CONNECTION_STATUSES: ConnectionStatus[] = ["connected", "expiring", "pending", "expired", "error", "disconnected"];

export const CONNECTION_STATUS: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "good" },
  expiring: { label: "Expiring", tone: "warn" },
  pending: { label: "Waiting for login", tone: "brand" },
  expired: { label: "Expired", tone: "bad" },
  error: { label: "Error", tone: "bad" },
  disconnected: { label: "Disconnected", tone: "neutral" },
};

export const METHOD_LABEL: Record<ConnectionMethod, string> = {
  ibkr_gateway: "IBKR Client Portal Gateway",
  ibkr_oauth: "IBKR OAuth",
  etrade_oauth1: "E*TRADE OAuth 1.0a",
};

export const ENVIRONMENT_LABEL: Record<ConnectionEnvironment, string> = {
  production: "Production",
  sandbox: "Sandbox",
  paper: "Paper",
};

export { ROLE_LABEL } from "@/lib/roles";

export const PLAN_TONE: Record<PlanId, Tone> = {
  starter: "neutral",
  pro: "brand",
  desk: "good",
  enterprise: "warn",
};

/** Where a workspace's terminal lives: its white-label tenant's domain, else its own subdomain. */
export function workspaceHostFor(workspace: Pick<Workspace, "slug">, tenant: Tenant | null | undefined) {
  return hostFor(workspace, tenant);
}

/**
 * "Nov 3, 2026" in Eastern time, like fmtDateTime. Server and browser render the same day, so a
 * client table does not change its dates on hydration.
 */
export function fmtDay(iso: string) {
  return fmtDate(iso, { timeZone: "America/New_York" });
}

/**
 * Last sign-in as the console shows it. Supabase Auth answered for this user when `twoFactor` is
 * known; only then does a missing date mean "Never". Otherwise the lookup failed or did not reach
 * the user, and the console says it does not know.
 */
export function lastSignInLabel(user: Pick<User, "lastActiveAt" | "twoFactor">) {
  if (user.lastActiveAt) return fmtDateTime(user.lastActiveAt);
  return user.twoFactor !== undefined ? "Never" : "Not known";
}

/** "3 d 4 h" from seconds, for service uptime. */
export function fmtUptime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return "";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

/**
 * Runs a server action and turns a thrown error (offline, server restarted) into a refusal, so a
 * failed call shows a toast instead of replacing the page with the error boundary.
 */
export async function attempt<T extends { ok: boolean }>(call: () => Promise<T>): Promise<T | { ok: false; error: string; field?: string }> {
  try {
    return await call();
  } catch {
    return { ok: false, error: "The server did not answer. Check your connection and try again." };
  }
}
