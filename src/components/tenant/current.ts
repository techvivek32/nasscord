"use client";

import * as React from "react";
import { useTenants, useWorkspaces } from "@/hooks/queries";
import type { Payout, Tenant, TenantBranding, Workspace } from "@/lib/types";
import { CURRENT_TENANT_ID, programFor, type TenantProgram } from "./program";
import { useTenantStore } from "./store";

export { CURRENT_TENANT_ID, REFERRAL_BASE_URL, PROGRAM } from "./program";

export interface CurrentTenant {
  tenant: Tenant | null;
  /** Payouts for this tenant, unsorted. */
  payouts: Payout[];
  /** Trader workspaces that came through this tenant, plus any added on the Traders page this session. */
  workspaces: Workspace[];
  /** The brand on file that this tenant's traders see. Null without white-label. Edits on the Branding page stay in the portal store. */
  branding: TenantBranding | null;
  program: TenantProgram | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Everything the portal shows is derived from the signed-in tenant. Swap CURRENT_TENANT_ID
 * for the session's tenantId when the auth provider carries one.
 */
export function useCurrentTenant(): CurrentTenant {
  const tenants = useTenants();
  const workspaces = useWorkspaces();
  const addedWorkspaces = useTenantStore((s) => s.addedWorkspaces);

  return React.useMemo(() => {
    const tenant = tenants.data?.tenants.find((t) => t.id === CURRENT_TENANT_ID) ?? null;
    const program = tenant ? programFor(tenant, tenants.data?.payouts ?? []) : null;
    const own = (workspaces.data ?? []).filter((w) => w.tenantId === CURRENT_TENANT_ID);
    const branding = tenant?.whiteLabel ? (tenant.branding ?? null) : null;
    return {
      tenant,
      payouts: program?.payouts ?? [],
      workspaces: [...own, ...addedWorkspaces],
      branding,
      program,
      isLoading: tenants.isLoading || workspaces.isLoading,
      isError: tenants.isError || workspaces.isError,
    };
  }, [tenants.data, tenants.isLoading, tenants.isError, workspaces.data, workspaces.isLoading, workspaces.isError, addedWorkspaces]);
}

/** "White-label tenant" or "Commission tenant": how the header and the sidebar name this tenant. */
export function tenantKindLabel(tenant: Pick<Tenant, "whiteLabel">) {
  return tenant.whiteLabel ? "White-label tenant" : "Commission tenant";
}

/**
 * Where a workspace's traders sign in: the tenant's white-label domain when it has one, else the
 * workspace's own subdomain. Same rule as lib/tenant `workspaceHost`, but takes the branding and the
 * app domain as arguments so lib/tenant (and the mock data it imports) stays off the client.
 */
export function hostFor(workspace: Pick<Workspace, "slug">, branding: TenantBranding | null, appDomain: string) {
  return branding?.domain || `${workspace.slug}.${appDomain}`;
}
