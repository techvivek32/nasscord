/**
 * One change at a time per key (a connection id). Shared by the API routes, the IBKR adapter, the
 * keepalive and the scheduler, so Connect, Reconnect, a gateway restart and a slot release on the
 * same connection never interleave.
 *
 * Not re-entrant: code that already holds a key's lock must not ask for it again.
 */
export function createLocks() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(fn);
      const tail = run.catch(() => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },

    /** @param {string} key */
    held: (key) => tails.has(key),
  };
}

/** @typedef {ReturnType<typeof createLocks>} Locks */
