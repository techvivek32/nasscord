import { TENANTS } from "@/lib/mock/tenants";
import { WORKSPACES } from "@/lib/mock/workspaces";
import { APP_DOMAIN, DEFAULT_BRANDING, hostFor, whiteLabelBranding } from "@/lib/branding";
import type { Tenant, TenantBranding, Workspace } from "@/lib/types";

/*
 * Host resolution and the lookups behind it. Reads the demo data, so it is for the proxy and server
 * code only; client components import the pure rules from lib/branding instead.
 */

export { APP_DOMAIN, DEFAULT_BRANDING, whiteLabelBranding };

/** Apex domains that mean "the platform itself", not a workspace or a tenant. */
export const PLATFORM_HOSTS = new Set([APP_DOMAIN, `www.${APP_DOMAIN}`, "localhost", "127.0.0.1"]);

/**
 * What the request host points at:
 *  - vivek.nasscord.com / vivek.localhost -> workspace "vivek"
 *  - trade.acmecap.com -> the white-label tenant whose branding.domain matches
 *  - nasscord.com / localhost -> neither (platform: marketing, signup, console)
 * Runs in the proxy and on the server: keep it free of Node-only APIs.
 */
export function resolveHost(hostHeader: string | null | undefined): { workspace: string | null; tenantId: string | null } {
  const none = { workspace: null, tenantId: null };
  if (!hostHeader) return none;
  const host = hostHeader.split(":")[0].toLowerCase();
  if (PLATFORM_HOSTS.has(host)) return none;

  const custom = TENANTS.find((t) => t.whiteLabel && t.branding?.domain?.toLowerCase() === host);
  if (custom) return { workspace: null, tenantId: custom.id };

  for (const base of [APP_DOMAIN.toLowerCase(), "localhost"]) {
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && sub !== "www" && !sub.includes(".")) return { workspace: sub, tenantId: null };
    }
  }
  return none;
}

export function getWorkspaceBySlug(slug: string | null | undefined): Workspace | null {
  if (!slug) return null;
  return WORKSPACES.find((w) => w.slug === slug) ?? null;
}

export function getTenantById(id: string | null | undefined): Tenant | null {
  if (!id) return null;
  return TENANTS.find((t) => t.id === id) ?? null;
}

/**
 * Branding the terminal wears: the white-label tenant the host points at, else the tenant the
 * workspace came through (when it has white-label), else Nasscord's own.
 */
export function brandingFor(workspace: Workspace | null, hostTenantId?: string | null): TenantBranding {
  return whiteLabelBranding(getTenantById(hostTenantId)) ?? whiteLabelBranding(getTenantById(workspace?.tenantId)) ?? DEFAULT_BRANDING;
}

/** Where a workspace's terminal lives: its white-label tenant's domain, else its own subdomain. */
export function workspaceHost(workspace: Workspace): string {
  return hostFor(workspace, getTenantById(workspace.tenantId));
}
