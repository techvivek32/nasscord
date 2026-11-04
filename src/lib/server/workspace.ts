import { cache } from "react";
import { headers } from "next/headers";
import { getAuthUser, getSession } from "@/lib/auth";
import { hostFor } from "@/lib/branding";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { brandingFor, getTenantById } from "@/lib/tenant-server";
import {
  DEFAULT_USER_SETTINGS,
  memberName,
  toUserSettings,
  toWorkspace,
  WORKSPACE_COLUMNS,
  type MemberRow,
  type UserSettingsRow,
  type WorkspaceRow,
} from "@/lib/server/rows";
import type { BrokerId, TenantBranding, UserSettings, Workspace } from "@/lib/types";

/*
 * The signed-in user's workspace, its branding and their settings. Server only, cached per request.
 * The terminal always works on the session's own workspace: a subdomain only changes the branding,
 * never whose data is shown (the broker routes use the member's workspace_id too).
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

/** The session's workspace with owner, seat count and connected brokers, or null (a tenant login has none). */
export const getCurrentWorkspace = cache(async (): Promise<Workspace | null> => {
  const session = await getSession();
  if (!session?.workspaceId) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").select(WORKSPACE_COLUMNS).eq("id", session.workspaceId).maybeSingle();
  if (error || !data) return null;
  const row = data as WorkspaceRow;

  // Members and connections of this workspace are read with the service role: RLS shows a trader only their own member row.
  const admin = createAdminClient();
  const [members, connections] = await Promise.all([
    admin.from("members").select("user_id, full_name, email").eq("workspace_id", row.id),
    admin.from("broker_connections").select("broker_id").eq("workspace_id", row.id).neq("status", "disconnected"),
  ]);
  const memberRows = (members.data ?? []) as Pick<MemberRow, "user_id" | "full_name" | "email">[];
  const ownerRow = memberRows.find((m) => m.user_id === row.owner_id);
  const brokers = [...new Set(((connections.data ?? []) as { broker_id: BrokerId }[]).map((c) => c.broker_id))];

  return toWorkspace(row, {
    seats: memberRows.length,
    brokers,
    owner: ownerRow ? { name: memberName(ownerRow), email: ownerRow.email } : { name: session.name, email: session.email },
  });
});

/** Branding for this request: a white-label custom domain wins, then the workspace's white-label tenant. */
export async function getCurrentBranding(workspace: Workspace | null): Promise<TenantBranding> {
  const h = await headers();
  return brandingFor({ workspaceTenantId: workspace?.tenantId, hostDomain: h.get("x-tenant") });
}

/** Where a workspace's terminal lives: its white-label tenant's domain, else its own subdomain. */
export async function workspaceHost(workspace: Workspace): Promise<string> {
  return hostFor(workspace, await getTenantById(workspace.tenantId));
}

/** The signed-in user's trading defaults (table defaults when the row is missing). */
export const getMySettings = cache(async (): Promise<UserSettings> => {
  const user = await getAuthUser();
  if (!user) return DEFAULT_USER_SETTINGS;
  const supabase = await createClient();
  const { data } = await supabase.from("user_settings").select("*").eq("user_id", user.id).maybeSingle();
  return data ? toUserSettings(data as UserSettingsRow) : DEFAULT_USER_SETTINGS;
});
