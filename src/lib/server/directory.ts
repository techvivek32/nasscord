import type { SupabaseClient } from "@supabase/supabase-js";
import {
  memberName,
  toTenant,
  toWorkspace,
  type MemberRow,
  type TenantRow,
  type WorkspaceRow,
} from "@/lib/server/rows";
import type { BrokerId, Tenant, Workspace } from "@/lib/types";

/*
 * Joins shared by the console (src/lib/server/console.ts) and the tenant portal
 * (src/lib/server/tenant.ts): workspaces with owner, seats and brokers; tenants with their
 * workspace count and owner email. Callers pass the service-role client after checking the role.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

function fail(what: string, error: { code?: string } | null): never {
  throw new Error(`${what}: ${error?.code ?? "read failed"}`);
}

export async function hydrateWorkspaces(admin: SupabaseClient, rows: WorkspaceRow[]): Promise<Workspace[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
  const [members, owners, conns] = await Promise.all([
    admin.from("members").select("user_id, workspace_id").in("workspace_id", ids),
    admin.from("members").select("user_id, full_name, email").in("user_id", ownerIds),
    admin.from("broker_connections").select("workspace_id, broker_id").in("workspace_id", ids).neq("status", "disconnected"),
  ]);
  if (members.error) fail("members", members.error);
  if (owners.error) fail("members", owners.error);
  if (conns.error) fail("broker_connections", conns.error);

  const seats = new Map<string, number>();
  for (const m of (members.data ?? []) as Pick<MemberRow, "user_id" | "workspace_id">[]) {
    if (m.workspace_id) seats.set(m.workspace_id, (seats.get(m.workspace_id) ?? 0) + 1);
  }
  const ownerById = new Map(((owners.data ?? []) as Pick<MemberRow, "user_id" | "full_name" | "email">[]).map((m) => [m.user_id, m]));
  const brokers = new Map<string, Set<BrokerId>>();
  for (const c of (conns.data ?? []) as { workspace_id: string; broker_id: BrokerId }[]) {
    const set = brokers.get(c.workspace_id) ?? new Set<BrokerId>();
    set.add(c.broker_id);
    brokers.set(c.workspace_id, set);
  }

  return rows.map((row) => {
    const owner = ownerById.get(row.owner_id);
    return toWorkspace(row, {
      seats: seats.get(row.id) ?? 0,
      brokers: [...(brokers.get(row.id) ?? [])],
      owner: owner ? { name: memberName(owner), email: owner.email } : { name: "", email: "" },
    });
  });
}

export async function hydrateTenants(admin: SupabaseClient, rows: TenantRow[]): Promise<Tenant[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ownerIds = rows.map((r) => r.owner_id).filter((v): v is string => Boolean(v));
  const [workspaces, owners] = await Promise.all([
    admin.from("workspaces").select("tenant_id").in("tenant_id", ids),
    ownerIds.length ? admin.from("members").select("user_id, email").in("user_id", ownerIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (workspaces.error) fail("workspaces", workspaces.error);
  if (owners.error) fail("members", owners.error);
  const counts = new Map<string, number>();
  for (const w of (workspaces.data ?? []) as { tenant_id: string | null }[]) {
    if (w.tenant_id) counts.set(w.tenant_id, (counts.get(w.tenant_id) ?? 0) + 1);
  }
  const emails = new Map(((owners.data ?? []) as { user_id: string; email: string }[]).map((m) => [m.user_id, m.email]));
  return rows.map((row) => toTenant(row, { workspaces: counts.get(row.id) ?? 0, contact: row.owner_id ? emails.get(row.owner_id) : undefined }));
}
