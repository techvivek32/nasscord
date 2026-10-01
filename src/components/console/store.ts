"use client";

import * as React from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useTenants } from "@/hooks/queries";
import { ENGINE_DEFAULTS, UNIVERSE } from "@/lib/engine";
import { PLANS } from "@/lib/plans";
import type { BrokerId, EngineParams, PlanId, Tenant, TenantBranding, User, Workspace, WorkspaceFeatures, WorkspaceStatus } from "@/lib/types";

/* ------------------------------------------------------------------
   Super admin console client state. Everything here is a local override
   on top of the mock data, so every switch, approve button and plan edit
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

export type TenantDecision = "approved" | "declined";

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

/** Planned brokers ship disabled for traders until an integration is live. */
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

  /* Workspaces (the Traders pages) */
  workspaceStatus: Record<string, WorkspaceStatus>;
  setWorkspaceStatus: (id: string, status: WorkspaceStatus) => void;
  workspacePlan: Record<string, PlanId>;
  setWorkspacePlan: (id: string, plan: PlanId) => void;
  workspaceFeatures: Record<string, Partial<WorkspaceFeatures>>;
  setWorkspaceFeature: (id: string, key: keyof WorkspaceFeatures, value: boolean) => void;
  workspaceLimits: Record<string, { seatLimit?: number }>;
  setWorkspaceLimits: (id: string, patch: { seatLimit?: number }) => void;

  /* Tenants (the Tenants and White-label pages). Only the super admin writes these. */
  tenantWhiteLabel: Record<string, boolean>;
  setTenantWhiteLabel: (id: string, on: boolean) => void;
  tenantBranding: Record<string, TenantBranding>;
  setTenantBranding: (id: string, branding: TenantBranding) => void;
  tenantDecisions: Record<string, TenantDecision>;
  decideTenant: (applicationId: string, decision: TenantDecision) => void;
  addedTenants: Tenant[];
  addTenant: (t: Tenant) => void;

  brokerEnabled: Record<BrokerId, boolean>;
  setBrokerEnabled: (id: BrokerId, on: boolean) => void;

  invitedUsers: User[];
  addUser: (u: User) => void;
  removedUserIds: string[];
  removeUser: (id: string) => void;
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

  workspaceStatus: {},
  setWorkspaceStatus: (id, status) => set((s) => ({ workspaceStatus: { ...s.workspaceStatus, [id]: status } })),
  workspacePlan: {},
  setWorkspacePlan: (id, plan) => set((s) => ({ workspacePlan: { ...s.workspacePlan, [id]: plan } })),
  workspaceFeatures: {},
  setWorkspaceFeature: (id, key, value) =>
    set((s) => ({ workspaceFeatures: { ...s.workspaceFeatures, [id]: { ...s.workspaceFeatures[id], [key]: value } } })),
  workspaceLimits: {},
  setWorkspaceLimits: (id, patch) => set((s) => ({ workspaceLimits: { ...s.workspaceLimits, [id]: { ...s.workspaceLimits[id], ...patch } } })),

  tenantWhiteLabel: {},
  setTenantWhiteLabel: (id, on) => set((s) => ({ tenantWhiteLabel: { ...s.tenantWhiteLabel, [id]: on } })),
  tenantBranding: {},
  setTenantBranding: (id, branding) => set((s) => ({ tenantBranding: { ...s.tenantBranding, [id]: branding } })),
  tenantDecisions: {},
  decideTenant: (applicationId, decision) => set((s) => ({ tenantDecisions: { ...s.tenantDecisions, [applicationId]: decision } })),
  addedTenants: [],
  addTenant: (t) => set((s) => ({ addedTenants: [t, ...s.addedTenants] })),

  brokerEnabled: DEFAULT_BROKER_ENABLED,
  setBrokerEnabled: (id, on) => set((s) => ({ brokerEnabled: { ...s.brokerEnabled, [id]: on } })),

  invitedUsers: [],
  addUser: (u) => set((s) => ({ invitedUsers: [u, ...s.invitedUsers] })),
  removedUserIds: [],
  removeUser: (id) => set((s) => ({ removedUserIds: [...s.removedUserIds, id] })),
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

/* ---------------- workspaces ---------------- */

export type WorkspaceOverrides = Pick<ConsoleState, "workspaceStatus" | "workspacePlan" | "workspaceFeatures" | "workspaceLimits">;

/** Apply the super admin's local overrides to a workspace record from the API. */
export function applyWorkspaceOverrides(w: Workspace, o: WorkspaceOverrides): Workspace {
  return {
    ...w,
    status: o.workspaceStatus[w.id] ?? w.status,
    plan: o.workspacePlan[w.id] ?? w.plan,
    features: { ...w.features, ...o.workspaceFeatures[w.id] },
    seatLimit: o.workspaceLimits[w.id]?.seatLimit ?? w.seatLimit,
  };
}

/** The four override maps the workspace views need, selected shallowly so the selector is stable. */
export function useWorkspaceOverrides(): WorkspaceOverrides {
  return useConsoleStore(
    useShallow((s) => ({ workspaceStatus: s.workspaceStatus, workspacePlan: s.workspacePlan, workspaceFeatures: s.workspaceFeatures, workspaceLimits: s.workspaceLimits })),
  );
}

/* ---------------- tenants ---------------- */

export type TenantOverrides = Pick<ConsoleState, "tenantWhiteLabel" | "tenantBranding">;

/** Apply the super admin's white-label grants and branding edits to a tenant record from the API. */
export function applyTenantOverrides(t: Tenant, o: TenantOverrides): Tenant {
  return { ...t, whiteLabel: o.tenantWhiteLabel[t.id] ?? t.whiteLabel, branding: o.tenantBranding[t.id] ?? t.branding };
}

/** The white-label override maps, selected shallowly so the selector is stable. */
export function useTenantOverrides(): TenantOverrides {
  return useConsoleStore(useShallow((s) => ({ tenantWhiteLabel: s.tenantWhiteLabel, tenantBranding: s.tenantBranding })));
}

/**
 * Every tenant as the console sees it right now: the API list plus tenants added or approved in
 * this session, with white-label overrides applied. `byId` resolves a workspace's or a user's tenantId.
 */
export function useConsoleTenants() {
  const query = useTenants();
  const added = useConsoleStore((s) => s.addedTenants);
  const overrides = useTenantOverrides();
  const tenants = React.useMemo(() => [...added, ...(query.data?.tenants ?? [])].map((t) => applyTenantOverrides(t, overrides)), [added, query.data, overrides]);
  const byId = React.useMemo(() => new Map(tenants.map((t) => [t.id, t] as const)), [tenants]);
  return { query, tenants, byId };
}
