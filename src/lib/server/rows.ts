import { getPlan } from "@/lib/plans";
import type {
  AccountType,
  AuditEvent,
  BrokerAccount,
  BrokerConnection,
  BrokerId,
  BrokerRequest,
  ConnectionEnvironment,
  ConnectionMethod,
  ConnectionStatus,
  PlanId,
  Role,
  Tenant,
  TenantApplication,
  TenantApplicationStatus,
  TenantBranding,
  TenantOfferId,
  TenantStatus,
  User,
  UserSettings,
  Workspace,
  WorkspaceStatus,
} from "@/lib/types";

/*
 * Row shapes of supabase/migrations/20261103120000_init.sql and their mapping to the domain types in
 * src/lib/types.ts. Pure functions: server modules and route handlers share them.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  commission_pct: number | string;
  white_label: boolean;
  branding: Partial<TenantBranding> | null;
  referral_code: string | null;
  owner_id: string | null;
  created_at: string;
}

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: WorkspaceStatus;
  tenant_id: string | null;
  timezone: string;
  owner_id: string;
  created_at: string;
}

export interface MemberRow {
  user_id: string;
  role: Role;
  workspace_id: string | null;
  tenant_id: string | null;
  full_name: string;
  email: string;
  created_at: string;
}

export interface UserSettingsRow {
  user_id: string;
  risk_pct: number | string;
  paper_mode: boolean;
  extended_hours: boolean;
  email_alerts: boolean;
  push_alerts: boolean;
  sms_alerts: boolean;
  default_account_id: string | null;
  updated_at: string;
}

export type DbConnectionStatus = "pending" | "active" | "expired" | "error" | "disconnected";

export interface BrokerConnectionRow {
  id: string;
  workspace_id: string;
  user_id: string;
  broker_id: "ibkr" | "etrade";
  method: ConnectionMethod;
  environment: ConnectionEnvironment;
  status: DbConnectionStatus;
  status_detail: string | null;
  session_expires_at: string | null;
  last_ok_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrokerAccountRow {
  id: string;
  connection_id: string;
  workspace_id: string;
  broker_id: "ibkr" | "etrade";
  external_id: string;
  display_number: string;
  label: string;
  type: AccountType;
  included: boolean;
  created_at: string;
}

export interface TenantApplicationRow {
  id: string;
  name: string;
  company: string;
  email: string;
  offer: TenantOfferId;
  expected_traders: number | null;
  notes: string | null;
  status: TenantApplicationStatus;
  created_at: string;
}

export interface BrokerRequestRow {
  id: string;
  broker_name: string;
  email: string;
  created_at: string;
}

export interface AuditEventRow {
  id: number | string;
  at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  workspace_id: string | null;
  action: string;
  target: string | null;
  result: AuditEvent["result"];
  ip: string | null;
  meta: Record<string, unknown> | null;
}

/** Columns for the select lists, kept next to the row shapes. */
export const TENANT_COLUMNS = "id, slug, name, status, commission_pct, white_label, branding, referral_code, owner_id, created_at";
export const WORKSPACE_COLUMNS = "id, slug, name, plan, status, tenant_id, timezone, owner_id, created_at";
export const MEMBER_COLUMNS = "user_id, role, workspace_id, tenant_id, full_name, email, created_at";
export const CONNECTION_COLUMNS = "id, workspace_id, user_id, broker_id, method, environment, status, status_detail, session_expires_at, last_ok_at, created_at, updated_at";
export const ACCOUNT_COLUMNS = "id, connection_id, workspace_id, broker_id, external_id, display_number, label, type, included, created_at";

/* ---------- mapping ---------- */

/** A stored branding object is only usable when it has a name and both accents. */
export function toBranding(raw: Partial<TenantBranding> | null | undefined): TenantBranding | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.name !== "string" || typeof raw.accent !== "string" || typeof raw.accentDark !== "string") return undefined;
  return {
    name: raw.name,
    accent: raw.accent,
    accentDark: raw.accentDark,
    ...(typeof raw.domain === "string" && raw.domain ? { domain: raw.domain } : {}),
    ...(typeof raw.supportEmail === "string" && raw.supportEmail ? { supportEmail: raw.supportEmail } : {}),
  };
}

export function toTenant(row: TenantRow, extra: { workspaces?: number; contact?: string } = {}): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ...(extra.contact ? { contact: extra.contact } : {}),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    workspaces: extra.workspaces ?? 0,
    commissionPct: Number(row.commission_pct),
    status: row.status,
    ...(row.referral_code ? { referralCode: row.referral_code } : {}),
    createdAt: row.created_at,
    whiteLabel: row.white_label,
    ...(toBranding(row.branding) ? { branding: toBranding(row.branding) } : {}),
  };
}

export function toWorkspace(row: WorkspaceRow, extra: { owner?: { name: string; email: string }; seats?: number; brokers?: BrokerId[] } = {}): Workspace {
  const seats = getPlan(row.plan).limits.seats;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan,
    status: row.status,
    createdAt: row.created_at,
    seats: extra.seats ?? 0,
    ...(typeof seats === "number" ? { seatLimit: seats } : {}),
    brokers: extra.brokers ?? [],
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    owner: extra.owner ?? { name: "", email: "" },
    timezone: row.timezone,
  };
}

/** "jordan.martin@x.com" -> "Jordan Martin", for members who never gave a name. */
export function nameFromEmail(email: string) {
  return (email.split("@")[0] ?? "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function memberName(row: Pick<MemberRow, "full_name" | "email">) {
  return row.full_name.trim() || nameFromEmail(row.email);
}

export function toUser(row: MemberRow, auth?: { lastSignInAt?: string | null; twoFactor?: boolean }): User {
  return {
    id: row.user_id,
    name: memberName(row),
    email: row.email,
    role: row.role,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(auth?.twoFactor !== undefined ? { twoFactor: auth.twoFactor } : {}),
    ...(auth?.lastSignInAt ? { lastActiveAt: auth.lastSignInAt } : {}),
    createdAt: row.created_at,
  };
}

export function toUserSettings(row: UserSettingsRow): UserSettings {
  return {
    riskPct: Number(row.risk_pct),
    paperMode: row.paper_mode,
    extendedHours: row.extended_hours,
    emailAlerts: row.email_alerts,
    pushAlerts: row.push_alerts,
    smsAlerts: row.sms_alerts,
    defaultAccountId: row.default_account_id,
    updatedAt: row.updated_at,
  };
}

/** Defaults of the user_settings table, for a member whose row is missing. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  riskPct: 1,
  paperMode: true,
  extendedHours: false,
  emailAlerts: true,
  pushAlerts: true,
  smsAlerts: false,
  defaultAccountId: null,
};

const EXPIRING_MS = 2 * 60 * 60 * 1000;

/** DB status to the app's: `active` is `connected`, or `expiring` when the session ends within 2 hours. */
export function toConnectionStatus(status: DbConnectionStatus | string, sessionExpiresAt: string | null | undefined, now = Date.now()): ConnectionStatus {
  switch (status) {
    case "active": {
      const ends = sessionExpiresAt ? Date.parse(sessionExpiresAt) : NaN;
      return Number.isFinite(ends) && ends - now < EXPIRING_MS ? "expiring" : "connected";
    }
    case "pending":
    case "expired":
    case "error":
    case "disconnected":
      return status;
    default:
      return "error";
  }
}

export function toBrokerAccount(row: BrokerAccountRow): BrokerAccount {
  return {
    id: row.id,
    connectionId: row.connection_id,
    brokerId: row.broker_id,
    label: row.label,
    masked: row.display_number,
    type: row.type,
    included: row.included,
  };
}

export function toBrokerConnection(row: BrokerConnectionRow, accounts: BrokerAccountRow[]): BrokerConnection {
  return {
    id: row.id,
    brokerId: row.broker_id,
    method: row.method,
    environment: row.environment,
    status: toConnectionStatus(row.status, row.session_expires_at),
    ...(row.status_detail ? { statusDetail: row.status_detail } : {}),
    connectedAt: row.created_at,
    ...(row.last_ok_at ? { lastOkAt: row.last_ok_at } : {}),
    ...(row.session_expires_at ? { sessionExpiresAt: row.session_expires_at } : {}),
    accounts: accounts.filter((a) => a.connection_id === row.id).map(toBrokerAccount),
    permissions: ["read"],
    workspaceId: row.workspace_id,
  };
}

export function toTenantApplication(row: TenantApplicationRow): TenantApplication {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    contact: row.email,
    offer: row.offer,
    wantsWhiteLabel: row.offer === "white_label",
    ...(row.expected_traders !== null ? { expectedTraders: row.expected_traders, audience: `${row.expected_traders.toLocaleString("en-US")} expected traders` } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    status: row.status,
    submittedAt: row.created_at,
  };
}

export function toBrokerRequest(row: BrokerRequestRow): BrokerRequest {
  return { id: row.id, brokerName: row.broker_name, email: row.email, createdAt: row.created_at };
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: String(row.id),
    at: row.at,
    // No user and no email: an anonymous request (a public form, a failed sign-in). The broker
    // service writes its own events with actor_email "system".
    actor: row.actor_email ?? (row.actor_user_id ? row.actor_user_id : "anonymous"),
    action: row.action,
    target: row.target ?? "",
    ...(row.ip ? { ip: row.ip } : {}),
    result: row.result,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.meta ? { meta: row.meta } : {}),
  };
}
