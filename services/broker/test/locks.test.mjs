import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocks, LockTimeoutError } from "../src/locks.mjs";

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("runs of one key go in order, other keys do not wait", async () => {
  const locks = createLocks();
  /** @type {string[]} */
  const seen = [];
  const a = locks.run("k", async () => {
    await sleep(40);
    seen.push("a");
    return 1;
  });
  const b = locks.run("k", async () => {
    seen.push("b");
    return 2;
  });
  const other = locks.run("other", async () => {
    seen.push("other");
    return 3;
  });
  assert.deepEqual(await Promise.all([a, b, other]), [1, 2, 3]);
  assert.deepEqual(seen, ["other", "a", "b"]);
  assert.equal(locks.held("k"), false);
});

test("a failed run does not block the next one", async () => {
  const locks = createLocks();
  const a = locks.run("k", async () => {
    throw new Error("boom");
  });
  const b = locks.run("k", async () => "ok");
  await assert.rejects(a, /boom/);
  assert.equal(await b, "ok");
});

test("maxWaitMs: a wait that runs out never runs fn, and the next waiter still runs", async () => {
  const locks = createLocks();
  /** @type {string[]} */
  const seen = [];
  let release = () => {};
  const holder = locks.run("k", () => new Promise((r) => (release = () => r("held"))));
  let ranLate = false;
  const late = locks.run(
    "k",
    async () => {
      ranLate = true;
      return "late";
    },
    { maxWaitMs: 30 },
  );
  const next = locks.run(
    "k",
    async () => {
      seen.push("next");
      return "next";
    },
    { maxWaitMs: 5_000 },
  );
  await assert.rejects(late, (e) => e instanceof LockTimeoutError && e.name === "LockTimeoutError");
  await sleep(20);
  release();
  assert.equal(await holder, "held");
  assert.equal(await next, "next");
  assert.equal(ranLate, false, "the abandoned run never starts");
  assert.deepEqual(seen, ["next"]);
  await sleep(5);
  assert.equal(locks.held("k"), false);
});

test("maxWaitMs: the abandoned wait does not delay later waiters", async () => {
  const locks = createLocks();
  let release = () => {};
  void locks.run("k", () => new Promise((r) => (release = () => r(undefined))));
  const late = locks.run("k", async () => "late", { maxWaitMs: 10 });
  await assert.rejects(late, LockTimeoutError);
  const started = Date.now();
  const after = locks.run("k", async () => Date.now(), { maxWaitMs: 2_000 });
  await sleep(30);
  release();
  const ranAt = await after;
  assert.ok(ranAt - started < 1_000);
});

test("maxWaitMs with a free key runs at once", async () => {
  const locks = createLocks();
  assert.equal(await locks.run("k", async () => 7, { maxWaitMs: 0 }), 7);
});

test("without maxWaitMs the wait has no limit, as before", async () => {
  const locks = createLocks();
  const a = locks.run("k", () => sleep(120).then(() => "a"));
  const b = locks.run("k", async () => "b");
  assert.equal(await a, "a");
  assert.equal(await b, "b");
});

test("countHeld counts queued and running keys by prefix", async () => {
  const locks = createLocks();
  let release = () => {};
  const p = locks.run("order:1", () => new Promise((r) => (release = () => r(undefined))));
  void locks.run("other", () => sleep(1));
  assert.equal(locks.countHeld("order:"), 1);
  await sleep(5);
  release();
  await p;
  await sleep(5);
  assert.equal(locks.countHeld("order:"), 0);
});
