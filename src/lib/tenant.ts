import { APP_DOMAIN, DEFAULT_BRANDING, hostFor, whiteLabelBranding } from "@/lib/branding";

/*
 * Host parsing. Pure (no data, no Node-only APIs), so the proxy, the server and client code can all
 * import it. Lookups that need the database live in src/lib/tenant-server.ts (server only).
 */

export { APP_DOMAIN, DEFAULT_BRANDING, hostFor, whiteLabelBranding };

/** Apex domains that mean "the platform itself", not a workspace or a tenant. */
export const PLATFORM_HOSTS = new Set([APP_DOMAIN.toLowerCase(), `www.${APP_DOMAIN.toLowerCase()}`, "localhost", "127.0.0.1"]);

/** Vercel preview and production hosts are the platform too. */
function isPlatformHost(host: string) {
  return PLATFORM_HOSTS.has(host) || host.endsWith(".vercel.app");
}

export interface HostInfo {
  /** Subdomain of the app domain (or of localhost): the workspace slug it names. */
  workspace: string | null;
  /** A host that is neither the platform nor one of its subdomains: a possible white-label custom domain. */
  tenantDomain: string | null;
}

/**
 * What the request host points at, from its shape alone:
 *  - vivek.nasscord.com / vivek.localhost -> workspace "vivek"
 *  - trade.acmecap.com -> tenantDomain "trade.acmecap.com" (src/lib/tenant-server.ts finds the tenant)
 *  - nasscord.com / localhost / *.vercel.app -> neither (platform: marketing, signup, console)
 */
export function resolveHost(hostHeader: string | null | undefined): HostInfo {
  const none: HostInfo = { workspace: null, tenantDomain: null };
  if (!hostHeader) return none;
  const host = hostHeader.split(":")[0].trim().toLowerCase();
  if (!host || isPlatformHost(host)) return none;

  for (const base of [APP_DOMAIN.toLowerCase(), "localhost"]) {
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && sub !== "www" && !sub.includes(".") && /^[a-z0-9-]+$/.test(sub)) return { workspace: sub, tenantDomain: null };
      return none;
    }
  }
  // An IP address is never a tenant domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes("[")) return none;
  return { workspace: null, tenantDomain: host };
}
