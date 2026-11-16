import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createAudit } from "../src/audit.mjs";
import { createCoalescingCache } from "../src/cache.mjs";
import { createStore } from "../src/db.mjs";
import { createEtradeAdapter, ETRADE_DETAIL } from "../src/etrade/adapter.mjs";
import { IBKR_DETAIL } from "../src/ibkr/session.mjs";
import { createLimiter } from "../src/limits.mjs";
import { createLocks } from "../src/locks.mjs";
import { silentLogger } from "../src/log.mjs";
import { createScheduler } from "../src/scheduler.mjs";
import { createSecretBox } from "../src/secrets.mjs";
import { nextMidnightEt } from "../src/time.mjs";
import { startFakeOAuth2 } from "./helpers/fake-oauth2.mjs";
import { createHarness, fakeOAuthAdapter, newBinding, runOAuthLogin } from "./helpers/harness.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";
import { randomBytes } from "node:crypto";

/** A gateway manager stand-in that only keeps slot bookkeeping. */
function fakeManager() {
  /** @type {Map<string, { port: number, connectionId: string, expiredAt: number | null, startedAt: number, ready: boolean, stopping: boolean, pid: null }>} */
  const slots = new Map();
  /** @type {string[]} */
  const stopped = [];
  return {
    events: new EventEmitter(),
    slots,
    stopped,
    /** @param {string} id @param {number} port */
    add(id, port) {
      slots.set(id, { port, connectionId: id, expiredAt: null, startedAt: 0, ready: true, stopping: false, pid: null });
    },
    list: () => [...slots.values()],
    /** @param {string} id */
    portFor: (id) => slots.get(id)?.port ?? null,
    /** @param {string} id @param {number | null} at */
    markExpired(id, at) {
      const s = slots.get(id);
      if (s) s.expiredAt = at === null ? null : s.expiredAt ?? at;
    },
    /** @param {string} id */
    async stop(id) {
      slots.delete(id);
      stopped.push(id);
    },
    /** @param {number} port @param {string} [id] */
    async stopSlot(port, id) {
      for (const [cid, s] of slots) {
        if (s.port !== port || (id !== undefined && cid !== id)) continue;
        slots.delete(cid);
        stopped.push(cid);
      }
    },
  };
}

function setup() {
  let t = Date.parse("2026-11-03T15:00:00Z"); // 10:00 ET
  const now = () => t;
  const db = createMemoryDb({ now });
  const store = createStore(db);
  const cache = createCoalescingCache({ now });
  const audit = createAudit({ store, log: silentLogger, now });
  const secretBox = createSecretBox({ key: randomBytes(32), keyVersion: 1 });
  const etrade = createEtradeAdapter({ store, secretBox, limiter: createLimiter({ now }), cache, log: silentLogger, allowSandbox: true, now });
  const manager = fakeManager();
  /** @type {string[]} */
  const unwatched = [];
  const sessions = /** @type {any} */ ({ isAuthenticated: () => false, unwatch: (/** @type {string} */ id) => unwatched.push(id) });
  const locks = createLocks();
  const scheduler = createScheduler({ store, etrade, manager: /** @type {any} */ (manager), sessions, audit, cache, log: silentLogger, now, locks });
  const wid = randomUUID();
  /** @param {object} row */
  const addConn = (row) => {
    const id = randomUUID();
    db.tables.set("broker_connections", [
      ...(db.tables.get("broker_connections") ?? []),
      { id, workspace_id: wid, user_id: randomUUID(), status_detail: null, last_ok_at: new Date(t).toISOString(), ...row },
    ]);
    return id;
  };
  const get = (/** @type {string} */ id) => (db.tables.get("broker_connections") ?? []).find((c) => c.id === id);
  return { db, store, secretBox, etrade, manager, scheduler, locks, unwatched, addConn, get, now, advance: (/** @type {number} */ ms) => (t += ms) };
}

test("E*TRADE: at 00:00 ET active connections expire with the contract's sentence", async () => {
  const s = setup();
  const midnight = nextMidnightEt(s.now());
  const id = s.addConn({ broker_id: "etrade", method: "etrade_oauth1", environment: "production", status: "active", session_expires_at: new Date(midnight).toISOString() });
  await s.store.putSecret({ connection_id: id, ...s.secretBox.encrypt(id, { consumerKey: "ck", consumerSecret: "cs", accessToken: "at", accessSecret: "as" }) });

  s.advance(midnight - s.now() - 60_000); // 23:59 ET
  await s.scheduler.tick();
  assert.equal(s.get(id)?.status, "active");

  s.advance(60_000); // 00:00 ET
  await s.scheduler.tick();
  assert.equal(s.get(id)?.status, "expired");
  assert.equal(s.get(id)?.status_detail, "E*TRADE ends every session at midnight Eastern. Reconnect to continue.");
  assert.equal(ETRADE_DETAIL.midnight, s.get(id)?.status_detail);
  const secret = s.secretBox.decrypt(id, /** @type {any} */ (s.db.tables.get("broker_secrets")?.[0]));
  assert.deepEqual(secret, { consumerKey: "ck", consumerSecret: "cs" }, "dead tokens dropped, the key kept for reconnecting");
  assert.ok((s.db.tables.get("audit_events") ?? []).some((a) => a.action === "broker.session.expired" && a.actor_email === "system"));
});

test("E*TRADE: a pending code older than 5 minutes expires", async () => {
  const s = setup();
  const id = s.addConn({ broker_id: "etrade", method: "etrade_oauth1", environment: "sandbox", status: "pending", session_expires_at: new Date(s.now() + 5 * 60_000).toISOString() });
  s.advance(5 * 60_000);
  await s.scheduler.tick();
  assert.equal(s.get(id)?.status, "expired");
  assert.equal(s.get(id)?.status_detail, ETRADE_DETAIL.codeTimeout);
});

test("IBKR: a login not finished in its window expires and its slot is released at once", async () => {
  const s = setup();
  const id = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "pending", session_expires_at: new Date(s.now() + 20 * 60_000).toISOString() });
  s.manager.add(id, 7200);
  s.advance(20 * 60_000 - 1);
  await s.scheduler.tick();
  assert.equal(s.get(id)?.status, "pending");
  assert.equal(s.manager.portFor(id), 7200, "still inside the login window");

  s.advance(1);
  await s.scheduler.tick();
  assert.equal(s.get(id)?.status, "expired");
  assert.equal(s.get(id)?.status_detail, IBKR_DETAIL.loginTimeout);
  assert.deepEqual(s.unwatched, [id]);
  assert.equal(s.manager.portFor(id), null, "a login never finished holds no slot");
  assert.deepEqual(s.manager.stopped, [id]);
});

test("IBKR: a session that expired after a login keeps its slot for 30 minutes", async () => {
  const s = setup();
  const id = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "expired", session_expires_at: null });
  s.manager.add(id, 7201);
  await s.scheduler.tick(); // marks the expiry
  s.advance(29 * 60_000);
  await s.scheduler.tick();
  assert.equal(s.manager.portFor(id), 7201, "kept so Reconnect can reuse it");
  s.advance(60_000);
  await s.scheduler.tick();
  assert.equal(s.manager.portFor(id), null);
  assert.deepEqual(s.manager.stopped, [id]);
});

test("IBKR: a Reconnect pressed while the sweep runs is not undone", async () => {
  const s = setup();
  // login window over, but the user presses Reconnect (which holds the connection's lock) just then
  const id = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "pending", session_expires_at: new Date(s.now() - 1).toISOString() });
  s.manager.add(id, 7203);
  /** @type {() => void} */
  let finishRenew = () => {};
  const renew = s.locks.run(id, async () => {
    await new Promise((r) => {
      finishRenew = () => r(undefined);
    });
    const row = s.get(id);
    if (row) row.session_expires_at = new Date(s.now() + 20 * 60_000).toISOString();
  });
  const sweep = s.scheduler.tick();
  await new Promise((r) => setTimeout(r, 10));
  finishRenew();
  await renew;
  await sweep;
  assert.equal(s.get(id)?.status, "pending", "the new login window stays open");
  assert.deepEqual(s.unwatched, []);

  // expired 30 minutes ago, but a Reconnect reused the gateway (clearing its expiry) first
  const old = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "paper", status: "expired" });
  s.manager.add(old, 7204);
  const slot = /** @type {any} */ (s.manager.slots.get(old));
  slot.expiredAt = s.now() - 31 * 60_000;
  const held = s.locks.run(old, async () => {
    await new Promise((r) => setTimeout(r, 10));
    slot.expiredAt = null;
    const row = s.get(old);
    if (row) row.status = "pending";
  });
  await s.scheduler.tick();
  await held;
  assert.equal(s.manager.portFor(old), 7204, "the gateway the user is logging in to stays");
  assert.deepEqual(s.manager.stopped, []);
});

test("IBKR: a gateway whose connection is gone or disconnected is stopped at once", async () => {
  const s = setup();
  const id = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "disconnected" });
  s.manager.add(id, 7201);
  s.manager.add(randomUUID(), 7202);
  await s.scheduler.tick();
  assert.equal(s.manager.list().length, 0);
});

test("boot: IBKR sessions of the previous process are marked expired", async () => {
  const s = setup();
  const a = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "active" });
  const b = s.addConn({ broker_id: "ibkr", method: "ibkr_gateway", environment: "paper", status: "pending" });
  const c = s.addConn({ broker_id: "etrade", method: "etrade_oauth1", environment: "production", status: "active" });
  await s.scheduler.recoverOnBoot();
  assert.equal(s.get(a)?.status, "expired");
  assert.equal(s.get(a)?.status_detail, IBKR_DETAIL.serviceRestarted);
  assert.equal(s.get(b)?.status, "expired");
  assert.equal(s.get(c)?.status, "active", "E*TRADE tokens survive a restart");
});

// ─────────────────────────────────────────────────────────────── OAuth hand-offs and adapter sweeps

test("pending sweep: a login not finished in 10 minutes is removed; a Reconnect left unclaimed loses its new tokens", async () => {
  const server = await startFakeOAuth2({ sub: "sweep-user" });
  const h = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server })]] });
  try {
    const start = { brokerId: "schwab", clientId: server.cfg.clientId, clientSecret: server.cfg.clientSecret };
    const b = newBinding();
    const begun = await h.req("/v1/oauth/start", { method: "POST", body: { ...start, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    const abandonedId = begun.json.connectionId;
    h.advance(10 * 60_000 - 1_000);
    await h.svc.scheduler.tick();
    assert.ok(h.rows("broker_connections").some((x) => x.id === abandonedId), "inside the window");
    h.advance(2_000);
    await h.svc.scheduler.tick();
    assert.equal(h.rows("broker_connections").find((x) => x.id === abandonedId), undefined, "a login that never connected goes");
    assert.equal(h.rows("broker_oauth_pending").length, 0);

    const run = await runOAuthLogin(h, { start });
    const id = /** @type {any} */ (run.connection).id;
    server.revokeAccess(); // the login ended at Schwab, so Reconnect needs a new one
    const renewed = await runOAuthLogin(h, { connectionId: id, start: { brokerId: "schwab" }, skipClaim: true });
    assert.equal(renewed.failedAt, undefined);
    const sealed = () => h.svc.secretBox.decrypt(id, /** @type {any} */ (h.rows("broker_secrets").find((x) => x.connection_id === id)));
    assert.ok(sealed().accessToken, "tokens of the new login are stored, waiting for the claim");
    h.advance(5 * 60_000 + 1_000);
    await h.svc.scheduler.tick();
    const row = h.rows("broker_connections").find((x) => x.id === id);
    assert.equal(row?.status, "expired");
    assert.equal(row?.status_detail, "The login was not finished in Nasscord. Start again.");
    assert.equal(sealed().accessToken, undefined, "unclaimed tokens are dropped");
    assert.equal(sealed().clientId, server.cfg.clientId, "the user's own app stays for Reconnect");
    assert.ok(h.rows("broker_accounts").some((a) => a.connection_id === id), "the accounts and switches stay");
    assert.ok(h.rows("audit_events").some((a) => a.action === "broker.session.expired" && a.actor_email === "system"));
  } finally {
    await h.close();
    await server.close();
  }
});

test("adapter sweep: refresh() on active connections every sweepEveryMs; an ended login is expired and audited", async () => {
  const server = await startFakeOAuth2({ sub: "swept-user" });
  const h = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server, sweepEveryMs: 15 * 60_000 })]] });
  try {
    const run = await runOAuthLogin(h, { start: { brokerId: "schwab", clientId: server.cfg.clientId, clientSecret: server.cfg.clientSecret } });
    const id = /** @type {any} */ (run.connection).id;
    await h.svc.scheduler.tick();
    const calls = server.state.calls.filter((c) => c.path === "/api/me").length;
    await h.svc.scheduler.tick();
    assert.equal(server.state.calls.filter((c) => c.path === "/api/me").length, calls, "not again before sweepEveryMs");
    assert.equal(h.rows("broker_connections").find((x) => x.id === id)?.status, "active");

    server.revokeAccess(); // the broker revoked Nasscord's grant
    h.advance(15 * 60_000);
    await h.svc.scheduler.tick();
    const row = h.rows("broker_connections").find((x) => x.id === id);
    assert.equal(row?.status, "expired");
    assert.equal(row?.status_detail, "Schwab requires a new login. Reconnect to continue.");
    assert.ok(h.rows("audit_events").some((a) => a.action === "broker.session.expired" && String(a.target).includes(id)));
  } finally {
    await h.close();
    await server.close();
  }
});
