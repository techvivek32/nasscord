import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { before, mock, test } from "node:test";

/*
 * Unit tests of src/lib/server/broker-availability.ts: what the public pages say about each broker,
 * from the broker service's answer for an ordinary trader, and the static fallback when the service
 * cannot be asked. Run with the command in alias-hooks.mjs.
 */

// "next/cache" has no exports map, so plain Node needs the file name; the mock below replaces it anyway.
registerHooks({
  resolve: (specifier, context, next) => next(specifier === "next/cache" ? "next/cache.js" : specifier, context),
});

/** The fake broker service never answers. */
const HANG = Symbol("hang");
/** What the fake broker service answers next: a BrokerOptions object, an Error to throw, or HANG. */
/** @type {unknown} */
let answer = new Error("not set");
/** @type {Array<{ role: string, workspaceId: unknown }>} */
const callers = [];

mock.module("next/cache", {
  exports: {
    // No Next runtime here: the cached function runs every time.
    unstable_cache: (/** @type {(...a: unknown[]) => unknown} */ fn) => fn,
  },
});
mock.module("@/lib/server/broker-service", {
  exports: {
    isBrokerServiceConfigured: () => true,
    getOptions: async (/** @type {{ role: string, workspaceId: unknown }} */ actor) => {
      callers.push({ role: actor.role, workspaceId: actor.workspaceId });
      if (answer === HANG) return new Promise(() => {});
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
});

/** @type {typeof import("../broker-availability.ts")} */
let m;
/** @type {typeof import("../../brokers.ts")} */
let registry;

before(async () => {
  m = await import("@/lib/server/broker-availability");
  registry = await import("@/lib/brokers");
});

/**
 * One option as GET /v1/options answers it for a trader.
 * @param {string} brokerId @param {string} method @param {string | null} client
 * @param {{ available?: boolean, audience?: string, environments?: string[], reasonCode?: string | null }} [o]
 */
function opt(brokerId, method, client, o = {}) {
  const available = o.available ?? true;
  return {
    brokerId,
    method,
    client,
    flow: "api_key",
    environments: o.environments ?? ["production"],
    audience: o.audience ?? "all",
    built: true,
    configured: true,
    available,
    reasonCode: available ? null : (o.reasonCode ?? "owner_only"),
    reason: available ? null : "Not available yet.",
    callbackUrl: null,
  };
}

const byId = (/** @type {import("../broker-availability.ts").PublicAvailability} */ a, /** @type {string} */ id) => {
  const b = a.brokers.find((x) => x.id === id);
  assert.ok(b, `broker ${id} is listed`);
  return b;
};

test("statuses follow the service: direct ways are live, SnapTrade-only is sync, the rest soon", () => {
  const a = m.availabilityFromOptions({
    callbackBase: "https://nasscord.com",
    options: [
      opt("ibkr", "ibkr_gateway", null, { environments: ["production", "paper"] }),
      opt("etrade", "etrade_oauth1", null),
      opt("alpaca", "alpaca_key", null, { environments: ["production", "paper"] }),
      opt("alpaca", "alpaca_oauth", "platform", { available: false }),
      opt("fidelity", "snaptrade", null),
      // Schwab: SnapTrade open, the user's own app still owner-only.
      opt("schwab", "snaptrade", null),
      opt("schwab", "schwab_oauth", "user", { available: false, audience: "superadmin" }),
      opt("tradier", "tradier_oauth", "platform", { available: false, reasonCode: "not_configured" }),
    ],
  });
  assert.equal(a.source, "service");
  assert.equal(byId(a, "ibkr").status, "live");
  assert.equal(byId(a, "etrade").status, "live");
  assert.equal(byId(a, "alpaca").status, "live");
  assert.equal(byId(a, "fidelity").status, "sync");
  assert.equal(byId(a, "schwab").status, "sync");
  assert.equal(byId(a, "schwab").viaSnapTrade, true);
  assert.equal(byId(a, "tradier").status, "soon");
  assert.equal(byId(a, "robinhood").status, "soon", "a broker the service did not mention does not connect");

  assert.deepEqual(
    a.today.map((b) => b.id),
    a.brokers.filter((b) => b.status !== "soon").map((b) => b.id),
  );
  assert.ok(a.direct.every((b) => b.status === "live"));
  assert.ok(a.sync.every((b) => b.status === "sync"));
  assert.equal(a.today.length + a.soon.length, a.brokers.length);
});

test("a broker that turns live gets a blurb from its connect spec, not the static 'Not available yet'", () => {
  const a = m.availabilityFromOptions({ callbackBase: null, options: [opt("alpaca", "alpaca_key", null, { environments: ["production", "paper"] })] });
  const alpaca = byId(a, "alpaca");
  assert.equal(alpaca.status, "live");
  assert.doesNotMatch(alpaca.blurb, /Not available yet/);
  // Alpaca's key can trade where order entry is on (design 5.4): its blurb is the connect summary, without "Read only".
  assert.equal(alpaca.blurb, alpaca.open[0]?.summary);
  assert.doesNotMatch(alpaca.blurb, /read-only|read only/i);
  assert.equal(alpaca.open[0]?.method, "alpaca_key");
  assert.equal(alpaca.paperToday, true);
  assert.equal(alpaca.waiting, null);
});

test("only ways open to everyone count: owner-only, unavailable and sandbox-only answers do not", () => {
  const a = m.availabilityFromOptions({
    callbackBase: null,
    options: [
      // Defensive: an answer that says available for an owner-only gate is not "everyone".
      opt("tradier", "tradier_token", null, { audience: "superadmin" }),
      opt("tastytrade", "tastytrade_oauth", "platform", { environments: ["sandbox"] }),
      opt("webull", "webull_oauth", "platform", { available: false, audience: "off", reasonCode: "off" }),
    ],
  });
  for (const id of ["tradier", "tastytrade", "webull", "ibkr"]) assert.equal(byId(a, id).status, "soon", id);
  assert.equal(a.today.length, 0);
});

test("a broker that does not connect says why, from its preferred way's reason", () => {
  const a = m.availabilityFromOptions({ callbackBase: null, options: [] });
  const tradier = byId(a, "tradier");
  assert.equal(tradier.status, "soon");
  assert.equal(tradier.waiting, "Nasscord is waiting for Tradier to approve it as a partner.");
  assert.match(byId(a, "fidelity").waiting ?? "", /^Nasscord is waiting for SnapTrade/);
  // A static "live" broker the service says is closed gets a "Not available yet" blurb.
  const ibkr = byId(a, "ibkr");
  assert.equal(ibkr.status, "soon");
  assert.match(ibkr.blurb, /^Not available yet\./);
});

test("the registry fallback is the static release status", () => {
  const a = m.availabilityFromRegistry();
  assert.equal(a.source, "registry");
  for (const b of registry.BROKERS) assert.equal(byId(a, b.id).status, b.status, b.id);
  assert.deepEqual(
    a.today.map((b) => b.id),
    registry.RELEASED_BROKERS.map((b) => b.id),
  );
  for (const b of a.today) assert.ok(b.open.length > 0, `${b.id} names how it connects`);
  for (const b of a.soon) assert.ok(b.waiting, `${b.id} says why it does not connect`);
});

/** Lets pending promise callbacks run (setImmediate is not mocked below). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// The two publicBrokers tests run on a mocked clock. Each starts later than the last one's retry
// time, because the module remembers a failure across calls.
test("publicBrokers asks as an ordinary trader, falls back to the registry when the service fails, and asks again a minute later", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  try {
    const success = { callbackBase: "https://nasscord.com", options: [opt("alpaca", "alpaca_key", null)] };
    answer = success;
    const live = await m.publicBrokers();
    assert.equal(live.source, "service");
    assert.equal(byId(live, "alpaca").status, "live");
    assert.deepEqual(callers.at(-1), { role: "trader", workspaceId: null }, "no user, no workspace, the trader role");

    answer = new Error("The broker service cannot be reached right now.");
    // React's cache() memoizes per request only inside a server render; here every call runs again.
    const fallback = await m.publicBrokers();
    assert.equal(fallback.source, "registry");

    // Within the minute after a failure the service is not asked, even once it would answer.
    const asked = callers.length;
    answer = success;
    t.mock.timers.tick(m.PUBLIC_RETRY_AFTER_MS - 1);
    assert.equal((await m.publicBrokers()).source, "registry");
    assert.equal(callers.length, asked, "not asked again inside the minute");

    t.mock.timers.tick(1);
    assert.equal((await m.publicBrokers()).source, "service", "asked again once the minute is over");
    assert.equal(callers.length, asked + 1);

    answer = { callbackBase: null, options: "not a list" };
    assert.equal((await m.publicBrokers()).source, "registry", "a malformed answer is not trusted");
    assert.equal(callers.length, asked + 2, "the malformed answer was asked for, not skipped");
  } finally {
    t.mock.timers.reset();
  }
});

test("publicBrokers gives up on a service that does not answer after the timeout, then stops asking", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000_000 });
  try {
    answer = HANG;
    let settled = false;
    const pending = m.publicBrokers().then((a) => {
      settled = true;
      return a;
    });
    t.mock.timers.tick(m.PUBLIC_OPTIONS_TIMEOUT_MS - 1);
    await flush();
    assert.equal(settled, false, "still waiting just before the timeout");
    t.mock.timers.tick(1);
    const a = await pending;
    assert.equal(a.source, "registry");

    // The next render does not wait again: it answers at once from the registry.
    const asked = callers.length;
    const next = await m.publicBrokers();
    assert.equal(next.source, "registry");
    assert.equal(callers.length, asked);
  } finally {
    t.mock.timers.reset();
  }
});

test("names for sentences", () => {
  assert.equal(m.andList(["A"]), "A");
  assert.equal(m.andList(["A", "B"]), "A and B");
  assert.equal(m.andList(["A", "B", "C"]), "A, B and C");
  assert.equal(m.orList(["A", "B", "C"]), "A, B or C");
  const six = registry.BROKERS.slice(0, 6);
  assert.equal(m.brokerNames(six.slice(0, 2), { short: true }), "IBKR and E*TRADE");
  assert.equal(m.brokerNames(six, { max: 3, short: true }), "IBKR, E*TRADE and 4 more");
});

test("every page that reads the availability revalidates, even when it rendered on the fallback", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  // Inside the retry minute no cached read runs, so the (marketing) layout must give every public
  // page its revalidate time; otherwise a page built on the fallback stays static until the next build.
  const layout = await readFile(path.join(src, "app/(marketing)/layout.tsx"), "utf8");
  assert.match(layout, /^export const revalidate = 300;$/m, "the (marketing) layout revalidates every 300 s");
  const lib = await readFile(path.join(src, "lib/server/broker-availability.ts"), "utf8");
  assert.match(lib, /const REVALIDATE_S = 300;/, "the same clock as the cached service answer");
  // Every page outside (marketing) that reads it renders on demand (login reads searchParams).
  const pages = [];
  for (const entry of await readdir(path.join(src, "app"), { recursive: true })) {
    if (!/page\.tsx$/.test(entry) || entry.includes("(marketing)")) continue;
    const text = await readFile(path.join(src, "app", entry), "utf8");
    if (text.includes("publicBrokers")) pages.push(entry.replaceAll("\\", "/"));
  }
  assert.deepEqual(pages, ["(auth)/login/page.tsx"], "a new page outside the public site that reads the availability needs its own revalidate");
});
