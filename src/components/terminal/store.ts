"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Alert, BrokerConnection, Order } from "@/lib/types";

/* ------------------------------------------------------------------
   Terminal session state. Account scope and paper mode persist in
   localStorage (guarded, manual hydration so SSR and the first client
   render agree). Orders placed in this session, closed positions and
   the loaded order ticket live only for the tab.
   ------------------------------------------------------------------ */

export const TERMINAL_STORE_KEY = "nasscord-terminal";

export type AccountScope = "all" | string;

export interface TicketDraft {
  symbol: string;
  entry: number;
  stop: number;
  target: number;
  accountId?: string;
  alertId?: number;
  /** Set when the ticket was loaded from a "Buy" button, so the ticket can scroll into view. */
  loadedAt: number;
}

interface TerminalData {
  hydrated: boolean;
  selectedAccountId: AccountScope;
  /** null until the tenant default has been applied (see initPaperMode). */
  paperMode: boolean | null;
  /** Per-account overrides of BrokerAccount.included, set from /app/brokers. */
  includedOverrides: Record<string, boolean>;
  watchlist: string[];
  /** Orders placed in this session (the verified order engine appends here). */
  localOrders: Order[];
  /** Order ids cancelled in this session (server-side orders are read-only demo data). */
  cancelledOrderIds: string[];
  /** Positions closed in this session. */
  closedPositionIds: string[];
  /** Brokers connected in this session through the simulated hand-off on /app/brokers. */
  sessionConnections: BrokerConnection[];
  ticket: TicketDraft | null;
}

interface TerminalActions {
  setSelectedAccount: (id: AccountScope) => void;
  initPaperMode: (tenantDefault: boolean) => void;
  setPaperMode: (on: boolean) => void;
  setIncluded: (accountId: string, included: boolean) => void;
  addWatch: (symbol: string) => void;
  removeWatch: (symbol: string) => void;
  addLocalOrders: (orders: Order[]) => void;
  updateLocalOrder: (id: string, patch: Partial<Order>) => void;
  cancelOrder: (id: string) => void;
  closePosition: (id: string) => void;
  addSessionConnection: (connection: BrokerConnection) => void;
  loadTicket: (draft: Omit<TicketDraft, "loadedAt">) => void;
  loadTicketFromAlert: (alert: Alert, accountId?: string) => void;
  clearTicket: () => void;
}

export type TerminalStore = TerminalData & TerminalActions;

export const DEFAULT_WATCHLIST = ["SPY", "QQQ", "NVDA", "AAPL", "MSFT", "TSLA", "AVGO", "META"];

const initialData: TerminalData = {
  hydrated: false,
  selectedAccountId: "all",
  paperMode: null,
  includedOverrides: {},
  watchlist: DEFAULT_WATCHLIST,
  localOrders: [],
  cancelledOrderIds: [],
  closedPositionIds: [],
  sessionConnections: [],
  ticket: null,
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

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set, get) => ({
      ...initialData,

      setSelectedAccount: (selectedAccountId) => set({ selectedAccountId }),

      initPaperMode: (tenantDefault) => {
        if (get().paperMode === null) set({ paperMode: tenantDefault });
      },

      setPaperMode: (paperMode) => set({ paperMode }),

      setIncluded: (accountId, included) => set((s) => ({ includedOverrides: { ...s.includedOverrides, [accountId]: included } })),

      addWatch: (symbol) =>
        set((s) => {
          const sym = symbol.trim().toUpperCase();
          if (!sym || s.watchlist.includes(sym)) return {};
          return { watchlist: [...s.watchlist, sym] };
        }),

      removeWatch: (symbol) => set((s) => ({ watchlist: s.watchlist.filter((x) => x !== symbol) })),

      addLocalOrders: (orders) => set((s) => ({ localOrders: [...orders, ...s.localOrders] })),

      updateLocalOrder: (id, patch) => set((s) => ({ localOrders: s.localOrders.map((o) => (o.id === id ? { ...o, ...patch } : o)) })),

      cancelOrder: (id) =>
        set((s) => ({
          cancelledOrderIds: s.cancelledOrderIds.includes(id) ? s.cancelledOrderIds : [...s.cancelledOrderIds, id],
          localOrders: s.localOrders.map((o) => (o.id === id ? { ...o, status: "cancelled" } : o)),
        })),

      closePosition: (id) => set((s) => ({ closedPositionIds: s.closedPositionIds.includes(id) ? s.closedPositionIds : [...s.closedPositionIds, id] })),

      addSessionConnection: (connection) => set((s) => ({ sessionConnections: [...s.sessionConnections.filter((c) => c.brokerId !== connection.brokerId), connection] })),

      loadTicket: (draft) => set({ ticket: { ...draft, loadedAt: Date.now() } }),

      loadTicketFromAlert: (alert, accountId) =>
        set({ ticket: { symbol: alert.symbol, entry: alert.entry, stop: alert.stop, target: alert.target, alertId: alert.id, accountId, loadedAt: Date.now() } }),

      clearTicket: () => set({ ticket: null }),
    }),
    {
      name: TERMINAL_STORE_KEY,
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s) => ({
        selectedAccountId: s.selectedAccountId,
        paperMode: s.paperMode,
        includedOverrides: s.includedOverrides,
        watchlist: s.watchlist,
      }),
    },
  ),
);

/** Called once from the terminal layout (client side). Reads the persisted slice, then applies the tenant default for paper mode. */
export async function hydrateTerminalStore(tenantPaperDefault: boolean) {
  const store = useTerminalStore;
  if (store.getState().hydrated) return;
  try {
    await store.persist.rehydrate();
  } catch {
    /* storage unavailable: run with defaults */
  }
  store.getState().initPaperMode(tenantPaperDefault);
  store.setState({ hydrated: true });
}
