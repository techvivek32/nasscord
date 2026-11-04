"use server";

import { revalidatePath } from "next/cache";
import { getSession, requireRole } from "@/lib/auth";
import { CONSOLE_ROLES } from "@/lib/roles";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";
import { UUID_RE } from "@/lib/server/api";
import { audit } from "@/lib/server/audit";
import { hydrateWorkspaces } from "@/lib/server/directory";
import { memberName, WORKSPACE_COLUMNS, type WorkspaceRow } from "@/lib/server/rows";
import type { ActionResult } from "@/lib/signup";
import type { PlanId, Role, Session, Workspace, WorkspaceStatus } from "@/lib/types";

/*
 * Console extras that src/lib/server/console.ts and console-actions.ts do not cover: the Ctrl K
 * search over real workspaces and members, a database round-trip check for System Health, light
 * workspace reads for pages that need only a few rows or a few columns, and setting a tenant's
 * referral code. Server functions: each one checks that the caller is the super admin before it
 * reads or writes anything with the service role.
 */

const DENIED = "Only the super admin can do this.";

export interface WorkspaceHit {
  id: string;
  name: string;
  slug: string;
  plan: PlanId;
  status: WorkspaceStatus;
  ownerEmail: string;
}

export interface MemberHit {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The workspace the member trades in, or the tenant a tenant login runs. Empty when neither. */
  place: string;
}

/** A workspace without its joins: enough to name it, link it or find its tenant. */
export interface WorkspaceRef {
  id: string;
  name: string;
  slug: string;
  tenantId: string | null;
  createdAt: string;
}

type Refusal = { ok: false; error: string };

/** The super admin's session, or the refusal to return (audited as denied). */
async function superadminSession(action: string, target?: string): Promise<Session | Refusal> {
  if (!isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const session = await getSession();
  if (session?.role === "superadmin") return session;
  await audit({ actorUserId: session?.uid ?? null, actorEmail: session?.email ?? null, action, target, result: "denied" });
  return { ok: false, error: DENIED };
}

async function superadminOnly(action: string): Promise<Refusal | null> {
  const r = await superadminSession(action);
  return "uid" in r ? null : r;
}

/** For page reads: anyone else is redirected, like the reads in src/lib/server/console.ts. */
async function staff() {
  await requireRole(CONSOLE_ROLES, "/admin");
  return createAdminClient();
}

/** Letters, digits, spaces and the characters of an email or slug. Everything PostgREST treats as syntax is dropped. */
function cleanQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}@._+\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

/** Workspaces by name, slug or owner, and members by name or email. Up to 8 of each. */
export async function searchConsole(query: string): Promise<ActionResult<{ workspaces: WorkspaceHit[]; members: MemberHit[] }>> {
  const refused = await superadminOnly("console.search");
  if (refused) return refused;
  const q = cleanQuery(query);
  if (q.length < 2) return { ok: true, workspaces: [], members: [] };

  const admin = createAdminClient();
  const like = `"%${q}%"`;
  const members = await admin
    .from("members")
    .select("user_id, role, workspace_id, tenant_id, full_name, email")
    .or(`full_name.ilike.${like},email.ilike.${like}`)
    .order("created_at", { ascending: false })
    .limit(8);
  if (members.error) return { ok: false, error: "Search did not answer. Try again in a moment." };
  const memberRows = (members.data ?? []) as { user_id: string; role: Role; workspace_id: string | null; tenant_id: string | null; full_name: string; email: string }[];

  // Workspaces whose name or slug matches, plus the ones owned by a matching member.
  const ownedBy = [...new Set(memberRows.map((m) => m.user_id))];
  const wsFilter = [`name.ilike.${like}`, `slug.ilike.${like}`, ...(ownedBy.length ? [`owner_id.in.(${ownedBy.join(",")})`] : [])].join(",");
  const workspaces = await admin.from("workspaces").select("id, slug, name, plan, status, owner_id").or(wsFilter).order("created_at", { ascending: false }).limit(8);
  if (workspaces.error) return { ok: false, error: "Search did not answer. Try again in a moment." };
  const wsRows = (workspaces.data ?? []) as { id: string; slug: string; name: string; plan: PlanId; status: WorkspaceStatus; owner_id: string }[];

  // Names for the places members belong to, and owner emails for the workspaces.
  const wsIds = [...new Set(memberRows.map((m) => m.workspace_id).filter((v): v is string => Boolean(v)))];
  const tenantIds = [...new Set(memberRows.map((m) => m.tenant_id).filter((v): v is string => Boolean(v)))];
  const ownerIds = [...new Set(wsRows.map((w) => w.owner_id))];
  const [placeWs, placeTenants, owners] = await Promise.all([
    wsIds.length ? admin.from("workspaces").select("id, name").in("id", wsIds) : Promise.resolve({ data: [], error: null }),
    tenantIds.length ? admin.from("tenants").select("id, name").in("id", tenantIds) : Promise.resolve({ data: [], error: null }),
    ownerIds.length ? admin.from("members").select("user_id, email").in("user_id", ownerIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const wsName = new Map(((placeWs.data ?? []) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
  const tenantName = new Map(((placeTenants.data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
  const ownerEmail = new Map(((owners.data ?? []) as { user_id: string; email: string }[]).map((m) => [m.user_id, m.email]));

  return {
    ok: true,
    workspaces: wsRows.map((w) => ({ id: w.id, name: w.name, slug: w.slug, plan: w.plan, status: w.status, ownerEmail: ownerEmail.get(w.owner_id) ?? "" })),
    members: memberRows.map((m) => ({
      id: m.user_id,
      name: memberName(m),
      email: m.email,
      role: m.role,
      place: (m.workspace_id ? wsName.get(m.workspace_id) : undefined) ?? (m.tenant_id ? tenantName.get(m.tenant_id) : undefined) ?? "",
    })),
  };
}

/** One small read against Postgres through PostgREST, timed. Never throws. */
export async function checkDatabase(): Promise<ActionResult<{ ms: number }>> {
  const refused = await superadminOnly("console.health.database");
  if (refused) return refused;
  const started = performance.now();
  try {
    const { error } = await createAdminClient().from("tenants").select("id", { count: "exact", head: true });
    const ms = Math.round(performance.now() - started);
    if (error) return { ok: false, error: `The database answered with an error${error.code ? ` (${error.code})` : ""}.` };
    return { ok: true, ms };
  } catch {
    return { ok: false, error: "The database did not answer." };
  }
}

/** The newest workspaces with owner, members and brokers, for the overview's short list. */
export async function listRecentWorkspaces(limit = 6): Promise<Workspace[]> {
  const admin = await staff();
  const n = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 6;
  const { data, error } = await admin.from("workspaces").select(WORKSPACE_COLUMNS).order("created_at", { ascending: false }).limit(n);
  if (error) throw new Error(`workspaces: ${error.code ?? "read failed"}`);
  return hydrateWorkspaces(admin, (data ?? []) as WorkspaceRow[]);
}

/**
 * Id, name, slug and tenant of every workspace, oldest first, with no joins. With `withTenant`,
 * only the workspaces that came through a tenant. Up to the PostgREST row cap (1000 by default).
 */
export async function listWorkspaceRefs(filter: { withTenant?: boolean } = {}): Promise<WorkspaceRef[]> {
  const admin = await staff();
  let q = admin.from("workspaces").select("id, name, slug, tenant_id, created_at").order("created_at", { ascending: true });
  if (filter?.withTenant === true) q = q.not("tenant_id", "is", null);
  const { data, error } = await q;
  if (error) throw new Error(`workspaces: ${error.code ?? "read failed"}`);
  return ((data ?? []) as { id: string; name: string; slug: string; tenant_id: string | null; created_at: string }[]).map((w) => ({
    id: w.id,
    name: w.name,
    slug: w.slug,
    tenantId: w.tenant_id,
    createdAt: w.created_at,
  }));
}

/**
 * Sets a tenant's referral code, or clears it with an empty string. Workspaces already on the tenant
 * stay on it; signup stops accepting the old code at once. Audited with the old and new code.
 */
export async function setTenantReferralCode(tenantId: string, code: string): Promise<ActionResult> {
  const actor = await superadminSession("tenant.referral_code.update", typeof tenantId === "string" ? tenantId : undefined);
  if (!("uid" in actor)) return actor;
  if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) return { ok: false, error: "Pick a tenant." };
  const raw = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (raw !== "" && !/^[A-Z0-9-]{3,24}$/.test(raw)) return { ok: false, field: "referralCode", error: "Codes are 3 to 24 letters, numbers or hyphens." };
  const next = raw || null;

  const admin = createAdminClient();
  const before = await admin.from("tenants").select("name, referral_code").eq("id", tenantId).maybeSingle();
  if (before.error) return { ok: false, error: "We could not read that tenant. Try again." };
  if (!before.data) return { ok: false, error: "That tenant no longer exists." };
  const prev = (before.data.referral_code as string | null) ?? null;
  if (prev === next) return { ok: true };

  const { error } = await admin.from("tenants").update({ referral_code: next }).eq("id", tenantId);
  if (error) {
    if (error.code === "23505") return { ok: false, field: "referralCode", error: "Another tenant already uses that code." };
    return { ok: false, error: "We could not change the code. Try again." };
  }
  await audit({
    actorUserId: actor.uid,
    actorEmail: actor.email,
    action: "tenant.referral_code.update",
    target: `${before.data.name as string} · ${next ?? "none"}`,
    meta: { from: prev, to: next },
  });
  revalidatePath("/admin", "layout");
  revalidatePath("/tenant", "layout");
  return { ok: true };
}
