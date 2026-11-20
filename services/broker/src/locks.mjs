/**
 * One change at a time per key (a connection id, or "order:<connectionId>" for order calls). Shared
 * by the API routes, the IBKR adapter, the keepalive, the scheduler and the order core, so Connect,
 * Reconnect, a gateway restart and a slot release on the same connection never interleave, and two
 * orders on one broker login never interleave either.
 *
 * Not re-entrant: code that already holds a key's lock must not ask for it again.
 */

/** The wait for a key ran out: `fn` never ran. */
export class LockTimeoutError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(`lock wait ran out (${key.split(":")[0]})`);
    this.name = "LockTimeoutError";
  }
}

export function createLocks() {
  /** @type {Map<string, Promise<unknown>>} */
  const tails = new Map();

  return {
    /**
     * Runs `fn` once every earlier run of `key` has finished. With `maxWaitMs`, a wait longer than
     * that rejects with LockTimeoutError instead: `fn` never runs, and later waiters go on as soon
     * as the earlier work ends (they are not delayed by the abandoned one). Without it the wait has
     * no limit, as before.
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @param {{ maxWaitMs?: number }} [opts]
     * @returns {Promise<T>}
     */
    run(key, fn, opts = {}) {
      const prev = tails.get(key) ?? Promise.resolve();
      const settled = prev.catch(() => {});
      /** @type {Promise<T>} */
      let run;
      if (opts.maxWaitMs === undefined) {
        run = settled.then(fn);
      } else {
        const maxWaitMs = Math.max(0, opts.maxWaitMs);
        run = new Promise((resolve, reject) => {
          let state = "waiting";
          const timer = setTimeout(() => {
            if (state !== "waiting") return;
            state = "gave_up";
            reject(new LockTimeoutError(key));
          }, maxWaitMs);
          timer.unref?.();
          void settled.then(() => {
            clearTimeout(timer);
            if (state !== "waiting") return;
            state = "running";
            Promise.resolve()
              .then(fn)
              .then(resolve, reject);
          });
        });
      }
      // The next waiter starts after the earlier work and, when this one runs, after it too. An
      // abandoned wait adds nothing of its own: the chain goes on when `prev` settles.
      const tail = opts.maxWaitMs === undefined ? run.catch(() => {}) : Promise.all([settled, run.catch(() => {})]).then(() => {});
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },

    /** @param {string} key */
    held: (key) => tails.has(key),

    /** How many keys starting with `prefix` have work queued or running. @param {string} prefix */
    countHeld(prefix) {
      let n = 0;
      for (const k of tails.keys()) if (k.startsWith(prefix)) n += 1;
      return n;
    },
  };
}

/** @typedef {ReturnType<typeof createLocks>} Locks */
