"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { slugify } from "@/lib/format";
import type { Role, TenantBranding } from "@/lib/types";
import { DEFAULT_TIMEZONE, SIGNUP_DRAFT_KEY, defaultWorkspaceName, type SignupPlanId, type TimezoneId, type WizardStep } from "@/components/onboarding/data";
import type { PreferencesValues } from "@/components/onboarding/schemas";

/* ------------------------------------------------------------------
   Wizard state. The account and workspace live in Supabase; this store
   only remembers the draft and where the user is, in localStorage under
   nasscord-signup-draft, so a refresh or the email round trip does not
   lose progress. The password is never stored. Version 4 is the real
   signup; older demo drafts start over.
   Hydration is manual (skipHydration) so the server render and the first
   client render agree; the wizard shows a skeleton until `hydrated`.
   ------------------------------------------------------------------ */

export interface AccountDraft {
  fullName: string;
  email: string;
  /** Optional tenant code. A valid one makes the user a tenant user of that tenant. */
  tenantCode: string;
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

/** The tenant a code resolved to, for the "Applied" badge and the white-label preview. */
export interface TenantPreview {
  code: string;
  name: string;
  branding: TenantBranding | null;
}

/** Where the server says this user is (see src/app/(auth)/signup/page.tsx). */
export type SignupPhase = "account" | "workspace" | "continue";

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
  /** The address a confirmation link was sent to; step 1 shows "check your email" while set. */
  awaitingEmail: string | null;
  tenant: TenantPreview | null;
  workspace: WorkspaceDraft;
  /** The workspace step 2 created. */
  created: { slug: string; role: Role } | null;
  prefs: PreferencesValues;
}

interface SignupActions {
  goTo: (step: WizardStep) => void;
  back: () => void;
  markStarted: () => void;
  setTenantCode: (code: string) => void;
  setTenant: (tenant: TenantPreview | null) => void;
  /** Step 1 done: the account exists and a confirmation email went to `email`. */
  accountCreated: (values: AccountDraft) => void;
  clearAwaiting: () => void;
  setWorkspace: (patch: Partial<WorkspaceDraft>) => void;
  workspaceCreated: (created: { slug: string; role: Role }) => void;
  submitBrokers: () => void;
  setPrefs: (patch: Partial<PreferencesValues>) => void;
  finishPreferences: () => void;
  markLaunched: () => void;
  /** Lines the draft up with what the server knows (phase), keeping what still applies. */
  syncPhase: (phase: SignupPhase, prefill: Partial<AccountDraft>) => void;
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
  account: { fullName: "", email: "", tenantCode: "" },
  awaitingEmail: null,
  tenant: null,
  workspace: { name: "", nameEdited: false, slug: "", slugEdited: false, timezone: DEFAULT_TIMEZONE, plan: "pro" },
  created: null,
  prefs: { riskPct: 1, emailAlerts: true, pushAlerts: true, smsAlerts: false, extendedHours: false, paperMode: true },
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

/** What goes to localStorage. */
function toDraft(s: SignupData) {
  return {
    launched: s.launched,
    step: s.step,
    furthest: s.furthest,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    account: s.account,
    awaitingEmail: s.awaitingEmail,
    tenant: s.tenant,
    workspace: s.workspace,
    created: s.created,
    prefs: s.prefs,
  };
}
type SignupDraft = ReturnType<typeof toDraft>;

/** Drafts from the demo wizard (versions 1 to 3) start over. */
function migrateDraft(): SignupDraft {
  return toDraft(initialData);
}

function workspacePrefill(workspace: WorkspaceDraft, fullName: string): WorkspaceDraft {
  const name = workspace.nameEdited && workspace.name ? workspace.name : defaultWorkspaceName(fullName);
  const slug = workspace.slugEdited && workspace.slug ? workspace.slug : slugify(name).slice(0, 32).replace(/-+$/, "");
  return { ...workspace, name, slug };
}

export const useSignupStore = create<SignupStore>()(
  persist(
    (set, get) => ({
      ...initialData,

      goTo: (step) => {
        const { furthest, created } = get();
        if (step > furthest) return;
        // Account and workspace exist once created: those steps cannot be redone.
        if (created && step < 3) return;
        set({ step, navigated: true });
      },

      back: () => {
        const { step, created } = get();
        const min = created ? 3 : 2;
        if (step > min) set({ step: (step - 1) as WizardStep, navigated: true });
      },

      markStarted: () => {
        if (get().startedAt === null) set({ startedAt: Date.now() });
      },

      setTenantCode: (tenantCode) => set((s) => ({ account: { ...s.account, tenantCode } })),

      setTenant: (tenant) => set({ tenant }),

      accountCreated: (values) =>
        set((s) => ({
          account: values,
          awaitingEmail: values.email,
          workspace: workspacePrefill(s.workspace, values.fullName),
          startedAt: s.startedAt ?? Date.now(),
        })),

      clearAwaiting: () => set({ awaitingEmail: null }),

      setWorkspace: (patch) => set((s) => ({ workspace: { ...s.workspace, ...patch } })),

      workspaceCreated: (created) => set((s) => ({ created, step: 3, furthest: s.furthest < 3 ? 3 : s.furthest, navigated: true })),

      submitBrokers: () => set((s) => ({ step: 4, furthest: s.furthest < 4 ? 4 : s.furthest, navigated: true })),

      setPrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),

      finishPreferences: () => set((s) => ({ step: 5, furthest: 5, navigated: true, completedAt: s.completedAt ?? Date.now() })),

      markLaunched: () => set({ launched: true }),

      syncPhase: (phase, prefill) => {
        const s = get();
        const account: AccountDraft = {
          fullName: prefill.fullName || s.account.fullName,
          email: prefill.email || s.account.email,
          tenantCode: prefill.tenantCode ?? s.account.tenantCode,
        };
        if (phase === "account") {
          set({ hydrated: true, step: 1, furthest: 1, created: null, account });
        } else if (phase === "workspace") {
          set({ hydrated: true, step: 2, furthest: 2, created: null, awaitingEmail: null, account, workspace: workspacePrefill(s.workspace, account.fullName) });
        } else {
          set({ hydrated: true, awaitingEmail: null, account });
        }
      },

      reset: () => set({ ...initialData, hydrated: true }),
    }),
    {
      name: SIGNUP_DRAFT_KEY,
      version: 4,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s) => toDraft(s),
      migrate: migrateDraft,
    },
  ),
);

export function riskDollars(netLiq: number, riskPct: number) {
  return Math.round(netLiq * (riskPct / 100) * 100) / 100;
}
