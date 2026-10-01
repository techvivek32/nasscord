"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { slugify } from "@/lib/format";
import type { BrokerId } from "@/lib/types";
import {
  DEFAULT_TIMEZONE,
  SIGNUP_DRAFT_KEY,
  TENANT_CODE,
  defaultWorkspaceName,
  type DemoAccount,
  type RiskPct,
  type SignupPlanId,
  type SsoProvider,
  type TimezoneId,
  type WizardStep,
} from "@/components/onboarding/data";
import type { PreferencesValues } from "@/components/onboarding/schemas";

/* ------------------------------------------------------------------
   Wizard state. Persisted to localStorage under nasscord-signup-draft so
   a refresh does not lose progress. The password is never persisted.
   Version 3 renamed the account's invite code field to tenantCode;
   version 2 drafts are migrated, anything older starts over.
   Hydration is manual (skipHydration) so the server render and the first
   client render agree; the wizard shows a skeleton until `hydrated`.
   ------------------------------------------------------------------ */

export interface ConnectedBroker {
  brokerId: BrokerId;
  accounts: DemoAccount[];
  connectedAt: number;
}

export interface AccountDraft {
  fullName: string;
  email: string;
  password: string;
  /** Optional tenant code. A valid one (isTenantCode) signs the user up as a tenant user of that tenant. */
  tenantCode: string;
  sso: SsoProvider | null;
}

export interface WorkspaceDraft {
  name: string;
  /** True once the trader typed a name; stops the "<First>'s Desk" prefill from overwriting it. */
  nameEdited: boolean;
  slug: string;
  /** True once the trader typed a subdomain; stops auto-slugging from the name. */
  slugEdited: boolean;
  timezone: TimezoneId;
  plan: SignupPlanId;
}

interface SignupData {
  hydrated: boolean;
  /** True once the user has moved between steps; used to move focus on step change without stealing it on load. */
  navigated: boolean;
  /** Set when "Open your terminal" was pressed; the next visit to /signup starts clean. */
  launched: boolean;
  step: WizardStep;
  furthest: WizardStep;
  startedAt: number | null;
  completedAt: number | null;
  account: AccountDraft;
  workspace: WorkspaceDraft;
  connections: ConnectedBroker[];
  notify: BrokerId[];
  prefs: PreferencesValues;
}

interface SignupActions {
  goTo: (step: WizardStep) => void;
  back: () => void;
  markStarted: () => void;
  submitAccount: (values: Omit<AccountDraft, "sso">, sso?: SsoProvider | null) => void;
  setTenantCode: (code: string) => void;
  setWorkspace: (patch: Partial<WorkspaceDraft>) => void;
  submitWorkspace: () => void;
  addConnection: (brokerId: BrokerId, accounts: DemoAccount[]) => void;
  removeConnection: (brokerId: BrokerId) => void;
  toggleNotify: (brokerId: BrokerId) => void;
  /** Leaves step 3 with or without a connection ("Skip for now" uses it too). */
  submitBrokers: () => void;
  setPrefs: (patch: Partial<PreferencesValues>) => void;
  finishPreferences: () => void;
  markLaunched: () => void;
  reset: () => void;
}

export type SignupStore = SignupData & SignupActions;

const initialData: SignupData = {
  hydrated: false,
  navigated: false,
  launched: false,
  step: 1,
  furthest: 1,
  startedAt: null,
  completedAt: null,
  account: { fullName: "", email: "", password: "", tenantCode: "", sso: null },
  workspace: { name: "", nameEdited: false, slug: "", slugEdited: false, timezone: DEFAULT_TIMEZONE, plan: "pro" },
  connections: [],
  notify: [],
  prefs: { defaultAccountId: "", riskPct: 1, emailAlerts: true, push: true, sms: false, extendedHours: false, paperMode: true },
};

/** localStorage can throw (private mode, blocked storage). Every access is guarded. */
const safeStorage: StateStorage = {
  getItem: (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* the draft is a convenience; ignore */
    }
  },
  removeItem: (key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/** What goes to localStorage. Shared by `partialize` and the migration's fresh start. */
function toDraft(s: SignupData) {
  return {
    launched: s.launched,
    step: s.step,
    furthest: s.furthest,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    account: { ...s.account, password: "" },
    workspace: s.workspace,
    connections: s.connections,
    notify: s.notify,
    prefs: s.prefs,
  };
}
type SignupDraft = ReturnType<typeof toDraft>;

/**
 * Drafts saved by an older wizard. Version 2 kept the code under the field's previous name, and the
 * only code it accepted no longer exists, so the tenant code starts empty and the rest of the draft
 * is kept. Anything older, or anything unreadable, starts over.
 */
function migrateDraft(persisted: unknown, version: number): SignupDraft {
  const fresh = toDraft(initialData);
  if (version !== 2 || typeof persisted !== "object" || persisted === null) return fresh;
  const old = persisted as Partial<SignupDraft>;
  const a: Partial<AccountDraft> = old.account ?? {};
  return { ...fresh, ...old, account: { fullName: a.fullName ?? "", email: a.email ?? "", password: "", tenantCode: "", sso: a.sso ?? null } };
}

function pickDefaultAccount(connections: ConnectedBroker[], current: string) {
  const all = connections.flatMap((c) => c.accounts);
  if (all.some((a) => a.id === current)) return current;
  return all[0]?.id ?? "";
}

export const useSignupStore = create<SignupStore>()(
  persist(
    (set, get) => ({
      ...initialData,

      goTo: (step) => {
        const { furthest } = get();
        if (step > furthest) return;
        set({ step, navigated: true });
      },

      back: () => {
        const { step } = get();
        if (step > 1) set({ step: (step - 1) as WizardStep, navigated: true });
      },

      markStarted: () => {
        if (get().startedAt === null) set({ startedAt: Date.now() });
      },

      submitAccount: (values, sso = null) => {
        const { workspace, startedAt } = get();
        const name = workspace.nameEdited && workspace.name ? workspace.name : defaultWorkspaceName(values.fullName);
        const slug = workspace.slugEdited && workspace.slug ? workspace.slug : slugify(name);
        set({
          account: { ...values, sso },
          workspace: { ...workspace, name, slug },
          step: 2,
          furthest: 2,
          navigated: true,
          startedAt: startedAt ?? Date.now(),
        });
      },

      setTenantCode: (tenantCode) => set((s) => ({ account: { ...s.account, tenantCode } })),

      setWorkspace: (patch) => set((s) => ({ workspace: { ...s.workspace, ...patch } })),

      submitWorkspace: () => set((s) => ({ step: 3, furthest: s.furthest < 3 ? 3 : s.furthest, navigated: true })),

      addConnection: (brokerId, accounts) =>
        set((s) => {
          const rest = s.connections.filter((c) => c.brokerId !== brokerId);
          const existing = s.connections.find((c) => c.brokerId === brokerId);
          const connections = accounts.length
            ? [...rest, { brokerId, accounts, connectedAt: existing?.connectedAt ?? Date.now() }].sort((a, b) => a.connectedAt - b.connectedAt)
            : rest;
          return {
            connections,
            notify: s.notify.filter((id) => id !== brokerId),
            prefs: { ...s.prefs, defaultAccountId: pickDefaultAccount(connections, s.prefs.defaultAccountId) },
          };
        }),

      removeConnection: (brokerId) =>
        set((s) => {
          const connections = s.connections.filter((c) => c.brokerId !== brokerId);
          return { connections, prefs: { ...s.prefs, defaultAccountId: pickDefaultAccount(connections, s.prefs.defaultAccountId) } };
        }),

      toggleNotify: (brokerId) =>
        set((s) => ({ notify: s.notify.includes(brokerId) ? s.notify.filter((id) => id !== brokerId) : [...s.notify, brokerId] })),

      submitBrokers: () => set((s) => ({ step: 4, furthest: s.furthest < 4 ? 4 : s.furthest, navigated: true })),

      setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),

      finishPreferences: () => set((s) => ({ step: 5, furthest: 5, navigated: true, completedAt: s.completedAt ?? Date.now() })),

      markLaunched: () => set({ launched: true }),

      reset: () => set({ ...initialData, hydrated: true }),
    }),
    {
      name: SIGNUP_DRAFT_KEY,
      version: 3,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s) => toDraft(s),
      migrate: migrateDraft,
    },
  ),
);

/* ---------- selectors ---------- */

/** True when the code is the demo tenant's (Acme Capital's) code. Case and surrounding spaces do not matter. */
export function isTenantCode(code: string) {
  return code.trim().toUpperCase() === TENANT_CODE;
}

export function selectAllAccounts(s: Pick<SignupStore, "connections">): DemoAccount[] {
  return s.connections.flatMap((c) => c.accounts);
}

export function selectDefaultAccount(s: Pick<SignupStore, "connections" | "prefs">): DemoAccount | undefined {
  return selectAllAccounts(s).find((a) => a.id === s.prefs.defaultAccountId);
}

export function riskDollars(netLiq: number, riskPct: RiskPct) {
  return Math.round(netLiq * (riskPct / 100) * 100) / 100;
}
