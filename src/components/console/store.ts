"use client";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { ENGINE_DEFAULTS, UNIVERSE } from "@/lib/engine";
import { PLANS } from "@/lib/plans";
import type { BrokerId, EngineParams, Partner, PlanId, Role, Tenant, TenantFeatures, TenantStatus, User } from "@/lib/types";

/* ------------------------------------------------------------------
   Operator console client state. Everything here is a local override on
   top of the mock data, so every switch, approve button and plan edit
   reacts immediately without a backend. The real console will replace
   each setter with a mutation and drop the override maps.
   ------------------------------------------------------------------ */

export interface PlanMatrixRow {
  monthly: number | null;
  yearly: number | null;
  brokers: string;
  seats: string;
  realtimeAlerts: boolean;
  orderEngine: boolean;
  optionsDesk: boolean;
  whiteLabel: boolean;
  prioritySupport: boolean;
}
export type PlanMatrix = Record<PlanId, PlanMatrixRow>;

export interface WhiteLabelOverride {
  enabled?: boolean;
  brandName?: string;
  domain?: string;
  accent?: string;
}

export type PartnerDecision = "approved" | "declined";

function defaultPlanMatrix(): PlanMatrix {
  const out = {} as PlanMatrix;
  for (const p of PLANS) {
    out[p.id] = {
      monthly: p.monthly,
      yearly: p.yearly,
      brokers: p.limits.brokers === "unlimited" ? "Unlimited" : String(p.limits.brokers),
      seats: p.limits.seats === "unlimited" ? "Unlimited" : p.id === "desk" ? "Up to 5" : String(p.limits.seats),
      realtimeAlerts: p.limits.alertDelayMin === 0,
      orderEngine: p.id !== "starter",
      optionsDesk: p.id !== "starter",
      whiteLabel: p.id === "enterprise",
      prioritySupport: p.id === "desk" || p.id === "enterprise",
    };
  }
  return out;
}

/** Planned brokers ship disabled for tenants until an integration is live. */
const DEFAULT_BROKER_ENABLED: Record<BrokerId, boolean> = {
  ibkr: true,
  schwab: true,
  etrade: true,
  tastytrade: true,
  tradier: true,
  alpaca: true,
  tradestation: true,
  webull: true,
  fidelity: true,
  robinhood: true,
  moomoo: false,
  public: false,
};

interface ConsoleState {
  maintenanceOn: boolean;
  setMaintenance: (on: boolean) => void;

  tenantStatus: Record<string, TenantStatus>;
  setTenantStatus: (id: string, status: TenantStatus) => void;
  tenantPlan: Record<string, PlanId>;
  setTenantPlan: (id: string, plan: PlanId) => void;
  tenantFeatures: Record<string, Partial<TenantFeatures>>;
  setTenantFeature: (id: string, key: keyof TenantFeatures, value: boolean) => void;
  tenantWhiteLabel: Record<string, WhiteLabelOverride>;
  setTenantWhiteLabel: (id: string, patch: WhiteLabelOverride) => void;
  tenantLimits: Record<string, { seatLimit?: number; brokerLimit?: number }>;
  setTenantLimits: (id: string, patch: { seatLimit?: number; brokerLimit?: number }) => void;

  brokerEnabled: Record<BrokerId, boolean>;
  setBrokerEnabled: (id: BrokerId, on: boolean) => void;

  partnerDecisions: Record<string, PartnerDecision>;
  decidePartner: (applicationId: string, decision: PartnerDecision) => void;
  addedPartners: Partner[];
  addPartner: (p: Partner) => void;

  invitedUsers: User[];
  addUser: (u: User) => void;
  removedUserIds: string[];
  removeUser: (id: string) => void;
  userRoles: Record<string, Role>;
  setUserRole: (id: string, role: Role) => void;
  reset2fa: string[];
  markReset2fa: (id: string) => void;

  planMatrix: PlanMatrix;
  setPlanMatrix: (patch: (m: PlanMatrix) => PlanMatrix) => void;
  planMatrixSavedAt?: string;
  savePlanMatrix: () => void;

  engineParams: EngineParams;
  setEngineParams: (p: EngineParams) => void;
  universe: string[];
  setUniverse: (symbols: string[]) => void;

  restartedAt: Record<string, string>;
  markRestarted: (serviceId: string) => void;
}

export const useConsoleStore = create<ConsoleState>()((set) => ({
  maintenanceOn: false,
  setMaintenance: (on) => set({ maintenanceOn: on }),

  tenantStatus: {},
  setTenantStatus: (id, status) => set((s) => ({ tenantStatus: { ...s.tenantStatus, [id]: status } })),
  tenantPlan: {},
  setTenantPlan: (id, plan) => set((s) => ({ tenantPlan: { ...s.tenantPlan, [id]: plan } })),
  tenantFeatures: {},
  setTenantFeature: (id, key, value) =>
    set((s) => ({ tenantFeatures: { ...s.tenantFeatures, [id]: { ...s.tenantFeatures[id], [key]: value } } })),
  tenantWhiteLabel: {},
  setTenantWhiteLabel: (id, patch) =>
    set((s) => ({ tenantWhiteLabel: { ...s.tenantWhiteLabel, [id]: { ...s.tenantWhiteLabel[id], ...patch } } })),
  tenantLimits: {},
  setTenantLimits: (id, patch) => set((s) => ({ tenantLimits: { ...s.tenantLimits, [id]: { ...s.tenantLimits[id], ...patch } } })),

  brokerEnabled: DEFAULT_BROKER_ENABLED,
  setBrokerEnabled: (id, on) => set((s) => ({ brokerEnabled: { ...s.brokerEnabled, [id]: on } })),

  partnerDecisions: {},
  decidePartner: (applicationId, decision) => set((s) => ({ partnerDecisions: { ...s.partnerDecisions, [applicationId]: decision } })),
  addedPartners: [],
  addPartner: (p) => set((s) => ({ addedPartners: [p, ...s.addedPartners] })),

  invitedUsers: [],
  addUser: (u) => set((s) => ({ invitedUsers: [u, ...s.invitedUsers] })),
  removedUserIds: [],
  removeUser: (id) => set((s) => ({ removedUserIds: [...s.removedUserIds, id] })),
  userRoles: {},
  setUserRole: (id, role) => set((s) => ({ userRoles: { ...s.userRoles, [id]: role } })),
  reset2fa: [],
  markReset2fa: (id) => set((s) => ({ reset2fa: s.reset2fa.includes(id) ? s.reset2fa : [...s.reset2fa, id] })),

  planMatrix: defaultPlanMatrix(),
  setPlanMatrix: (patch) => set((s) => ({ planMatrix: patch(s.planMatrix) })),
  planMatrixSavedAt: undefined,
  savePlanMatrix: () => set({ planMatrixSavedAt: new Date().toISOString() }),

  engineParams: ENGINE_DEFAULTS,
  setEngineParams: (p) => set({ engineParams: p }),
  universe: UNIVERSE,
  setUniverse: (symbols) => set((s) => ({ universe: symbols, engineParams: { ...s.engineParams, universeSize: symbols.length } })),

  restartedAt: {},
  markRestarted: (serviceId) => set((s) => ({ restartedAt: { ...s.restartedAt, [serviceId]: new Date().toISOString() } })),
}));

/** Apply the operator's local overrides to a tenant record from the API. */
export function applyTenantOverrides(t: Tenant, s: Pick<ConsoleState, "tenantStatus" | "tenantPlan" | "tenantFeatures" | "tenantWhiteLabel" | "tenantLimits">): Tenant {
  const wl = s.tenantWhiteLabel[t.id];
  const limits = s.tenantLimits[t.id];
  const whiteLabel = wl?.enabled ?? t.whiteLabel;
  const accent = wl?.accent ?? t.branding?.accent;
  // Branding needs an accent to be renderable; without one the tenant inherits the platform tokens.
  const branding =
    accent && (whiteLabel || t.branding)
      ? {
          name: wl?.brandName ?? t.branding?.name ?? t.name,
          accent,
          accentDark: wl?.accent ?? t.branding?.accentDark ?? accent,
          domain: wl?.domain ?? t.branding?.domain,
          supportEmail: t.branding?.supportEmail,
        }
      : undefined;
  return {
    ...t,
    status: s.tenantStatus[t.id] ?? t.status,
    plan: s.tenantPlan[t.id] ?? t.plan,
    features: { ...t.features, ...s.tenantFeatures[t.id] },
    whiteLabel,
    branding,
    seatLimit: limits?.seatLimit ?? t.seatLimit,
  };
}

/** The five override maps the tenant views need, selected shallowly so the selector is stable. */
export function useTenantOverrides() {
  return useConsoleStore(
    useShallow((s) => ({ tenantStatus: s.tenantStatus, tenantPlan: s.tenantPlan, tenantFeatures: s.tenantFeatures, tenantWhiteLabel: s.tenantWhiteLabel, tenantLimits: s.tenantLimits })),
  );
}
