import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createStore } from "../src/db.mjs";
import { IBKR_DETAIL, createIbkrSessions } from "../src/ibkr/session.mjs";
import { createLocks } from "../src/locks.mjs";
import { silentLogger } from "../src/log.mjs";
import { sleep } from "./helpers/common.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/**
 * The keepalive on its own, against a gateway manager stand-in whose gateway stops answering.
 */
function setup() {
  const db = createMemoryDb();
  const store = createStore(db);
  const cid = randomUUID();
  db.tables.set("broker_connections", [
    { id: cid, workspace_id: randomUUID(), user_id: randomUUID(), broker_id: "ibkr", method: "ibkr_gateway", environment: "production", status: "pending", status_detail: IBKR_DETAIL.pending, session_expires_at: null, last_ok_at: null },
  ]);
  /** @type {Map<string, number>} */
  const ports = new Map([[cid, 7300]]);
  /** @type {Array<[string, number | null]>} */
  const expired = [];
  let restarts = 0;
  const manager = {
    events: new EventEmitter(),
    /** @param {string} id */
    portFor: (id) => ports.get(id) ?? null,
    isReady: () => true,
    whenReady: async () => true,
    /** @param {string} id */
    async restart(id) {
      restarts++;
      ports.set(id, 7301);
      return 7301;
    },
    /** @param {string} id @param {number | null} at */
    markExpired: (id, at) => expired.push([id, at]),
  };
  const gw = {
    /** @param {string} _c @param {number} port */
    get: async (_c, port) => {
      if (port === 7300) throw new Error("socket hang up");
      return { status: 401, json: null };
    },
    post: async () => ({ status: 200, json: {} }),
  };
  const locks = createLocks();
  const sessions = createIbkrSessions({
    manager: /** @type {any} */ (manager),
    gw: /** @type {any} */ (gw),
    store,
    log: silentLogger,
    locks,
    setTimer: () => /** @type {any} */ ({ unref() {} }),
    clearTimer: () => {},
  });
  const row = () => (db.tables.get("broker_connections") ?? [])[0];
  return { cid, sessions, locks, manager, row, expired, restarts: () => restarts };
}

test("a gateway that stops answering is replaced; the connection says so", async () => {
  const s = setup();
  s.sessions.watch(s.cid);
  for (let i = 0; i < 3; i++) await s.sessions.tick(s.cid);
  assert.equal(s.restarts(), 1);
  assert.equal(s.row()?.status, "error");
  assert.equal(s.row()?.status_detail, IBKR_DETAIL.gatewayStopped);
  assert.deepEqual(s.sessions.watchedIds(), [], "nobody is logging in: the new gateway waits for Reconnect");
  assert.ok(s.expired.some(([id, at]) => id === s.cid && at !== null), "released 30 minutes later if unused");
});

test("a Reconnect pressed while the keepalive gives up keeps its login: the new gateway is watched", async () => {
  const s = setup();
  s.sessions.watch(s.cid);
  await s.sessions.tick(s.cid);
  await s.sessions.tick(s.cid);

  // Reconnect holds the connection's lock...
  /** @type {() => void} */
  let finish = () => {};
  const reconnect = s.locks.run(s.cid, async () => {
    await new Promise((r) => {
      finish = () => r(undefined);
    });
  });
  await sleep(5);
  // ...while the third failure ends the watch and waits for that lock to replace the gateway
  const ticking = s.sessions.tick(s.cid);
  await sleep(5);
  assert.equal(s.restarts(), 0, "nothing happens while Reconnect holds the lock");
  // Reconnect re-watches the (still broken) gateway and opens a login window
  s.sessions.watch(s.cid);
  const r = s.row();
  if (r) Object.assign(r, { status: "pending", status_detail: IBKR_DETAIL.pending });
  finish();
  await reconnect;
  await ticking;

  assert.equal(s.restarts(), 1);
  assert.equal(s.row()?.status, "pending", "the user's login window stays open");
  assert.deepEqual(s.sessions.watchedIds(), [s.cid], "and the new gateway is watched");
  // the watch is on the new gateway: an exit of the old one does not end it
  s.manager.events.emit("exit", { connectionId: s.cid, port: 7300, code: null, signal: "SIGTERM", expected: true });
  assert.deepEqual(s.sessions.watchedIds(), [s.cid]);
  s.manager.events.emit("exit", { connectionId: s.cid, port: 7301, code: 1, signal: null, expected: false });
  assert.deepEqual(s.sessions.watchedIds(), [], "an exit of the gateway it watches does");
});
