import { cache } from "react";
import { cookies } from "next/headers";
import { getMyTenant, PORTAL_TENANT_COOKIE, tenantScope } from "@/lib/server/tenant";
import { emailLinkBase } from "@/lib/server/request";
import type { Session, Tenant } from "@/lib/types";

/*
 * The tenant this portal request is about, resolved once per request on the server. A tenant login
 * sees its own tenant. The super admin sees the tenant they chose with "View portal" on the
 * console's Tenants page (a cookie), else the one their members row names, if any; otherwise the
 * pages say where to choose one.
 */

if (typeof window !== "undefined") throw new Error("src/components/tenant/scope.ts is server only.");

export const loadPortal = cache(async (): Promise<{ session: Session; tenant: Tenant | null }> => {
  const { session } = await tenantScope();
  if (session.role !== "superadmin") return { session, tenant: await getMyTenant() };
  const picked = (await cookies()).get(PORTAL_TENANT_COOKIE)?.value ?? session.tenantId ?? null;
  return { session, tenant: await getMyTenant(picked) };
});

/** The link a trader opens to sign up with the tenant's code, or null without a code. */
export async function referralLink(tenant: Pick<Tenant, "referralCode">): Promise<string | null> {
  if (!tenant.referralCode) return null;
  return `${await emailLinkBase()}/signup?code=${encodeURIComponent(tenant.referralCode)}`;
}

/** "White-label tenant" or "Commission tenant": how the header and the sidebar name this tenant. */
export function tenantKindLabel(tenant: Pick<Tenant, "whiteLabel">) {
  return tenant.whiteLabel ? "White-label tenant" : "Commission tenant";
}
