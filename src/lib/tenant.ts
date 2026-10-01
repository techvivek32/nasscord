import { TENANTS } from "@/lib/mock/tenants";
import type { Tenant, TenantBranding } from "@/lib/types";

/** Apex domains that mean "the platform itself", not a tenant. */
export const PLATFORM_HOSTS = new Set([
  process.env.NEXT_PUBLIC_APP_DOMAIN ?? "nasscord.com",
  `www.${process.env.NEXT_PUBLIC_APP_DOMAIN ?? "nasscord.com"}`,
  "localhost",
  "127.0.0.1",
]);

/**
 * Tenant resolution from the request host.
 *  - vivek.nasscord.com  -> "vivek"
 *  - vivek.localhost     -> "vivek" (local dev)
 *  - trade.acmecap.com   -> the tenant whose branding.domain matches
 *  - nasscord.com / localhost -> null (platform: marketing, signup, console)
 * Runs in the proxy (edge) and on the server: keep it free of Node-only APIs.
 */
export function resolveTenantSlug(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.split(":")[0].toLowerCase();
  if (PLATFORM_HOSTS.has(host)) return null;

  const custom = TENANTS.find((t) => t.branding?.domain && t.branding.domain.toLowerCase() === host);
  if (custom) return custom.slug;

  const apex = (process.env.NEXT_PUBLIC_APP_DOMAIN ?? "nasscord.com").toLowerCase();
  for (const base of [apex, "localhost"]) {
    if (host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && sub !== "www" && !sub.includes(".")) return sub;
    }
  }
  return null;
}

export function getTenantBySlug(slug: string | null | undefined): Tenant | null {
  if (!slug) return null;
  return TENANTS.find((t) => t.slug === slug) ?? null;
}

export const DEFAULT_BRANDING: TenantBranding = {
  name: "Nasscord",
  accent: "#2451E6",
  accentDark: "#5B7CFF",
};

export function brandingFor(tenant: Tenant | null): TenantBranding {
  if (tenant?.whiteLabel && tenant.branding) return tenant.branding;
  return DEFAULT_BRANDING;
}
