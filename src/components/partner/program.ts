import { getPlan, REFERRAL_SHARE_PCT } from "@/lib/plans";
import { round2 } from "@/lib/engine";
import type { Partner, Payout, PlanId } from "@/lib/types";

/* ------------------------------------------------------------------
   Partner program data that lib/mock does not carry yet: the referral
   funnel, referral codes, recent conversions and the payout history of
   the signed-in partner. Everything is deterministic and derived from
   lib/plans prices so the numbers agree with the rest of the app.
   When the backend lands, fetchPartnerProgram(partnerId) replaces this.
   ------------------------------------------------------------------ */

export const CURRENT_PARTNER_ID = "p_acme";
export const REFERRAL_BASE_URL = "https://nasscord.com/?ref=";

/** Program constants shown on the partner pages. Source: lib/plans PARTNER_MODELS copy. */
export const PROGRAM = {
  /** Standard referral commission on nasscord.com subscriptions. */
  referralShare: REFERRAL_SHARE_PCT,
  /** Day of the month commissions are paid by ACH. */
  payoutDay: 5,
  /** Payouts under this amount roll into the next month. */
  minimumPayout: 100,
  /** White-label platform fee, per month. */
  platformFee: 999,
  /** White-label per-seat fee, per month. */
  perSeat: 12,
} as const;

export interface ReferralCode {
  code: string;
  label: string;
  clicks: number;
  signups: number;
  paid: number;
  createdAt: string;
  active: boolean;
}

export interface Conversion {
  id: string;
  /** Full name; the UI masks it to the first letter. */
  name: string;
  plan: PlanId;
  billing: "monthly" | "yearly";
  at: string;
}

export interface Funnel {
  clicks: number;
  signups: number;
  trials: number;
  paid: number;
}

export interface PartnerProgram {
  funnel: Funnel;
  codes: ReferralCode[];
  conversions: Conversion[];
  payouts: Payout[];
  /** Monthly subscription revenue of the referred accounts that are paying today. */
  attributedMrr: number;
  /** Commission percent applied to attributedMrr. */
  share: number;
}

/**
 * White-label partners carry revShare 0 on their record because tenant revenue is not shared;
 * traders they send to nasscord.com through their referral link still earn the standard commission.
 */
export function shareFor(partner: Partner) {
  return partner.revShare > 0 ? partner.revShare : PROGRAM.referralShare;
}

export function maskName(name: string) {
  const first = name.trim().charAt(0).toUpperCase();
  return first ? `${first}•••` : "•••";
}

/** Commission earned per month on one conversion. */
export function conversionShare(c: Conversion, share: number) {
  const plan = getPlan(c.plan);
  const price = (c.billing === "yearly" ? plan.yearly : plan.monthly) ?? 0;
  return round2((price * share) / 100);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 2026" -> Date(2026-09-01T00:00Z) */
export function periodStart(period: string): Date {
  const [mon, year] = period.split(" ");
  const m = Math.max(0, MONTHS.indexOf(mon));
  return new Date(Date.UTC(Number(year), m, 1));
}

/** A period pays on PROGRAM.payoutDay of the following month. */
export function payoutDateFor(period: string): string {
  const d = periodStart(period);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, PROGRAM.payoutDay)).toISOString();
}

export function periodShort(period: string) {
  return period.split(" ")[0];
}

export function sortByPeriod(payouts: Payout[]) {
  return [...payouts].sort((a, b) => periodStart(a.period).getTime() - periodStart(b.period).getTime());
}

/* ---------------- Acme Capital (p_acme) ---------------- */

const ACME_CODES: ReferralCode[] = [
  { code: "ACME", label: "Default link", clicks: 842, signups: 141, paid: 31, createdAt: "2026-03-01T00:00:00Z", active: true },
  { code: "ACME-PODCAST", label: "Desk Talk podcast", clicks: 267, signups: 43, paid: 9, createdAt: "2026-05-12T00:00:00Z", active: true },
  { code: "ACME-WEBINAR", label: "Monthly options webinar", clicks: 118, signups: 19, paid: 4, createdAt: "2026-07-02T00:00:00Z", active: true },
  { code: "ACME-SPRING", label: "Spring promo (ended)", clicks: 57, signups: 9, paid: 2, createdAt: "2026-03-20T00:00:00Z", active: false },
];

const ACME_CONVERSIONS: Conversion[] = [
  { id: "cv_1", name: "Jordan Meyer", plan: "pro", billing: "monthly", at: "2026-09-30T15:40:00Z" },
  { id: "cv_2", name: "Priya Sethi", plan: "desk", billing: "monthly", at: "2026-09-30T11:05:00Z" },
  { id: "cv_3", name: "Marcus Tran", plan: "pro", billing: "yearly", at: "2026-09-29T20:12:00Z" },
  { id: "cv_4", name: "Elena Ruiz", plan: "starter", billing: "monthly", at: "2026-09-29T14:30:00Z" },
  { id: "cv_5", name: "Tom Adler", plan: "pro", billing: "monthly", at: "2026-09-28T17:55:00Z" },
  { id: "cv_6", name: "Grace Kim", plan: "desk", billing: "yearly", at: "2026-09-27T13:20:00Z" },
  { id: "cv_7", name: "Noah Brandt", plan: "pro", billing: "monthly", at: "2026-09-26T09:48:00Z" },
  { id: "cv_8", name: "Helen Zhou", plan: "pro", billing: "monthly", at: "2026-09-25T16:02:00Z" },
];

/** 38 Pro monthly ($49) + 5 Desk monthly ($149) + 3 Pro yearly ($39) = $2,724 attributed MRR; 25% = $681. */
const ACME_ATTRIBUTED_MRR = 38 * 49 + 5 * 149 + 3 * 39;

const ACME_PAYOUTS: Payout[] = [
  { id: "po_acme_apr", partnerId: "p_acme", period: "Apr 2026", amount: 318.5, status: "paid", paidAt: "2026-05-05T00:00:00Z" },
  { id: "po_acme_may", partnerId: "p_acme", period: "May 2026", amount: 402.25, status: "paid", paidAt: "2026-06-05T00:00:00Z" },
  { id: "po_acme_jun", partnerId: "p_acme", period: "Jun 2026", amount: 465.75, status: "paid", paidAt: "2026-07-05T00:00:00Z" },
  { id: "po_acme_jul", partnerId: "p_acme", period: "Jul 2026", amount: 521.5, status: "paid", paidAt: "2026-08-05T00:00:00Z" },
  { id: "po_acme_aug", partnerId: "p_acme", period: "Aug 2026", amount: 604.25, status: "paid", paidAt: "2026-09-05T00:00:00Z" },
  { id: "po_acme_sep", partnerId: "p_acme", period: "Sep 2026", amount: round2((ACME_ATTRIBUTED_MRR * PROGRAM.referralShare) / 100), status: "scheduled" },
];

const ACME_PROGRAM: PartnerProgram = {
  funnel: { clicks: 1_284, signups: 212, trials: 96, paid: 46 },
  codes: ACME_CODES,
  conversions: ACME_CONVERSIONS,
  payouts: ACME_PAYOUTS,
  attributedMrr: ACME_ATTRIBUTED_MRR,
  share: PROGRAM.referralShare,
};

/**
 * Program view for any partner. Acme has a hand-written history; other partners get a
 * funnel scaled from their record and the payouts the platform already holds for them.
 */
export function programFor(partner: Partner, platformPayouts: Payout[]): PartnerProgram {
  if (partner.id === CURRENT_PARTNER_ID) return ACME_PROGRAM;

  const paid = partner.tenants;
  const share = shareFor(partner);
  const own = platformPayouts.filter((p) => p.partnerId === partner.id);
  const payouts = own.length
    ? own
    : partner.mtdPayout > 0
      ? [{ id: `po_${partner.id}_cur`, partnerId: partner.id, period: "Sep 2026", amount: partner.mtdPayout, status: "scheduled" as const }]
      : [];

  return {
    funnel: { clicks: Math.round(paid * 27.9), signups: Math.round(paid * 4.6), trials: Math.round(paid * 2.1), paid },
    codes: [{ code: partner.referralCode, label: "Default link", clicks: Math.round(paid * 27.9), signups: Math.round(paid * 4.6), paid, createdAt: partner.createdAt, active: partner.status === "active" }],
    conversions: [],
    payouts,
    attributedMrr: partner.mtdRevenue,
    share,
  };
}
