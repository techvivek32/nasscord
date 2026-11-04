import { z } from "zod";
import type { Tenant, TenantBranding, Workspace } from "@/lib/types";

/* ------------------------------------------------------------------
   Branding and host rules, and the branding form schema. Pure, so client components
   can import them; src/lib/tenant-server.ts adds the lookups that need the database.
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

/** TenantBranding as stored in tenants.branding. The domain is stored lower case. */
export const brandingSchema = z.object({
  name: z.string().trim().min(2, "Enter the brand name").max(60, "Keep the name under 60 characters"),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #2451E6"),
  accentDark: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #5B7CFF"),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Use a domain like trade.yourfirm.com")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  supportEmail: z.email("Enter a valid support email").optional().or(z.literal("").transform(() => undefined)),
});
export type BrandingInput = z.input<typeof brandingSchema>;
