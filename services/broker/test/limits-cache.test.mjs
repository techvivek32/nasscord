import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoalescingCache } from "../src/cache.mjs";
import { HttpError } from "../src/errors.mjs";
import { createLimiter, TokenBucket } from "../src/limits.mjs";

/** A clock the test moves by hand; sleeping advances it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (/** @type {number} */ ms) => {
      t += ms;
    },
    sleep: async (/** @type {number} */ ms) => {
      t += ms;
    },
  };
}

test("token bucket: burst of `rate`, then one token per 1/rate seconds", () => {
  const c = fakeClock();
  const b = new TokenBucket({ ratePerSec: 8, now: c.now });
  for (let i = 0; i < 8; i++) {
    assert.equal(b.waitMs(), 0);
    b.take();
  }
  assert.equal(b.waitMs(), 125);
  c.advance(125);
  assert.equal(b.waitMs(), 0);
});

test("limiter: IBKR 8/s per connection, independent per connection", async () => {
  const c = fakeClock();
  const lim = createLimiter({ now: c.now, sleep: c.sleep, globalPerSec: 1000 });
  const t0 = c.now();
  for (let i = 0; i < 16; i++) await lim.ibkr("a");
  assert.ok(c.now() - t0 >= 1000 - 1, "16 calls at 8/s take about a second after the burst");
  const t1 = c.now();
  for (let i = 0; i < 8; i++) await lim.ibkr("b");
  assert.equal(c.now(), t1, "another connection has its own bucket");
});

test("limiter: E*TRADE 2/s per connection and module", async () => {
  const c = fakeClock();
  const lim = createLimiter({ now: c.now, sleep: c.sleep, globalPerSec: 1000 });
  await lim.etrade("x", "accounts");
  await lim.etrade("x", "accounts");
  const t = c.now();
  await lim.etrade("x", "market"); // other module: no wait
  assert.equal(c.now(), t);
  await lim.etrade("x", "accounts");
  assert.ok(c.now() - t >= 500);
});

test("limiter: the global bucket caps the whole process", async () => {
  const c = fakeClock();
  const lim = createLimiter({ now: c.now, sleep: c.sleep, globalPerSec: 4 });
  for (let i = 0; i < 4; i++) await lim.ibkr(`conn-${i}`);
  const t = c.now();
  await lim.ibkr("conn-9");
  assert.ok(c.now() - t >= 250);
});

test("limiter: waiting longer than maxWait is a 429 with Retry-After", async () => {
  const c = fakeClock();
  const lim = createLimiter({ now: c.now, sleep: c.sleep, maxWaitMs: 100 });
  const ms = lim.backoff("etrade:x:accounts");
  assert.equal(ms, 5_000);
  await assert.rejects(lim.etrade("x", "accounts"), (e) => e instanceof HttpError && e.status === 429 && (e.retryAfterSec ?? 0) >= 1);
  assert.equal(lim.backoff("etrade:x:accounts"), 10_000, "repeated back-off doubles");
  lim.ok("etrade:x:accounts");
  c.advance(10_000);
  await lim.etrade("x", "accounts");
  lim.forget("x");
  assert.equal(lim.size(), 0);
});

test("cache: concurrent reads share one load; the answer is reused for the TTL", async () => {
  const c = fakeClock();
  const cache = createCoalescingCache({ ttlMs: 5_000, now: c.now });
  let loads = 0;
  /** @type {(v: string) => void} */
  let release = () => {};
  const loader = () => {
    loads++;
    return new Promise((r) => (release = r));
  };
  const a = cache.get("conn1:portfolio", loader);
  const b = cache.get("conn1:portfolio", loader);
  assert.equal(cache.inflightCount(), 1);
  release("v1");
  assert.equal(await a, "v1");
  assert.equal(await b, "v1");
  assert.equal(await cache.get("conn1:portfolio", async () => "v2"), "v1");
  assert.equal(loads, 1);
  c.advance(5_000);
  assert.equal(await cache.get("conn1:portfolio", async () => "v2"), "v2");
});

test("cache: failures are not cached; invalidate drops a connection and ignores loads already running", async () => {
  const c = fakeClock();
  const cache = createCoalescingCache({ ttlMs: 5_000, now: c.now });
  await assert.rejects(cache.get("k:x", async () => Promise.reject(new Error("boom"))));
  assert.equal(await cache.get("k:x", async () => "ok"), "ok");
  /** @type {(v: string) => void} */
  let release = () => {};
  const slow = cache.get("k:y", () => new Promise((r) => (release = r)));
  cache.invalidate("k");
  release("stale");
  assert.equal(await slow, "stale");
  assert.equal(await cache.get("k:y", async () => "fresh"), "fresh", "a load that started before invalidate is not stored");
  assert.equal(await cache.get("k:x", async () => "again"), "again");
});
