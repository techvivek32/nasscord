"use client";

import { create } from "zustand";
import type { TenantBranding, Workspace } from "@/lib/types";
import type { ReferralCode } from "./program";

/* ------------------------------------------------------------------
   Tenant portal client state. Local overrides on top of the mock data so
   every dialog, switch and form reacts immediately and survives navigation
   between portal pages. Nothing here outlives the browser session.
   Each setter maps to one mutation later.
   ------------------------------------------------------------------ */

export type TenantPlanId = "basic" | "plus" | "desk";
export type PlanFeatureKey = "tradescope" | "orderEngine" | "options" | "extendedHours" | "sharedWatchlists" | "prioritySupport";

export interface TenantPlanRow {
  name: string;
  monthly: number;
  seats: string;
  features: Record<PlanFeatureKey, boolean>;
}
export type TenantPlanMatrix = Record<TenantPlanId, TenantPlanRow>;

export const PLAN_FEATURES: Array<{ key: PlanFeatureKey; label: string; help: string }> = [
  { key: "tradescope", label: "TradeScope alerts", help: "Real-time alerts, 44 symbols on 15m bars." },
  { key: "orderEngine", label: "Verified order engine", help: "Brackets, stops and fill verification." },
  { key: "options", label: "Options desk", help: "Chains, presets and contract sizing." },
  { key: "extendedHours", label: "Extended hours", help: "Pre-market and after-hours orders." },
  { key: "sharedWatchlists", label: "Shared watchlists", help: "Team lists and alert sharing." },
  { key: "prioritySupport", label: "Priority support", help: "Same-day replies from your support desk." },
];

/** Current seat mix on the tenant's trader workspaces. 10 + 24 + 4 = 38 seats, matching the Acme workspace. */
export const SEAT_MIX: Record<TenantPlanId, number> = { basic: 10, plus: 24, desk: 4 };

export function defaultPlanMatrix(): TenantPlanMatrix {
  return {
    basic: {
      name: "Basic",
      monthly: 40,
      seats: "1 seat",
      features: { tradescope: true, orderEngine: false, options: false, extendedHours: false, sharedWatchlists: false, prioritySupport: false },
    },
    plus: {
      name: "Plus",
      monthly: 90,
      seats: "1 seat",
      features: { tradescope: true, orderEngine: true, options: true, extendedHours: true, sharedWatchlists: false, prioritySupport: false },
    },
    desk: {
      name: "Desk",
      monthly: 390,
      seats: "Up to 5 seats",
      features: { tradescope: true, orderEngine: true, options: true, extendedHours: true, sharedWatchlists: true, prioritySupport: true },
    },
  };
}

export interface PayoutMethod {
  bank: string;
  holder: string;
  last4: string;
}

export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  last4: string;
  scope: "read" | "trade";
  createdAt: string;
  lastUsedAt?: string;
}

export interface Contacts {
  primaryName: string;
  primaryEmail: string;
  billingEmail: string;
  technicalEmail: string;
  phone: string;
}

export type NotificationKey = "payoutSent" | "newConversion" | "traderPastDue" | "domainChanges" | "weeklyDigest";

/** The tenant's white-label branding as edited in the portal, plus the logo text the portal adds. */
export interface SavedBranding extends TenantBranding {
  logoText: string;
}

interface TenantPortalState {
  createdCodes: ReferralCode[];
  codeActive: Record<string, boolean>;
  /** Trader workspaces created from the Traders page this session. */
  addedWorkspaces: Workspace[];
  planMatrix: TenantPlanMatrix;
  publishedMatrix: TenantPlanMatrix;
  publishedAt: string | null;
  payoutMethod: PayoutMethod;
  apiKeys: ApiKey[];
  contacts: Contacts;
  notifications: Record<NotificationKey, boolean>;
  branding: SavedBranding | null;
  verifiedDomains: string[];
  /** When this tenant asked Nasscord to turn on white-label. Only the super admin can grant it. */
  whiteLabelRequestedAt: string | null;

  addCode: (code: ReferralCode) => void;
  setCodeActive: (code: string, active: boolean) => void;
  addWorkspace: (workspace: Workspace) => void;
  setPlanPrice: (plan: TenantPlanId, monthly: number) => void;
  setPlanFeature: (plan: TenantPlanId, key: PlanFeatureKey, on: boolean) => void;
  resetPlans: () => void;
  publishPlans: () => void;
  setPayoutMethod: (m: PayoutMethod) => void;
  rotateKey: (id: string) => ApiKey;
  setContacts: (c: Contacts) => void;
  setNotification: (key: NotificationKey, on: boolean) => void;
  saveBranding: (b: SavedBranding) => void;
  markDomainVerified: (domain: string) => void;
  requestWhiteLabel: () => void;
}

function randomHex(len: number) {
  const alphabet = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export const useTenantStore = create<TenantPortalState>((set, get) => ({
  createdCodes: [],
  codeActive: {},
  addedWorkspaces: [],
  planMatrix: defaultPlanMatrix(),
  publishedMatrix: defaultPlanMatrix(),
  publishedAt: "2026-08-01T14:00:00Z",
  payoutMethod: { bank: "Chase Business Checking", holder: "Acme Capital LLC", last4: "4412" },
  apiKeys: [
    { id: "key_report", label: "Reporting (read-only)", prefix: "nsk_ro", last4: "7c2e", scope: "read", createdAt: "2026-03-04T09:30:00Z", lastUsedAt: "2026-09-30T16:10:00Z" },
    { id: "key_sso", label: "SSO provisioning", prefix: "nsk_ro", last4: "91af", scope: "read", createdAt: "2026-06-18T12:00:00Z", lastUsedAt: "2026-09-29T08:02:00Z" },
  ],
  contacts: {
    primaryName: "Dana Whitfield",
    primaryEmail: "dana@acmecap.com",
    billingEmail: "ap@acmecap.com",
    technicalEmail: "platform@acmecap.com",
    phone: "+1 (312) 555-0148",
  },
  notifications: { payoutSent: true, newConversion: true, traderPastDue: true, domainChanges: true, weeklyDigest: false },
  branding: null,
  verifiedDomains: ["trade.acmecap.com"],
  whiteLabelRequestedAt: null,

  addCode: (code) => set((s) => ({ createdCodes: [code, ...s.createdCodes] })),
  setCodeActive: (code, active) => set((s) => ({ codeActive: { ...s.codeActive, [code]: active } })),
  addWorkspace: (workspace) => set((s) => ({ addedWorkspaces: [...s.addedWorkspaces, workspace] })),
  setPlanPrice: (plan, monthly) => set((s) => ({ planMatrix: { ...s.planMatrix, [plan]: { ...s.planMatrix[plan], monthly } } })),
  setPlanFeature: (plan, key, on) =>
    set((s) => ({ planMatrix: { ...s.planMatrix, [plan]: { ...s.planMatrix[plan], features: { ...s.planMatrix[plan].features, [key]: on } } } })),
  resetPlans: () => set((s) => ({ planMatrix: structuredClone(s.publishedMatrix) })),
  publishPlans: () => set((s) => ({ publishedMatrix: structuredClone(s.planMatrix), publishedAt: new Date().toISOString() })),
  setPayoutMethod: (payoutMethod) => set({ payoutMethod }),
  rotateKey: (id) => {
    const prev = get().apiKeys.find((k) => k.id === id);
    const next: ApiKey = {
      id,
      label: prev?.label ?? "API key",
      prefix: prev?.prefix ?? "nsk_ro",
      last4: randomHex(4),
      scope: prev?.scope ?? "read",
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ apiKeys: s.apiKeys.map((k) => (k.id === id ? next : k)) }));
    return next;
  },
  setContacts: (contacts) => set({ contacts }),
  setNotification: (key, on) => set((s) => ({ notifications: { ...s.notifications, [key]: on } })),
  saveBranding: (branding) => set({ branding }),
  markDomainVerified: (domain) => set((s) => ({ verifiedDomains: s.verifiedDomains.includes(domain) ? s.verifiedDomains : [...s.verifiedDomains, domain] })),
  requestWhiteLabel: () => set((s) => ({ whiteLabelRequestedAt: s.whiteLabelRequestedAt ?? new Date().toISOString() })),
}));

/** Full key text, shown once right after a rotation. The demo makes the secret part up. */
export function fullKeyText(key: ApiKey) {
  return `${key.prefix}_${randomHex(24)}${key.last4}`;
}

export function maskedKey(key: ApiKey) {
  return `${key.prefix}_••••••••••••${key.last4}`;
}
