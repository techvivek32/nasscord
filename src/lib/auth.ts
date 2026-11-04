import { cache } from "react";
import { redirect } from "next/navigation";
import { homeForRole, isRole } from "@/lib/roles";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { memberName, MEMBER_COLUMNS, type MemberRow } from "@/lib/server/rows";
import type { Role, Session } from "@/lib/types";

/*
 * Server-side authentication on Supabase Auth. Identity comes from verified JWT claims (getClaims),
 * the role and workspace from the user's `members` row (read through RLS as the user). The proxy
 * gates optimistically from the role copied into app_metadata; these helpers are the real check.
 * The mutating server actions live in src/lib/auth-actions.ts.
 */

/** The signed-in Supabase user, whether or not they finished signup. */
export interface AuthUser {
  id: string;
  email: string;
  /** user_metadata.full_name from signup. */
  fullName: string;
  /** user_metadata.tenant_code from signup, when one was entered. */
  tenantCode?: string;
  /** app_metadata.role from the verified JWT. The members row is the source of truth. */
  claimRole?: Role;
}

/** Verified identity for this request, or null when signed out or Supabase is not configured. */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims;
    if (!claims?.sub) return null;
    const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
    const role = claims.app_metadata?.role;
    return {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : "",
      fullName: typeof meta.full_name === "string" ? meta.full_name : "",
      ...(typeof meta.tenant_code === "string" && meta.tenant_code ? { tenantCode: meta.tenant_code } : {}),
      ...(isRole(role) ? { claimRole: role } : {}),
    };
  } catch {
    return null;
  }
});

/** The member row of the signed-in user, read as that user (RLS: own row). Null when there is none yet. */
export const getMemberRow = cache(async (): Promise<(MemberRow & { workspace_slug: string | null }) | null> => {
  const user = await getAuthUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("members").select(`${MEMBER_COLUMNS}, workspaces(slug)`).eq("user_id", user.id).maybeSingle();
  if (error) {
    console.error(`[auth] members lookup failed: ${error.code ?? "unknown error"}`);
    return null;
  }
  if (!data || !isRole(data.role)) return null;
  const ws = (data as { workspaces?: { slug?: string } | { slug?: string }[] | null }).workspaces;
  const slug = Array.isArray(ws) ? (ws[0]?.slug ?? null) : (ws?.slug ?? null);
  return { ...(data as MemberRow), workspace_slug: slug };
});

/** Signed in and set up (has a members row), or null. */
export const getSession = cache(async (): Promise<Session | null> => {
  const member = await getMemberRow();
  if (!member) return null;
  return {
    uid: member.user_id,
    name: memberName(member),
    email: member.email,
    role: member.role,
    ...(member.workspace_slug ? { workspace: member.workspace_slug } : {}),
    ...(member.workspace_id ? { workspaceId: member.workspace_id } : {}),
    ...(member.tenant_id ? { tenantId: member.tenant_id } : {}),
  };
});

/**
 * The session, or a redirect: signed out goes to /login?next=…, signed in without a members row goes
 * to /signup to finish setup. Use in layouts of protected route groups.
 */
export async function requireSession(next = "/app"): Promise<Session> {
  const user = await getAuthUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  const session = await getSession();
  if (!session) redirect("/signup");
  return session;
}

/** Signed in with one of `roles`, or sent to their own home (never to an area they cannot open). */
export async function requireRole(roles: Session["role"][], next = "/app"): Promise<Session> {
  const s = await requireSession(next);
  if (!roles.includes(s.role)) redirect(homeForRole(s.role));
  return s;
}

export { homeForRole } from "@/lib/roles";
