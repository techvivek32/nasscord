import { headers } from "next/headers";
import { getTenantBySlug, resolveTenantSlug } from "@/lib/tenant";
import { getSession } from "@/lib/auth";
import { TENANTS } from "@/lib/mock/tenants";
import type { Tenant } from "@/lib/types";

/**
 * The tenant for this request. Order of precedence:
 *  1. host-based tenant (subdomain / custom domain) set by proxy.ts as x-tenant
 *  2. the signed-in user's tenant
 *  3. the demo tenant, so the terminal always has something to show
 */
export async function getCurrentTenant(): Promise<Tenant> {
  const h = await headers();
  const fromHeader = getTenantBySlug(h.get("x-tenant")) ?? getTenantBySlug(resolveTenantSlug(h.get("host")));
  if (fromHeader) return fromHeader;
  const session = await getSession();
  const fromSession = getTenantBySlug(session?.tenant);
  return fromSession ?? TENANTS[0];
}
