"use client";

import { create } from "zustand";
import type { TourStep } from "@/lib/tours";

/* ------------------------------------------------------------------
   Intro tour state. Which tour is open and on which step lives for the
   tab; which tours were already shown is remembered in localStorage so
   each area greets a person once.
   ------------------------------------------------------------------ */

export const TOURS_SEEN_KEY = "nasscord-tours-seen";

/** localStorage can throw (private mode, blocked storage). A failed read means "not seen". */
function readSeen(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TOURS_SEEN_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function hasSeenTour(id: string) {
  return readSeen().includes(id);
}

export function markTourSeen(id: string) {
  try {
    const seen = readSeen();
    if (!seen.includes(id)) window.localStorage.setItem(TOURS_SEEN_KEY, JSON.stringify([...seen, id]));
  } catch {
    /* the tour shows again next time; harmless */
  }
}

interface TourState {
  active: string | null;
  steps: TourStep[];
  index: number;
  start: (id: string, steps: TourStep[]) => void;
  next: () => void;
  back: () => void;
  stop: () => void;
}

export const useTourStore = create<TourState>()((set, get) => ({
  active: null,
  steps: [],
  index: 0,
  start: (id, steps) => {
    if (steps.length > 0) set({ active: id, steps, index: 0 });
  },
  next: () => {
    const { index, steps } = get();
    if (index >= steps.length - 1) set({ active: null, steps: [], index: 0 });
    else set({ index: index + 1 });
  },
  back: () => set((s) => ({ index: Math.max(0, s.index - 1) })),
  stop: () => set({ active: null, steps: [], index: 0 }),
}));
