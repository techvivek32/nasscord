import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createBrokerService } from "../src/server.mjs";
import { nextMidnightEt } from "../src/time.mjs";
import { call, jwtFor, listen, testConfig } from "./helpers/common.mjs";
import { startFakeEtrade } from "./helpers/fake-etrade.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

const CONSUMER_KEY = "282683cc9e4b8fc81dea6bc687d46758";
const CONSUMER_SECRET = "7d30246211192cda43ede3abd9b393b9";
const user = randomUUID();
const wid = randomUUID();
const token = () => jwtFor({ sub: user, wid });

/** @type {Awaited<ReturnType<typeof startFakeEtrade>>} */
let fake;
/** @type {ReturnType<typeof createMemoryDb>} */
let db;
/** @type {ReturnType<typeof createBrokerService>} */
let svc;
/** @type {Awaited<ReturnType<typeof listen>>} */
let api;
/** @type {string} */
let connectionId;

before(async () => {
  fake = await startFakeEtrade({ consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });
  db = createMemoryDb();
  db.tables.set("members", [{ user_id: user, email: "trader@example.com", role: "trader", workspace_id: wid }]);
  svc = createBrokerService(testConfig({ ETRADE_ALLOW_SANDBOX: "true" }), { db, etradeUrls: fake.urls });
  api = await listen((req, res) => svc.api.handle(req, res));
});

after(async () => {
  await api?.close();
  await fake?.close();
});

const rows = (/** @type {string} */ t) => db.tables.get(t) ?? [];

test("start: request token with oauth_callback=oob, encrypted secret, authorize URL", async () => {
  const r = await call(`${api.url}/v1/etrade/start`, {
    method: "POST",
    token: token(),
    body: { environment: "sandbox", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET },
  });
  assert.equal(r.status, 200, r.text);
  connectionId = r.json.connectionId;
  const authorize = new URL(r.json.authorizeUrl);
  assert.equal(`${authorize.origin}${authorize.pathname}`, fake.urls.authorizeUrl);
  assert.equal(authorize.searchParams.get("key"), CONSUMER_KEY);
  assert.match(String(authorize.searchParams.get("token")), /\+\/=$/, "the request token survives decoding intact");
  assert.equal(fake.state.signatureFailures, 0);

  const conn = rows("broker_connections").find((c) => c.id === connectionId);
  assert.equal(conn?.status, "pending");
  assert.equal(conn?.environment, "sandbox");
  assert.equal(conn?.workspace_id, wid);
  const secret = rows("broker_secrets").find((s) => s.connection_id === connectionId);
  assert.ok(secret);
  assert.ok(!JSON.stringify(secret).includes(CONSUMER_SECRET), "nothing stored in the clear");
  const plain = svc.secretBox.decrypt(connectionId, /** @type {any} */ (secret));
  assert.equal(plain.consumerKey, CONSUMER_KEY);
  assert.equal(plain.requestToken, authorize.searchParams.get("token"));
  assert.ok(rows("audit_events").some((a) => a.action === "broker.etrade.start" && a.result === "ok" && a.actor_email === "trader@example.com"));
});

test("start refuses a key E*TRADE rejects, and sandbox keys when they are not allowed", async () => {
  const bad = await call(`${api.url}/v1/etrade/start`, {
    method: "POST",
    token: token(),
    body: { environment: "sandbox", consumerKey: "wrong-key-123", consumerSecret: CONSUMER_SECRET },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /did not accept this consumer key/);

  const strict = createBrokerService(testConfig({ ETRADE_ALLOW_SANDBOX: "false" }), { db: createMemoryDb(), etradeUrls: fake.urls });
  const strictApi = await listen((req, res) => strict.api.handle(req, res));
  try {
    const r = await call(`${strictApi.url}/v1/etrade/start`, {
      method: "POST",
      token: token(),
      body: { environment: "sandbox", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Sandbox keys are not accepted/);
  } finally {
    await strictApi.close();
  }
});

test("verify: a wrong code is refused, the right one makes the connection active until midnight ET", async () => {
  const wrong = await call(`${api.url}/v1/etrade/verify`, { method: "POST", token: token(), body: { connectionId, verifier: "ZZZZZ" } });
  assert.equal(wrong.status, 400);

  const other = await call(`${api.url}/v1/etrade/verify`, {
    method: "POST",
    token: jwtFor({ wid: randomUUID() }),
    body: { connectionId, verifier: fake.verifier },
  });
  assert.equal(other.status, 404, "another workspace cannot touch it");

  const before = Date.now();
  const r = await call(`${api.url}/v1/etrade/verify`, { method: "POST", token: token(), body: { connectionId, verifier: fake.verifier } });
  assert.equal(r.status, 200, r.text);
  const c = r.json.connection;
  assert.equal(c.status, "active");
  assert.equal(c.brokerId, "etrade");
  assert.equal(c.method, "etrade_oauth1");
  assert.equal(c.environment, "sandbox");
  assert.equal(c.sessionExpiresAt, new Date(nextMidnightEt(before)).toISOString());
  assert.deepEqual(
    c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
    [["Brokerage", "840•••45", "margin", true], ["Roth IRA", "840•••55", "roth", true]],
  );
  const plain = svc.secretBox.decrypt(connectionId, /** @type {any} */ (rows("broker_secrets").find((s) => s.connection_id === connectionId)));
  assert.ok(plain.accessToken && plain.accessSecret);
  assert.equal(plain.requestToken, undefined, "the request token is dropped");

  const again = await call(`${api.url}/v1/etrade/verify`, { method: "POST", token: token(), body: { connectionId, verifier: fake.verifier } });
  assert.equal(again.status, 409);
});

test("portfolio, orders and executions for the included accounts", async () => {
  const p = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.equal(p.status, 200, p.text);
  assert.deepEqual(p.json.errors, []);
  assert.equal(p.json.accounts.length, 2);
  const alpha = rows("broker_accounts").find((a) => a.external_id === "keyAlpha");
  const main = p.json.accounts.find((/** @type {any} */ a) => a.accountId === alpha?.id);
  assert.deepEqual(main, { accountId: alpha?.id, netLiq: 100000, buyingPower: 50000, cash: 10000, dayPnl: 123.45, currency: "USD" });
  assert.deepEqual(p.json.positions.map((/** @type {any} */ x) => x.symbol).sort(), ["AAPL", "MSFT", "NVDA"], "both portfolio pages");

  const o = await call(`${api.url}/v1/orders`, { token: token() });
  assert.equal(o.status, 200);
  assert.deepEqual(o.json.orders.map((/** @type {any} */ x) => [x.brokerRef, x.type, x.status]), [["502", "STP", "working"], ["501", "LMT", "filled"]]);
  const e = await call(`${api.url}/v1/executions`, { token: token() });
  assert.equal(e.json.executions.length, 1);
  assert.equal(e.json.executions[0].net, -994);

  // switching an account off (the app's PATCH writes the row) narrows the reads
  const roth = rows("broker_accounts").find((a) => a.external_id === "keyRoth");
  if (roth) roth.included = false;
  const p2 = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.deepEqual(p2.json.accounts.map((/** @type {any} */ a) => a.accountId), [alpha?.id]);
  if (roth) roth.included = true;
});

test("many tabs polling cost one broker call (5 s cache with in-flight dedupe)", async () => {
  svc.cache.invalidate(connectionId);
  const before = fake.state.calls.length;
  await Promise.all(Array.from({ length: 6 }, () => call(`${api.url}/v1/orders`, { token: token() })));
  const orderCalls = fake.state.calls.slice(before).filter((c) => c.path.endsWith("/orders"));
  assert.equal(orderCalls.length, 2, "one call per account, not per tab");
});

test("an HTML 400 is E*TRADE's rate limit: reported, not fatal", async () => {
  svc.cache.invalidate(connectionId);
  fake.state.rateLimitNext = 1;
  const r = await call(`${api.url}/v1/orders`, { token: token() });
  assert.equal(r.status, 200);
  assert.equal(r.json.errors.length, 1);
  assert.match(r.json.errors[0].message, /limiting requests/);
  svc.limiter.forget(connectionId);
  svc.cache.invalidate(connectionId);
  const ok = await call(`${api.url}/v1/orders`, { token: token() });
  assert.deepEqual(ok.json.errors, []);
});

test("an idle token is renewed once and the read retried", async () => {
  svc.cache.invalidate(connectionId);
  const at = /** @type {string} */ (fake.lastAccessToken());
  fake.idle(at);
  const before = fake.state.calls.length;
  const r = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.deepEqual(r.json.errors, []);
  assert.ok(fake.state.calls.slice(before).some((c) => c.path === "/oauth/renew_access_token"));
});

test("a dead token expires the connection; renew starts a new authorization with the stored key", async () => {
  svc.cache.invalidate(connectionId);
  fake.kill(/** @type {string} */ (fake.lastAccessToken()));
  const r = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.equal(r.json.errors.length, 1);
  assert.match(r.json.errors[0].message, /E\*TRADE ended the session/);
  const conn = rows("broker_connections").find((c) => c.id === connectionId);
  assert.equal(conn?.status, "expired");

  const renew = await call(`${api.url}/v1/connections/${connectionId}/renew`, { method: "POST", token: token() });
  assert.equal(renew.status, 200, renew.text);
  assert.equal(renew.json.connection.status, "pending");
  assert.ok(renew.json.loginUrl.startsWith(fake.urls.authorizeUrl));
  const v = await call(`${api.url}/v1/etrade/verify`, { method: "POST", token: token(), body: { connectionId, verifier: fake.verifier } });
  assert.equal(v.json.connection.status, "active");
  assert.equal(v.json.connection.accounts.length, 2, "accounts kept, no duplicates");
});

test("renew while active is a same-day token renewal", async () => {
  const before = fake.state.calls.length;
  const r = await call(`${api.url}/v1/connections/${connectionId}/renew`, { method: "POST", token: token() });
  assert.equal(r.status, 200);
  assert.equal(r.json.loginUrl, undefined);
  assert.equal(r.json.connection.status, "active");
  assert.deepEqual(fake.state.calls.slice(before).map((c) => c.path), ["/oauth/renew_access_token"]);
});

test("disconnect revokes the token and removes secret and accounts", async () => {
  const at = /** @type {string} */ (fake.lastAccessToken());
  const r = await call(`${api.url}/v1/connections/${connectionId}`, { method: "DELETE", token: token() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.ok(fake.isDead(at), "revoke_access_token was called");
  assert.equal(rows("broker_secrets").filter((s) => s.connection_id === connectionId).length, 0);
  assert.equal(rows("broker_accounts").filter((a) => a.connection_id === connectionId).length, 0);
  assert.equal(rows("broker_connections").find((c) => c.id === connectionId)?.status, "disconnected");
  const actions = rows("audit_events").map((a) => a.action);
  for (const a of ["broker.etrade.start", "broker.etrade.verify", "broker.connection.renew", "broker.connection.disconnect"]) {
    assert.ok(actions.includes(a), a);
  }
  assert.equal(fake.state.signatureFailures, 0, "every request E*TRADE saw was signed correctly");
});

test("starting over removes earlier attempts that never got a code", async () => {
  const body = { environment: "sandbox", consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET };
  const a = await call(`${api.url}/v1/etrade/start`, { method: "POST", token: token(), body });
  const b = await call(`${api.url}/v1/etrade/start`, { method: "POST", token: token(), body });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const ids = rows("broker_connections").map((c) => c.id);
  assert.ok(!ids.includes(a.json.connectionId), "the abandoned attempt is gone");
  assert.ok(ids.includes(b.json.connectionId));
  assert.ok(ids.includes(connectionId), "a connection that had accounts is kept");
  assert.equal(rows("broker_secrets").filter((s) => s.connection_id === a.json.connectionId).length, 0);
});
