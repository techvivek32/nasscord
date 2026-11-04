import { cache } from "react";
import { DEFAULT_BRANDING, whiteLabelBranding } from "@/lib/branding";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { TENANT_COLUMNS, toTenant, type TenantRow } from "@/lib/server/rows";
import type { Tenant, TenantBranding } from "@/lib/types";

/*
 * Tenant lookups that need the database. Server only (service role, read-only).
 * Pure host parsing lives in src/lib/tenant.ts; the current workspace and its branding are in
 * src/lib/server/workspace.ts.
 */

if (typeof window !== "undefined") throw new Error("src/lib/tenant-server.ts is server only.");

type MaybeRow = PromiseLike<{ data: unknown; error: { code?: string } | null }>;

async function oneTenant(query: () => MaybeRow): Promise<Tenant | null> {
  if (!isAdminConfigured()) return null;
  const { data, error } = await query();
  if (error) {
    console.error(`[tenant] lookup failed: ${error.code ?? "unknown error"}`);
    return null;
  }
  return data ? toTenant(data as TenantRow) : null;
}

export const getTenantById = cache(async (id: string | null | undefined): Promise<Tenant | null> => {
  if (!id) return null;
  return oneTenant(() => createAdminClient().from("tenants").select(TENANT_COLUMNS).eq("id", id).maybeSingle());
});

/** The white-label tenant whose branding.domain is this host. */
export const getTenantByDomain = cache(async (domain: string | null | undefined): Promise<Tenant | null> => {
  if (!domain) return null;
  return oneTenant(() =>
    createAdminClient().from("tenants").select(TENANT_COLUMNS).eq("white_label", true).eq("branding->>domain", domain.toLowerCase()).limit(1).maybeSingle(),
  );
});

/** The active tenant a signup code points at. Codes are stored upper case. */
export const getTenantByReferralCode = cache(async (code: string | null | undefined): Promise<Tenant | null> => {
  const clean = normalizeTenantCode(code);
  if (!clean) return null;
  return oneTenant(() => createAdminClient().from("tenants").select(TENANT_COLUMNS).eq("referral_code", clean).eq("status", "active").maybeSingle());
});

/** "acme " -> "ACME"; null when it cannot be a referral code (tenants.referral_code check). */
export function normalizeTenantCode(code: string | null | undefined): string | null {
  const clean = code?.trim().toUpperCase();
  return clean && /^[A-Z0-9-]{3,24}$/.test(clean) ? clean : null;
}

/**
 * Branding the terminal wears: the white-label tenant whose custom domain this is, else the white-label
 * tenant the workspace came through, else Nasscord's own.
 */
export async function brandingFor(input: { workspaceTenantId?: string | null; hostDomain?: string | null }): Promise<TenantBranding> {
  const [hostTenant, workspaceTenant] = await Promise.all([getTenantByDomain(input.hostDomain), getTenantById(input.workspaceTenantId)]);
  return whiteLabelBranding(hostTenant) ?? whiteLabelBranding(workspaceTenant) ?? DEFAULT_BRANDING;
}
