import { headers } from "next/headers";
import { brandingFor, getWorkspaceBySlug, resolveHost } from "@/lib/tenant";
import { getSession } from "@/lib/auth";
import { WORKSPACES } from "@/lib/mock/workspaces";
import type { TenantBranding, Workspace } from "@/lib/types";

/**
 * The workspace for this request. Order of precedence:
 *  1. host-based workspace (subdomain) set by proxy.ts as x-workspace
 *  2. the signed-in user's workspace
 *  3. the demo workspace, so the terminal always has something to show
 */
export async function getCurrentWorkspace(): Promise<Workspace> {
  const h = await headers();
  const fromHost = getWorkspaceBySlug(h.get("x-workspace")) ?? getWorkspaceBySlug(resolveHost(h.get("host")).workspace);
  if (fromHost) return fromHost;
  const session = await getSession();
  return getWorkspaceBySlug(session?.workspace) ?? WORKSPACES[0];
}

/** Branding for the terminal on this request: a white-label custom domain wins, then the workspace's tenant. */
export async function getCurrentBranding(workspace: Workspace): Promise<TenantBranding> {
  const h = await headers();
  const hostTenantId = h.get("x-tenant") ?? resolveHost(h.get("host")).tenantId;
  return brandingFor(workspace, hostTenantId);
}
