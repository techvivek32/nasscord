/**
 * The instant the demo data set is pinned to (2026-09-30 14:52 ET).
 * Anything measured against demo timestamps ("2 h ago", "today", "last 7 days", session time left)
 * uses this instead of the wall clock, so the demo reads the same on any day.
 * The market session pill and the ticket's extended-hours rules stay on the real clock.
 * Swap for `new Date()` when src/lib/api serves live data.
 */
export const DEMO_NOW = new Date("2026-09-30T18:52:00Z");
