import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ConfigError, loadConfig, parsePortRange } from "../src/config.mjs";
import { createBrokerService } from "../src/server.mjs";
import { call, jwtFor, listen, sleep, TEST_SECRET, TEST_TOKEN_KEY, testConfig } from "./helpers/common.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/** @type {ReturnType<typeof createMemoryDb>} */
let db;
/** @type {Awaited<ReturnType<typeof listen>>} */
let api;
const wid = randomUUID();
const otherWid = randomUUID();
const connId = randomUUID();

before(async () => {
  db = createMemoryDb();
  db.tables.set("broker_connections", [
    { id: connId, workspace_id: otherWid, user_id: randomUUID(), broker_id: "etrade", method: "etrade_oauth1", environment: "production", status: "active", status_detail: null, session_expires_at: null, last_ok_at: null },
  ]);
  const svc = createBrokerService(testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist" }), { db });
  api = await listen((req, res) => svc.api.handle(req, res));
});
after(() => api?.close());

test("GET /health needs no token and says nothing about gateway slots", async () => {
  const r = await call(`${api.url}/health`);
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.version, "string");
  assert.equal(typeof r.json.uptimeSec, "number");
  assert.equal(r.json.gateways, undefined, "slot counts are for the super admin only (/v1/health)");
});

test("everything under /v1 needs a valid service token", async () => {
  assert.equal((await call(`${api.url}/v1/portfolio`)).status, 401);
  assert.equal((await call(`${api.url}/v1/portfolio`, { token: jwtFor({}, "w".repeat(40)) })).status, 401);
  const expired = jwtFor({ iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 });
  assert.equal((await call(`${api.url}/v1/portfolio`, { token: expired })).status, 401);
  assert.equal((await call(`${api.url}/v1/portfolio`, { token: jwtFor({ aud: "other" }) })).status, 401);
  const ok = await call(`${api.url}/v1/portfolio`, { token: jwtFor({ wid }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { accounts: [], positions: [], errors: [] });
});

test("a connection of another workspace is a 404, whatever the role", async () => {
  for (const role of ["trader", "tenant_user", "superadmin"]) {
    const r = await call(`${api.url}/v1/connections/${connId}`, { token: jwtFor({ wid, role }) });
    assert.equal(r.status, 404, role);
    assert.deepEqual(r.json, { error: "Connection not found.", code: "not_found" });
  }
  assert.equal((await call(`${api.url}/v1/connections/${connId}`, { method: "DELETE", token: jwtFor({ wid }) })).status, 404);
  assert.equal((await call(`${api.url}/v1/connections/${connId}/renew`, { method: "POST", token: jwtFor({ wid }) })).status, 404);
  assert.equal(db.tables.get("broker_connections")?.[0].status, "active", "untouched");
});

test("no workspace, or the tenant role, cannot connect brokers", async () => {
  const none = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: jwtFor({ wid: null }), body: { environment: "production" } });
  assert.equal(none.status, 403);
  assert.match(none.json.error, /Finish creating your workspace/);
  const tenant = await call(`${api.url}/v1/portfolio`, { token: jwtFor({ role: "tenant" }) });
  assert.equal(tenant.status, 403);
});

test("IBKR start without the gateway bundle is a plain 503", async () => {
  const r = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: jwtFor({ wid }), body: { environment: "paper" } });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /not set up on this server/);
  const bad = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: jwtFor({ wid }), body: { environment: "demo" } });
  assert.equal(bad.status, 400);
});

test("connect steps are limited per user and new connections per process", async () => {
  const ldb = createMemoryDb();
  const svc = createBrokerService(testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist", BROKER_CONNECT_PER_USER: "2", BROKER_CONNECT_GLOBAL_PER_MIN: "3" }), { db: ldb });
  const limited = await listen((req, res) => svc.api.handle(req, res));
  try {
    const a = randomUUID();
    /** @param {string} sub */
    const start = (sub) => call(`${limited.url}/v1/ibkr/start`, { method: "POST", token: jwtFor({ sub, wid }), body: { environment: "paper" } });
    assert.equal((await start(a)).status, 503, "counted, then refused for the missing bundle");
    assert.equal((await start(a)).status, 503);
    const third = await start(a);
    assert.equal(third.status, 429);
    assert.match(third.json.error, /Too many connection attempts from your account/);
    assert.ok(Number(third.headers.get("retry-after")) > 0, "says when to try again");

    const b = randomUUID();
    assert.equal((await start(b)).status, 503, "another user is not held back by the first");
    const busy = await start(b);
    assert.equal(busy.status, 429, "but the process-wide start limit (3 a minute) is reached");
    assert.match(busy.json.error, /Many people are connecting brokers right now/);
    await sleep(20);
    const audited = (ldb.tables.get("audit_events") ?? []).filter((e) => e.action === "broker.ibkr.start");
    assert.equal(audited.length, 3, "refused attempts are not written to the audit log one by one");
  } finally {
    await limited.close();
  }
});

test("/v1/health is for the superadmin only", async () => {
  assert.equal((await call(`${api.url}/v1/health`, { token: jwtFor({ role: "trader" }) })).status, 403);
  const r = await call(`${api.url}/v1/health`, { token: jwtFor({ role: "superadmin", wid: null }) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.connections, { ibkr: {}, etrade: { active: 1 } });
  assert.equal(r.json.gateways.running, 0);
  assert.equal(r.json.gateways.bundle, false);
});

test("bad bodies, unknown routes and wrong methods", async () => {
  const notJson = await fetch(`${api.url}/v1/etrade/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwtFor({ wid })}`, "content-type": "application/json" },
    body: "{nope",
  });
  assert.equal(notJson.status, 400);
  const big = await call(`${api.url}/v1/etrade/start`, { method: "POST", token: jwtFor({ wid }), body: { x: "a".repeat(40_000) } });
  assert.equal(big.status, 413);
  assert.equal((await call(`${api.url}/v1/nothing`, { token: jwtFor({ wid }) })).status, 404);
  assert.equal((await call(`${api.url}/v1/portfolio`, { method: "POST", token: jwtFor({ wid }) })).status, 405);
  const missing = await call(`${api.url}/v1/etrade/start`, { method: "POST", token: jwtFor({ wid }), body: { environment: "production" } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /consumer key/);
});

test("config: validation names the variable, never the value", () => {
  assert.deepEqual(parsePortRange("7200-7202,7210"), [7200, 7201, 7202, 7210]);
  assert.throws(() => parsePortRange("80-90"), /outside/);
  try {
    loadConfig({ BROKER_SERVICE_SECRET: "short-secret-value", BROKER_TOKEN_KEY: "bm90LTMyLWJ5dGVz", API_PORT: "x" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    const text = e.message;
    assert.match(text, /SUPABASE_URL is required/);
    assert.match(text, /BROKER_SERVICE_SECRET must be at least 32 bytes/);
    assert.match(text, /BROKER_TOKEN_KEY must be base64 of exactly 32 bytes/);
    assert.match(text, /API_PORT must be a port number/);
    assert.ok(!text.includes("short-secret-value") && !text.includes("bm90LTMyLWJ5dGVz"), "no values in the message");
  }
  const prod = () =>
    loadConfig({
      NODE_ENV: "production",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      BROKER_SERVICE_SECRET: TEST_SECRET,
      BROKER_TOKEN_KEY: TEST_TOKEN_KEY,
      PUBLIC_LOGIN_URL: "http://ibkr-login.example.com",
    });
  assert.throws(prod, /must use https in production/);
  const dev = testConfig();
  assert.equal(dev.apiHost, "127.0.0.1");
  assert.equal(dev.publicLoginUrl, "http://localhost:8711");
  assert.equal(dev.etrade.allowSandbox, true, "sandbox allowed by default outside production");
  assert.equal(dev.ibkr.ports.length, 50);
  assert.equal(dev.ibkr.maxPendingLogins, 25, "half the slots may wait for a login");
  assert.deepEqual(dev.steps, { connectPerUser: 20, connectGlobalPerMin: 60 });
});
