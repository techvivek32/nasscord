import { rateLimited } from "./errors.mjs";

/**
 * Token buckets in front of every broker call (contract section 6):
 * - per IBKR connection (one gateway = one IBKR username): 8 requests per second
 * - per E*TRADE connection and API module (accounts, market, order, oauth): 2 per second
 * - one global bucket for the whole process
 * A caller waits for a token for up to `maxWaitMs`, then gets a 429 it can show.
 */

export class TokenBucket {
  /**
   * @param {{ ratePerSec: number, burst?: number, now?: () => number }} opts
   */
  constructor({ ratePerSec, burst, now = Date.now }) {
    if (!(ratePerSec > 0)) throw new Error("ratePerSec must be positive");
    this.rate = ratePerSec / 1000; // tokens per ms
    this.capacity = Math.max(1, burst ?? ratePerSec);
    this.tokens = this.capacity;
    this.now = now;
    this.updatedAt = now();
    this.pausedUntil = 0;
  }

  refill() {
    const t = this.now();
    if (t > this.updatedAt) {
      this.tokens = Math.min(this.capacity, this.tokens + (t - this.updatedAt) * this.rate);
      this.updatedAt = t;
    }
  }

  /** Milliseconds until a token is available (0 = now). Does not take it. */
  waitMs() {
    this.refill();
    const t = this.now();
    const paused = this.pausedUntil > t ? this.pausedUntil - t : 0;
    const short = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.rate);
    return Math.max(paused, short);
  }

  take() {
    this.refill();
    this.tokens -= 1;
  }

  /** @param {number} ms stop handing out tokens for this long (broker asked us to back off) */
  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }
}

/**
 * @param {{
 *   ibkrPerSec?: number, etradePerSec?: number, globalPerSec?: number, maxWaitMs?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export function createLimiter(opts = {}) {
  const {
    ibkrPerSec = 8,
    etradePerSec = 2,
    globalPerSec = 50,
    maxWaitMs = 5_000,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const global = new TokenBucket({ ratePerSec: globalPerSec, now });
  /** @type {Map<string, TokenBucket>} */
  const buckets = new Map();
  /** @type {Map<string, number>} consecutive back-offs per key, for doubling */
  const strikes = new Map();

  /** @param {string} key @param {number} rate */
  const bucket = (key, rate) => {
    let b = buckets.get(key);
    if (!b) {
      b = new TokenBucket({ ratePerSec: rate, now });
      buckets.set(key, b);
    }
    return b;
  };

  /**
   * @param {string} key
   * @param {number} rate
   * @param {string} brokerName for the message
   */
  async function acquire(key, rate, brokerName) {
    const b = bucket(key, rate);
    const started = now();
    for (;;) {
      const wait = Math.max(b.waitMs(), global.waitMs());
      if (wait === 0) {
        // No await between the check and the take: both tokens go together.
        b.take();
        global.take();
        return;
      }
      if (now() - started + wait > maxWaitMs) {
        throw rateLimited(
          `${brokerName} is limiting requests right now. Try again in a few seconds.`,
          Math.max(1, Math.ceil(wait / 1000)),
        );
      }
      await sleep(Math.min(wait, 250));
    }
  }

  return {
    /** @param {string} connectionId */
    ibkr: (connectionId) => acquire(`ibkr:${connectionId}`, ibkrPerSec, "IBKR"),
    /**
     * @param {string} connectionId
     * @param {"accounts" | "market" | "order" | "oauth" | string} module
     */
    etrade: (connectionId, module) => acquire(`etrade:${connectionId}:${module}`, etradePerSec, "E*TRADE"),

    /**
     * The broker answered "slow down": pause that bucket, doubling up to a minute while it repeats.
     * @param {string} key "etrade:<id>:<module>" or "ibkr:<id>"
     * @returns {number} the pause in ms
     */
    backoff(key) {
      const n = (strikes.get(key) ?? 0) + 1;
      strikes.set(key, n);
      const ms = Math.min(60_000, 5_000 * 2 ** (n - 1));
      const b = buckets.get(key) ?? bucket(key, key.startsWith("ibkr:") ? ibkrPerSec : etradePerSec);
      b.pause(ms);
      return ms;
    },

    /** @param {string} key a call went through: reset the back-off doubling */
    ok(key) {
      strikes.delete(key);
    },

    /** Forget every bucket of a connection (after disconnect). @param {string} connectionId */
    forget(connectionId) {
      for (const k of [...buckets.keys()]) if (k.includes(`:${connectionId}`)) buckets.delete(k);
      for (const k of [...strikes.keys()]) if (k.includes(`:${connectionId}`)) strikes.delete(k);
    },

    size: () => buckets.size,
  };
}

/** @typedef {ReturnType<typeof createLimiter>} Limiter */

/**
 * Counts actions per key in a sliding window: connect steps per user and new connections per
 * process (contract section 6). Unlike the token buckets above it never waits: over the limit is
 * an immediate 429 with Retry-After. The service runs as one process, so these counts are the
 * binding ones (the app's own per-instance limits only blunt bursts).
 * @param {{ now?: () => number }} [opts]
 */
export function createWindowCounter({ now = Date.now } = {}) {
  /** @type {Map<string, { windowMs: number, hits: number[] }>} */
  const keys = new Map();
  let lastSweep = 0;

  /** @param {number} t */
  function sweep(t) {
    if (t - lastSweep < 60_000) return;
    lastSweep = t;
    for (const [key, k] of keys) if (!k.hits.length || t - k.hits[k.hits.length - 1] >= k.windowMs) keys.delete(key);
  }

  return {
    /**
     * Counts one action for `key`, or throws a 429 when `key` already made `limit` of them in the
     * last `windowMs`.
     * @param {string} key
     * @param {number} limit
     * @param {number} windowMs
     * @param {string} message the sentence the user sees
     */
    take(key, limit, windowMs, message) {
      const t = now();
      sweep(t);
      const k = keys.get(key) ?? { windowMs, hits: [] };
      k.windowMs = windowMs;
      k.hits = k.hits.filter((at) => t - at < windowMs);
      keys.set(key, k);
      if (k.hits.length >= limit) {
        throw rateLimited(message, Math.max(1, Math.ceil((k.hits[0] + windowMs - t) / 1000)));
      }
      k.hits.push(t);
    },

    size: () => keys.size,
  };
}

/** @typedef {ReturnType<typeof createWindowCounter>} WindowCounter */
