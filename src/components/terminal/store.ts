"use client";

import * as React from "react";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

/* ------------------------------------------------------------------
   Per-browser terminal preferences: the account scope picked in the
   header and the watchlist symbols. Nothing here stands in for server
   state: connections, accounts, inclusion, positions and orders always
   come from the broker routes. Persisted in localStorage (guarded),
   hydrated by hand so the server render and the first client render
   agree.
   ------------------------------------------------------------------ */

export const TERMINAL_STORE_KEY = "nasscord-terminal";

export type AccountScope = "all" | string;

interface TerminalData {
  hydrated: boolean;
  /** "all", or a broker_accounts.id. An id that is no longer an included account reads as "all". */
  selectedAccountId: AccountScope;
  /** Symbols the user follows, in the order they added them. */
  watchlist: string[];
}

interface TerminalActions {
  setSelectedAccount: (id: AccountScope) => void;
  addWatch: (symbol: string) => void;
  removeWatch: (symbol: string) => void;
}

export type TerminalStore = TerminalData & TerminalActions;

const initialData: TerminalData = {
  hydrated: false,
  selectedAccountId: "all",
  watchlist: [],
};

/** localStorage can throw (private mode, blocked storage) and does not exist on the server. */
const safeStorage: StateStorage = {
  getItem: (key) => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* preferences are a convenience; ignore */
    }
  },
  removeItem: (key) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

type Persisted = Pick<TerminalData, "selectedAccountId" | "watchlist">;

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set) => ({
      ...initialData,

      setSelectedAccount: (selectedAccountId) => set({ selectedAccountId }),

      addWatch: (symbol) =>
        set((s) => {
          const sym = symbol.trim().toUpperCase();
          if (!sym || s.watchlist.includes(sym)) return {};
          return { watchlist: [...s.watchlist, sym] };
        }),

      removeWatch: (symbol) => set((s) => ({ watchlist: s.watchlist.filter((x) => x !== symbol) })),
    }),
    {
      name: TERMINAL_STORE_KEY,
      // Version 2 is the real-data terminal. Version 1 held demo overlays and a sample watchlist; only the scope carries over.
      version: 2,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s): Persisted => ({ selectedAccountId: s.selectedAccountId, watchlist: s.watchlist }),
      migrate: (persisted, version): Persisted => {
        const old = (persisted ?? {}) as Partial<Persisted>;
        const selectedAccountId = typeof old.selectedAccountId === "string" ? old.selectedAccountId : "all";
        const watchlist = version >= 2 && Array.isArray(old.watchlist) ? old.watchlist.filter((x): x is string => typeof x === "string") : [];
        return { selectedAccountId, watchlist };
      },
    },
  ),
);

let hydrating: Promise<void> | null = null;

/** Reads the persisted slice once per page load (client side); later calls share the first one. */
export function hydrateTerminalStore(): Promise<void> {
  const store = useTerminalStore;
  if (store.getState().hydrated) return Promise.resolve();
  hydrating ??= (async () => {
    try {
      await store.persist.rehydrate();
    } catch {
      /* storage unavailable: run with defaults */
    }
    store.setState({ hydrated: true });
  })();
  return hydrating;
}

/**
 * Hydrates the store from whichever component mounts first. The terminal header calls it (it is
 * always mounted, unlike the sidebar, which is a closed sheet on phones), and so does every component
 * that waits on `hydrated`, so none of them depends on another being on screen.
 */
export function useHydrateTerminalStore() {
  React.useEffect(() => {
    void hydrateTerminalStore();
  }, []);
}
