import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIENCE_DEFAULTS, gateKey as serviceGateKey, TWO_CLIENT_METHODS as SERVICE_TWO_CLIENT } from "../../../../services/broker/src/config.mjs";
import { CONNECT_SPECS, METHOD_BROKERS, METHOD_LABEL, reconnectWarnHours } from "@/lib/broker-connect";
import { expiryWindows, gateKey, REACH_RANK, reachOf, TWO_CLIENT_METHODS } from "@/lib/console-brokers";
import { toConnectionStatus } from "@/lib/server/rows";

/*
 * Unit tests of src/lib/console-brokers.ts, the broker rules of the super admin console, pinned to the
 * broker service's own config (services/broker/src/config.mjs) and to toConnectionStatus (rows.ts).
 * Run with the command in alias-hooks.mjs.
 */

const HOUR = 3_600_000;
const every = Object.entries(CONNECT_SPECS).flatMap(([brokerId, specs]) => specs.map((spec) => ({ brokerId, spec })));

test("the console names every way of connecting with the broker service's own BROKER_AUDIENCE key", () => {
  assert.ok(every.length > 0);
  for (const { brokerId, spec } of every) {
    const client = spec.client ?? null;
    const key = gateKey(spec.method, client);
    assert.equal(key, serviceGateKey(spec.method, client), `${brokerId} ${spec.method} ${client ?? "-"}`);
    // A bare key of a two-client method would open the user's app and Nasscord's client at once.
    assert.ok(Object.hasOwn(AUDIENCE_DEFAULTS, key), `${key} is a gate the service knows (${brokerId})`);
  }
});

test("the two-client methods are the same on both sides", () => {
  assert.deepEqual([...TWO_CLIENT_METHODS].sort(), [...SERVICE_TWO_CLIENT].sort());
  for (const method of Object.keys(METHOD_LABEL)) {
    for (const client of [null, "user", "platform"]) {
      assert.equal(gateKey(/** @type {any} */ (method), /** @type {any} */ (client)), serviceGateKey(method, /** @type {any} */ (client)), `${method} ${client}`);
    }
  }
});

/**
 * One option as GET /v1/options answers it.
 * @param {{ available?: boolean, audience?: string, reasonCode?: string | null }} o
 */
const opt = (o) => {
  const available = o.available ?? false;
  return /** @type {any} */ ({
    brokerId: "schwab",
    method: "schwab_oauth",
    client: "user",
    flow: "oauth2_user_app",
    environments: ["production"],
    audience: o.audience ?? "superadmin",
    built: true,
    configured: true,
    available,
    reasonCode: available ? null : (o.reasonCode ?? "owner_only"),
    reason: available ? null : "Not available yet.",
    callbackUrl: null,
  });
};

test("reach: everyone beats owner-only, a missing setting is 'setup', no answer is 'unknown'", () => {
  const everyone = opt({ available: true, audience: "all" });
  const owner = opt({ available: true, audience: "superadmin" });
  const setup = opt({ reasonCode: "not_configured" });
  const noEnv = opt({ reasonCode: "no_environment" });
  const off = opt({ audience: "off", reasonCode: "off" });

  assert.equal(reachOf([owner, everyone], true), "everyone");
  assert.equal(reachOf([setup, owner], true), "owner");
  assert.equal(reachOf([off, setup], true), "setup");
  assert.equal(reachOf([noEnv], true), "setup");
  assert.equal(reachOf([off], true), "closed");
  assert.equal(reachOf([], true), "closed", "a broker the service did not mention");
  assert.equal(reachOf([everyone], false), "unknown", "the service did not answer");
  // Defensive: an answer open to all that is not available does not count as everyone.
  assert.equal(reachOf([opt({ available: false, audience: "all", reasonCode: "not_built" })], true), "closed");

  const ranks = ["everyone", "owner", "setup", "closed", "unknown"].map((r) => REACH_RANK[/** @type {keyof typeof REACH_RANK} */ (r)]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "open to everyone sorts first");
});

test("the overview's expiring count uses the same windows as the terminal's status (rows.ts)", () => {
  const windows = expiryWindows();
  const methods = windows.flatMap((w) => w.methods);
  assert.deepEqual([...methods].sort(), Object.keys(METHOD_BROKERS).sort(), "every method in exactly one window");
  assert.equal(new Set(windows.map((w) => w.hours)).size, windows.length, "one group per window");
  assert.ok(windows.some((w) => w.hours === 48 && w.methods.includes("schwab_oauth")), "Schwab's weekly login warns 48 hours ahead");

  const now = Date.UTC(2026, 10, 16, 15, 0, 0);
  for (const { hours, methods: group } of windows) {
    for (const method of group) {
      for (const brokerId of METHOD_BROKERS[method]) {
        // Every broker of the method shares the method's window, so one count per window is exact.
        assert.equal(reconnectWarnHours(brokerId, method), hours, `${brokerId} ${method}`);
        const at = (ms) => new Date(now + ms).toISOString();
        assert.equal(toConnectionStatus("active", at(hours * HOUR - 60_000), { now, brokerId, method }), "expiring", `${brokerId} ${method} inside ${hours} h`);
        assert.equal(toConnectionStatus("active", at(hours * HOUR + 60_000), { now, brokerId, method }), "connected", `${brokerId} ${method} past ${hours} h`);
      }
    }
  }
});
