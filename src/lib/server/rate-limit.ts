/*
 * Best-effort in-memory rate limit (sliding window per key). It lives in one server process, so on
 * Vercel each instance counts on its own: enough to blunt form spam, not a security boundary.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

const buckets = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > windowMs) buckets.delete(key);
  }
}

/** True when the call is allowed (and counted); false when `key` already made `limit` calls inside `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  sweep(now, windowMs);
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}
