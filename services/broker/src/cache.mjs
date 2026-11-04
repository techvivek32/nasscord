/**
 * Per-connection read cache (contract section 6): an answer is reused for `ttlMs` (5 s), and a
 * request that arrives while the same read is already in flight waits for that answer instead of
 * calling the broker again. Many tabs polling one connection cost one broker call.
 *
 * Failures are not cached; the next caller tries again.
 */

/**
 * @param {{ ttlMs?: number, now?: () => number, maxEntries?: number }} [opts]
 */
export function createCoalescingCache(opts = {}) {
  const { ttlMs = 5_000, now = Date.now, maxEntries = 5_000 } = opts;
  /** @type {Map<string, { at: number, value: unknown }>} */
  const values = new Map();
  /** @type {Map<string, Promise<unknown>>} */
  const inflight = new Map();
  /** bumped by invalidate(); an in-flight load started before the bump does not store its result */
  /** @type {Map<string, number>} */
  const generation = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of values) if (t - v.at >= ttlMs) values.delete(k);
    if (values.size > maxEntries) values.clear();
  }

  /** @param {string} key the generation of the connection the key belongs to */
  const genOf = (key) => generation.get(key.split(":")[0]) ?? 0;

  return {
    /**
     * @template T
     * @param {string} key "<connectionId>:<what>[:...]"
     * @param {() => Promise<T>} loader
     * @returns {Promise<T>}
     */
    get(key, loader) {
      const hit = values.get(key);
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(/** @type {T} */ (hit.value));
      const running = inflight.get(key);
      if (running) return /** @type {Promise<T>} */ (running);

      const startedGen = genOf(key);
      const p = (async () => {
        try {
          const value = await loader();
          if (genOf(key) === startedGen) {
            if (values.size >= maxEntries) sweep();
            values.set(key, { at: now(), value });
          }
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },

    /**
     * Drop everything cached for a connection (status changed, accounts toggled, disconnected).
     * @param {string} connectionId
     */
    invalidate(connectionId) {
      generation.set(connectionId, (generation.get(connectionId) ?? 0) + 1);
      for (const k of [...values.keys()]) if (k === connectionId || k.startsWith(`${connectionId}:`)) values.delete(k);
    },

    sweep,
    size: () => values.size,
    inflightCount: () => inflight.size,
  };
}

/** @typedef {ReturnType<typeof createCoalescingCache>} CoalescingCache */
