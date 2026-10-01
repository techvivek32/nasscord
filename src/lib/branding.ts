import type { Tenant, TenantBranding, Workspace } from "@/lib/types";

/* ------------------------------------------------------------------
   Branding and host rules. Pure (no mock data), so client components
   can import them; lib/tenant.ts adds the lookups that need data.
   ------------------------------------------------------------------ */

export const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "nasscord.com";

export const DEFAULT_BRANDING: TenantBranding = {
  name: "Nasscord",
  accent: "#2451E6",
  accentDark: "#5B7CFF",
};

/** A tenant's brand, but only once the super admin has granted it white-label. */
export function whiteLabelBranding(tenant: Tenant | null | undefined): TenantBranding | null {
  return tenant?.whiteLabel && tenant.branding ? tenant.branding : null;
}

/** Where a workspace's terminal lives: its white-label tenant's domain, else its own subdomain. */
export function hostFor(workspace: Pick<Workspace, "slug">, tenant: Tenant | null | undefined): string {
  return whiteLabelBranding(tenant)?.domain ?? `${workspace.slug}.${APP_DOMAIN}`;
}
