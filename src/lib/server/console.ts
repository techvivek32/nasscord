import { requireRole } from "@/lib/auth";
import { CONSOLE_ROLES } from "@/lib/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { hydrateTenants, hydrateWorkspaces } from "@/lib/server/directory";
import {
  getServiceHealth,
  getServiceHealthDetail,
  isBrokerServiceConfigured,
  type ServiceHealth,
  type ServiceHealthDetail,
} from "@/lib/server/broker-service";
import {
  ACCOUNT_COLUMNS,
  CONNECTION_COLUMNS,
  MEMBER_COLUMNS,
  TENANT_COLUMNS,
  WORKSPACE_COLUMNS,
  toAuditEvent,
  toBrokerConnection,
  toBrokerRequest,
  toTenantApplication,
  toUser,
  type AuditEventRow,
  type BrokerAccountRow,
  type BrokerConnectionRow,
  type BrokerRequestRow,
  type MemberRow,
  type TenantApplicationRow,
  type TenantRow,
  type WorkspaceRow,
} from "@/lib/server/rows";
import { UUID_RE } from "@/lib/server/api";
import type {
  AuditEvent,
  BrokerConnection,
  BrokerId,
  BrokerRequest,
  ConnectionStatus,
  PlanId,
  PlatformCounts,
  Role,
  Tenant,
  TenantApplication,
  TenantApplicationStatus,
  User,
  Workspace,
  WorkspaceStatus,
} from "@/lib/types";

/*
 * Super admin reads for the console. Server only: every function checks the role first
 * (requireRole redirects anyone else), then reads with the service role. Writes are in
 * src/lib/server/console-actions.ts. Lists return up to the PostgREST row cap (1000 by default).
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

async function staff() {
  await requireRole(CONSOLE_ROLES, "/admin");
  return createAdminClient();
}

function fail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}: ${error?.code ?? "read failed"}`);
}

/** Every workspace (the console's "Traders"), newest first. */
export async function listWorkspaces(): Promise<Workspace[]> {
  const admin = await staff();
  const { data, error } = await admin.from("workspaces").select(WORKSPACE_COLUMNS).order("created_at", { ascending: false });
  if (error) fail("workspaces", error);
  return hydrateWorkspaces(admin, (data ?? []) as WorkspaceRow[]);
}

/** One workspace by id or slug. */
export async function getWorkspace(idOrSlug: string): Promise<Workspace | null> {
  const admin = await staff();
  const q = admin.from("workspaces").select(WORKSPACE_COLUMNS);
  const { data, error } = await (UUID_RE.test(idOrSlug) ? q.eq("id", idOrSlug) : q.eq("slug", idOrSlug.toLowerCase())).maybeSingle();
  if (error) fail("workspaces", error);
  if (!data) return null;
  const [ws] = await hydrateWorkspaces(admin, [data as WorkspaceRow]);
  return ws ?? null;
}

export async function listTenants(): Promise<Tenant[]> {
  const admin = await staff();
  const { data, error } = await admin.from("tenants").select(TENANT_COLUMNS).order("created_at", { ascending: false });
  if (error) fail("tenants", error);
  return hydrateTenants(admin, (data ?? []) as TenantRow[]);
}

export async function getTenant(id: string): Promise<Tenant | null> {
  if (!UUID_RE.test(id)) return null;
  const admin = await staff();
  const { data, error } = await admin.from("tenants").select(TENANT_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail("tenants", error);
  if (!data) return null;
  const [tenant] = await hydrateTenants(admin, [data as TenantRow]);
  return tenant ?? null;
}

/**
 * Everyone who can sign in, with last sign-in and second factor from Supabase Auth.
 * Filter by workspace or tenant when given.
 */
export async function listMembers(filter: { workspaceId?: string; tenantId?: string } = {}): Promise<User[]> {
  const admin = await staff();
  let q = admin.from("members").select(MEMBER_COLUMNS).order("created_at", { ascending: false });
  if (filter.workspaceId) q = q.eq("workspace_id", filter.workspaceId);
  if (filter.tenantId) q = q.eq("tenant_id", filter.tenantId);
  const { data, error } = await q;
  if (error) fail("members", error);
  const rows = (data ?? []) as MemberRow[];

  const auth = new Map<string, { lastSignInAt: string | null; twoFactor: boolean }>();
  const { data: users, error: authError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (!authError) {
    for (const u of users.users) {
      auth.set(u.id, { lastSignInAt: u.last_sign_in_at ?? null, twoFactor: (u.factors ?? []).some((f) => f.status === "verified") });
    }
  }
  return rows.map((row) => toUser(row, auth.get(row.user_id)));
}

/** Newest audit events first. */
export async function listAuditEvents(filter: { limit?: number; workspaceId?: string; actorUserId?: string } = {}): Promise<AuditEvent[]> {
  const admin = await staff();
  let q = admin
    .from("audit_events")
    .select("id, at, actor_user_id, actor_email, workspace_id, action, target, result, ip, meta")
    .order("at", { ascending: false })
    .limit(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
  if (filter.workspaceId) q = q.eq("workspace_id", filter.workspaceId);
  if (filter.actorUserId) q = q.eq("actor_user_id", filter.actorUserId);
  const { data, error } = await q;
  if (error) fail("audit_events", error);
  return ((data ?? []) as AuditEventRow[]).map(toAuditEvent);
}

export async function listTenantApplications(status?: TenantApplicationStatus): Promise<TenantApplication[]> {
  const admin = await staff();
  let q = admin.from("tenant_applications").select("*").order("created_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) fail("tenant_applications", error);
  return ((data ?? []) as TenantApplicationRow[]).map(toTenantApplication);
}

export async function listBrokerRequests(): Promise<BrokerRequest[]> {
  const admin = await staff();
  const { data, error } = await admin.from("broker_requests").select("*").order("created_at", { ascending: false });
  if (error) fail("broker_requests", error);
  return ((data ?? []) as BrokerRequestRow[]).map(toBrokerRequest);
}

/** Every broker connection on the platform with its accounts (no balances: those need the user's session at the broker). */
export async function listBrokerConnectionsAll(filter: { workspaceId?: string } = {}): Promise<BrokerConnection[]> {
  const admin = await staff();
  let cq = admin.from("broker_connections").select(CONNECTION_COLUMNS).order("created_at", { ascending: false });
  let aq = admin.from("broker_accounts").select(ACCOUNT_COLUMNS);
  if (filter.workspaceId) {
    cq = cq.eq("workspace_id", filter.workspaceId);
    aq = aq.eq("workspace_id", filter.workspaceId);
  }
  const [conns, accounts] = await Promise.all([cq, aq]);
  if (conns.error) fail("broker_connections", conns.error);
  if (accounts.error) fail("broker_accounts", accounts.error);
  const accountRows = (accounts.data ?? []) as BrokerAccountRow[];
  return ((conns.data ?? []) as BrokerConnectionRow[]).map((row) => toBrokerConnection(row, accountRows));
}

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/**
 * Platform-wide counts for the overview. Every number is a head count (`count: "exact"`), so none of
 * them stops at the PostgREST row cap the way a fetched list would.
 */
export async function platformCounts(): Promise<PlatformCounts> {
  const admin = await staff();
  const head = (table: string) => admin.from(table).select("*", { count: "exact", head: true });
  type Counted = { count: number | null; error: { code?: string; message?: string } | null };
  const count = async (what: string, q: PromiseLike<Counted>) => {
    const r = await q;
    if (r.error) fail(what, r.error);
    return r.count ?? 0;
  };
  const WS_STATUSES = ["active", "trial", "past_due", "suspended"] as const satisfies readonly WorkspaceStatus[];
  const PLANS = ["starter", "pro", "desk", "enterprise"] as const satisfies readonly PlanId[];
  const ROLE_LIST = ["superadmin", "tenant", "trader", "tenant_user"] as const satisfies readonly Role[];
  const BROKERS = ["ibkr", "etrade"] as const satisfies readonly BrokerId[];
  const DB_STATUSES = ["pending", "expired", "error", "disconnected"] as const;
  // As toConnectionStatus (rows.ts) maps them: an active connection whose session ends within 2 hours is "expiring".
  const expiringBefore = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

  const [workspaces, byStatus, byPlan, tenants, byRole, connections, byBroker, byDbStatus, active, expiring, pendingApplications, brokerRequests] = await Promise.all([
    count("workspaces", head("workspaces")),
    Promise.all(WS_STATUSES.map((v) => count("workspaces", head("workspaces").eq("status", v)))),
    Promise.all(PLANS.map((v) => count("workspaces", head("workspaces").eq("plan", v)))),
    count("tenants", head("tenants")),
    Promise.all(ROLE_LIST.map((v) => count("members", head("members").eq("role", v)))),
    count("broker_connections", head("broker_connections")),
    Promise.all(BROKERS.map((v) => count("broker_connections", head("broker_connections").eq("broker_id", v)))),
    Promise.all(DB_STATUSES.map((v) => count("broker_connections", head("broker_connections").eq("status", v)))),
    count("broker_connections", head("broker_connections").eq("status", "active")),
    count("broker_connections", head("broker_connections").eq("status", "active").lt("session_expires_at", expiringBefore)),
    count("tenant_applications", head("tenant_applications").eq("status", "pending")),
    count("broker_requests", head("broker_requests")),
  ]);

  const workspacesByStatus = zeroes<WorkspaceStatus>(WS_STATUSES);
  WS_STATUSES.forEach((v, i) => (workspacesByStatus[v] = byStatus[i]));
  const workspacesByPlan = zeroes<PlanId>(PLANS);
  PLANS.forEach((v, i) => (workspacesByPlan[v] = byPlan[i]));
  const membersByRole = zeroes<Role>(ROLE_LIST);
  ROLE_LIST.forEach((v, i) => (membersByRole[v] = byRole[i]));

  const connectionsByBroker: Partial<Record<BrokerId, number>> = {};
  BROKERS.forEach((v, i) => {
    if (byBroker[i]) connectionsByBroker[v] = byBroker[i];
  });
  const connectionsByStatus: Partial<Record<ConnectionStatus, number>> = {};
  const put = (k: ConnectionStatus, n: number) => {
    if (n) connectionsByStatus[k] = n;
  };
  DB_STATUSES.forEach((v, i) => put(v, byDbStatus[i]));
  put("expiring", expiring);
  put("connected", active - expiring);

  return {
    workspaces,
    workspacesByStatus,
    workspacesByPlan,
    tenants,
    membersByRole,
    connections,
    connectionsByBroker,
    connectionsByStatus,
    pendingApplications,
    brokerRequests,
  };
}

export interface BrokerServiceStatus {
  configured: boolean;
  reachable: boolean;
  health?: ServiceHealth;
  detail?: ServiceHealthDetail;
  error?: string;
}

/** The broker service's /health and, for the super admin, /v1/health. Never throws. */
export async function getBrokerServiceStatus(): Promise<BrokerServiceStatus> {
  const session = await requireRole(CONSOLE_ROLES, "/admin");
  if (!isBrokerServiceConfigured()) return { configured: false, reachable: false, error: "BROKER_SERVICE_URL and BROKER_SERVICE_SECRET are not set." };
  try {
    const health = await getServiceHealth();
    const detail = await getServiceHealthDetail({ userId: session.uid, workspaceId: session.workspaceId ?? null, role: session.role }).catch(() => undefined);
    return { configured: true, reachable: true, health, ...(detail ? { detail } : {}) };
  } catch (err) {
    return { configured: true, reachable: false, error: err instanceof Error ? err.message : "The broker service did not answer." };
  }
}
