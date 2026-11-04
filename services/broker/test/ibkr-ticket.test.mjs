import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createBrokerService } from "../src/server.mjs";
import { call, jwtFor, listen, testConfig } from "./helpers/common.mjs";
import { createGatewayState, fakeBundle, fakeGatewaySpawner, freePorts } from "./helpers/fake-gateway.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/*
 * POST /v1/ibkr/:id/ticket: the app's GET /api/broker/ibkr/login/[id] asks for a fresh one-time
 * login link at the moment the signed-in user opens the IBKR login (contract section 7).
 */

const user = randomUUID();
const wid = randomUUID();
const otherWid = randomUUID();
const etradeId = randomUUID();
const token = () => jwtFor({ sub: user, wid });
const state = createGatewayState();
const runtime = mkdtempSync(path.join(os.tmpdir(), "nasscord-rt-"));
const bundle = fakeBundle();

/** @type {ReturnType<typeof createMemoryDb>} */
let db;
/** @type {ReturnType<typeof createBrokerService>} */
let svc;
/** @type {Awaited<ReturnType<typeof listen>>} */
let api;
/** @type {Awaited<ReturnType<typeof listen>>} */
let login;

before(async () => {
  const ports = await freePorts(2);
  db = createMemoryDb();
  db.tables.set("workspaces", [{ id: wid, name: "Swing Desk" }]);
  db.tables.set("members", [{ user_id: user, email: "trader.one@example.com", role: "trader", workspace_id: wid }]);
  db.tables.set("broker_connections", [
    { id: etradeId, workspace_id: wid, user_id: user, broker_id: "etrade", method: "etrade_oauth1", environment: "production", status: "active", status_detail: null, session_expires_at: null, last_ok_at: null },
  ]);
  svc = createBrokerService(
    testConfig({
      IBKR_GATEWAY_BUNDLE: bundle,
      IBKR_GATEWAY_RUNTIME: runtime,
      IBKR_GATEWAY_PORTS: `${ports[0]}-${ports[1]}`,
      PUBLIC_LOGIN_URL: "http://localhost:8711",
    }),
    { db, spawn: fakeGatewaySpawner(state) },
  );
  api = await listen((req, res) => svc.api.handle(req, res));
  login = await listen((req, res) => svc.login.handle(req, res));
});

after(async () => {
  svc.sessions.stopAll();
  await svc.manager.stopAll();
  await api?.close();
  await login?.close();
  rmSync(runtime, { recursive: true, force: true });
  rmSync(bundle, { recursive: true, force: true });
});

/** The IBKR connection the first test started. */
const ibkrId = () => String((db.tables.get("broker_connections") ?? []).find((c) => c.broker_id === "ibkr")?.id);

/** @param {string} id @param {string} [t] */
const ticket = (id, t = token()) => call(`${api.url}/v1/ibkr/${id}/ticket`, { method: "POST", token: t });

test("a running gateway gets a fresh one-time login link that the login host accepts", async () => {
  const start = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "paper" } });
  assert.equal(start.status, 200, start.text);
  const id = start.json.connectionId;
  assert.equal(await svc.manager.whenReady(id), true);

  const r = await ticket(id);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ["loginUrl"]);
  const url = new URL(r.json.loginUrl);
  assert.equal(url.origin, "http://localhost:8711");
  assert.equal(url.pathname, "/start");
  const t = String(url.searchParams.get("t"));
  assert.equal(svc.tokens.peekTicket(t), id, "the ticket names this connection");
  assert.notEqual(t, new URL(start.json.loginUrl).searchParams.get("t"), "a new ticket, not the one start returned");

  // the confirmation page on the login host opens with it
  const page = await call(`${login.url}/start?t=${encodeURIComponent(t)}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Swing Desk/);

  // asking again gives another ticket: each open of the login gets its own
  const again = await ticket(id);
  assert.notEqual(again.json.loginUrl, r.json.loginUrl);

  const audit = (db.tables.get("audit_events") ?? []).filter((e) => e.action === "broker.ibkr.login_link");
  assert.ok(audit.length >= 2, "every link is audited");
  assert.ok(audit.every((e) => e.result === "ok" && e.workspace_id === wid));
});

test("another workspace's connection is a 404 and gets no ticket", async () => {
  const id = ibkrId();
  assert.ok(id);
  const r = await ticket(id, jwtFor({ wid: otherWid }));
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "Connection not found.", code: "not_found" });
  assert.equal((await ticket(randomUUID())).status, 404, "unknown id");
});

test("no token, no workspace, or the tenant role: refused", async () => {
  const id = ibkrId();
  assert.equal((await call(`${api.url}/v1/ibkr/${id}/ticket`, { method: "POST" })).status, 401);
  assert.equal((await ticket(id, jwtFor({ sub: user, wid: null }))).status, 403);
  assert.equal((await ticket(id, jwtFor({ sub: user, wid, role: "tenant" }))).status, 403);
  assert.equal((await call(`${api.url}/v1/ibkr/${id}/ticket`, { token: token() })).status, 405, "POST only");
});

test("an E*TRADE connection has no IBKR login", async () => {
  const r = await ticket(etradeId);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not an IBKR connection/);
});

test("without a running gateway the answer says to Reconnect; after a disconnect it says to connect again", async () => {
  const id = ibkrId();
  await svc.manager.stop(id);
  assert.equal(svc.manager.portFor(id), null);
  const stopped = await ticket(id);
  assert.equal(stopped.status, 409);
  assert.equal(stopped.json.code, "no_gateway");
  assert.match(stopped.json.error, /Press Reconnect/);
  assert.equal(state.procs.filter((p) => p.exitCode === null && p.signalCode === null).length, 0, "asking for a link starts no gateway");

  const del = await call(`${api.url}/v1/connections/${id}`, { method: "DELETE", token: token() });
  assert.equal(del.status, 200);
  const gone = await ticket(id);
  assert.equal(gone.status, 409);
  assert.equal(gone.json.code, "disconnected");
});
