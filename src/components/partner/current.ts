"use client";

import * as React from "react";
import { usePartners, useTenants } from "@/hooks/queries";
import type { Partner, Payout, Tenant } from "@/lib/types";
import { CURRENT_PARTNER_ID, programFor, type PartnerProgram } from "./program";
import { usePartnerStore } from "./store";

export { CURRENT_PARTNER_ID, REFERRAL_BASE_URL, PROGRAM } from "./program";

export interface CurrentPartner {
  partner: Partner | null;
  /** Payouts for this partner, unsorted. */
  payouts: Payout[];
  /** White-label tenants that belong to this partner, plus any added locally this session. */
  tenants: Tenant[];
  program: PartnerProgram | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Everything the portal shows is derived from the signed-in partner. Swap CURRENT_PARTNER_ID
 * for the session's partner id when the auth provider carries one.
 */
export function useCurrentPartner(): CurrentPartner {
  const partners = usePartners();
  const tenants = useTenants();
  const addedTenants = usePartnerStore((s) => s.addedTenants);

  return React.useMemo(() => {
    const partner = partners.data?.partners.find((p) => p.id === CURRENT_PARTNER_ID) ?? null;
    const program = partner ? programFor(partner, partners.data?.payouts ?? []) : null;
    const own = (tenants.data ?? []).filter((t) => t.partnerId === CURRENT_PARTNER_ID);
    return {
      partner,
      payouts: program?.payouts ?? [],
      tenants: [...own, ...addedTenants],
      program,
      isLoading: partners.isLoading || tenants.isLoading,
      isError: partners.isError || tenants.isError,
    };
  }, [partners.data, partners.isLoading, partners.isError, tenants.data, tenants.isLoading, tenants.isError, addedTenants]);
}

export function isWhiteLabel(partner: Partner | null) {
  return partner?.model === "white_label";
}
