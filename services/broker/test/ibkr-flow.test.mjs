import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createBrokerService } from "../src/server.mjs";
import { call, jwtFor, listen, sleep, testConfig } from "./helpers/common.mjs";
import { createGatewayState, fakeBundle, fakeGatewaySpawner, freePorts } from "./helpers/fake-gateway.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

const user = randomUUID();
const wid = randomUUID();
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
/** @type {string} */
let connectionId;
/** @type {number[]} */
let ports;

before(async () => {
  ports = await freePorts(2);
  db = createMemoryDb();
  db.tables.set("workspaces", [{ id: wid, name: "Swing Desk" }]);
  db.tables.set("members", [{ user_id: user, email: "trader.one@example.com", role: "trader", workspace_id: wid }]);
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

const conn = () => (db.tables.get("broker_connections") ?? []).find((c) => c.id === connectionId);
/** @param {string} id */
const conn2 = (id) => (db.tables.get("broker_connections") ?? []).find((c) => c.id === id);

/**
 * @param {string} p
 * @param {string} [cookie]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function loginGet(p, cookie) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: login.port, path: p, agent: false, headers: cookie ? { cookie } : {} }, (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      })
      .on("error", reject);
  });
}

/**
 * Opens a login URL like a browser: the confirmation page, then Continue. Returns the cookie.
 * @param {string} loginUrl
 */
async function openLogin(loginUrl) {
  const u = new URL(loginUrl);
  const page = await loginGet(u.pathname + u.search);
  assert.equal(page.status, 200, page.body);
  const ticket = String(u.searchParams.get("t"));
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: login.port,
        method: "POST",
        path: "/start",
        agent: false,
        headers: { "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${login.port}`, "sec-fetch-site": "same-origin" },
      },
      (r) => {
        r.resume();
        r.on("end", () => resolve(r));
      },
    );
    req.on("error", reject);
    req.end(`t=${encodeURIComponent(ticket)}`);
  });
  const r = /** @type {http.IncomingMessage} */ (res);
  assert.equal(r.statusCode, 303);
  return { page, cookie: /** @type {string[]} */ (r.headers["set-cookie"])[0].split(";")[0] };
}

const gatewaysAlive = () => state.procs.filter((p) => p.exitCode === null && p.signalCode === null).length;

test("start: a gateway on a slot port, a pending connection and a one-time login URL", async () => {
  const r = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "production" } });
  assert.equal(r.status, 200, r.text);
  connectionId = r.json.connectionId;
  assert.match(r.json.loginUrl, /^http:\/\/localhost:8711\/start\?t=/);
  assert.equal(svc.manager.portFor(connectionId), ports[0]);
  assert.equal(conn()?.status, "pending");
  assert.equal(conn()?.method, "ibkr_gateway");
  assert.equal(await svc.manager.whenReady(connectionId), true);

  // the confirmation page names the workspace and the user, then the login page through the login host
  const { page: confirm, cookie } = await openLogin(r.json.loginUrl);
  assert.match(confirm.body, /the Nasscord workspace <strong>Swing Desk<\/strong> \(a name its owner chose\), at the request of <strong>t•••@example\.com<\/strong>/);
  const root = await loginGet("/", cookie);
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, "/sso/Login?forwardTo=22&RL=1&ip2loc=US");
  const page = await loginGet(String(root.headers.location), cookie);
  assert.equal(page.status, 200);
  assert.match(page.body, /loginformWrapper/);
  const status = await loginGet("/v1/api/iserver/auth/status", cookie);
  assert.equal(status.status, 401, "not logged in yet");
  assert.equal((await loginGet("/v1/api/iserver/accounts", cookie)).status, 403);

  // a second press of Connect reuses the same gateway
  const again = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "production" } });
  assert.equal(again.json.connectionId, connectionId);
  assert.equal(svc.manager.stats().running, 1);
});

test("while the login is pending the connection stays pending", async () => {
  await svc.sessions.tick(connectionId);
  const r = await call(`${api.url}/v1/connections/${connectionId}`, { token: token() });
  assert.equal(r.status, 200);
  assert.equal(r.json.connection.status, "pending");
  assert.match(r.json.connection.statusDetail, /Log in on the IBKR page/);
});

test("first authenticated status: ssodh/init without compete, accounts discovered, active for 24 h", async () => {
  state.loggedIn = true;
  const t0 = Date.now();
  await svc.sessions.tick(connectionId);
  const init = state.requests.filter((q) => q.path === "/v1/api/iserver/auth/ssodh/init");
  assert.ok(init.length >= 1);
  for (const q of init) assert.deepEqual(JSON.parse(q.body), { publish: true, compete: false });
  assert.ok(
    state.requests.every((q) => !/"compete"\s*:\s*true/.test(q.body)),
    "the service never competes for the session",
  );
  const r = await call(`${api.url}/v1/connections/${connectionId}`, { token: token() });
  const c = r.json.connection;
  assert.equal(c.status, "active");
  assert.equal(c.statusDetail, null);
  const exp = Date.parse(c.sessionExpiresAt);
  assert.ok(Math.abs(exp - (t0 + 24 * 3_600_000)) < 60_000);
  assert.deepEqual(
    c.accounts.map((/** @type {any} */ a) => [a.displayNumber, a.type, a.label]),
    [["U12•••67", "margin", "IBKR Margin"], ["U76•••21", "individual", "IBKR Individual"]],
  );
  // every POST the service sent had a body and a length (IBKR's edge refuses POSTs without one)
  assert.ok(state.requests.filter((q) => q.method === "POST").every((q) => q.headers["content-length"] !== undefined));
  assert.ok(state.requests.every((q) => q.headers.connection === "close"), "a fresh loopback connection per call");
});

test("portfolio: summary, paged positions and partitioned day P&L", async () => {
  const r = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.errors, []);
  const accounts = db.tables.get("broker_accounts") ?? [];
  const main = accounts.find((a) => a.external_id === "U1234567");
  const summary = r.json.accounts.find((/** @type {any} */ a) => a.accountId === main?.id);
  assert.deepEqual(summary, { accountId: main?.id, netLiq: 250000.5, buyingPower: 1000000, cash: 50000, dayPnl: 812.5, currency: "USD" });
  assert.equal(r.json.positions.length, 32, "30 on page 0 and 2 on page 1");
  const pages = state.requests.filter((q) => /\/portfolio\/U1234567\/positions\//.test(q.path)).map((q) => q.path.split("/").at(-1));
  assert.deepEqual([...new Set(pages)], ["0", "1"]);
  assert.equal(r.json.positions[0].brokerId, "ibkr");
  assert.equal(r.json.positions[0].accountId, main?.id);
});

test("orders and executions: only included accounts, Nasscord shapes", async () => {
  const o = await call(`${api.url}/v1/orders`, { token: token() });
  assert.equal(o.json.orders.length, 1, "orders of unknown accounts are dropped");
  assert.deepEqual(
    [o.json.orders[0].symbol, o.json.orders[0].type, o.json.orders[0].price, o.json.orders[0].status, o.json.orders[0].tif],
    ["AVGO", "LMT", 189.9, "working", "GTC"],
  );
  const e = await call(`${api.url}/v1/executions`, { token: token() });
  assert.equal(e.json.executions.length, 1);
  assert.equal(e.json.executions[0].net, -2074.24);
  assert.ok(state.requests.some((q) => q.path === "/v1/api/iserver/account/trades?days=7"));
});

test("after the login the login host shows the done page", async () => {
  const ticket = svc.tokens.issueTicket(connectionId);
  const { cookie } = await openLogin(`http://localhost:8711/start?t=${encodeURIComponent(ticket)}`);
  const root = await loginGet("/", cookie);
  assert.equal(root.headers.location, "/done");
});

test("competing session: the status detail says so", async () => {
  state.competing = true;
  await svc.sessions.tick(connectionId);
  assert.match(String(conn()?.status_detail), /Another session \(TWS or the IBKR mobile app\)/);
  state.competing = false;
  await svc.sessions.tick(connectionId);
  assert.equal(conn()?.status_detail, null);
  assert.equal(conn()?.status, "active");
});

test("IBKR ending the session expires the connection; renew reuses the running gateway", async () => {
  state.loggedIn = false;
  state.bridge = false;
  await svc.sessions.tick(connectionId);
  assert.equal(conn()?.status, "expired");
  assert.match(String(conn()?.status_detail), /IBKR ended the session/);
  const p = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.deepEqual(p.json, { accounts: [], positions: [], errors: [] }, "expired connections are not read");

  const renew = await call(`${api.url}/v1/connections/${connectionId}/renew`, { method: "POST", token: token() });
  assert.equal(renew.status, 200, renew.text);
  assert.equal(renew.json.connection.status, "pending");
  assert.match(renew.json.loginUrl, /\/start\?t=/);
  assert.equal(state.procs.length, 1, "same JVM");
  state.loggedIn = true;
  await svc.sessions.tick(connectionId);
  assert.equal(conn()?.status, "active");
});

test("a gateway that dies takes the session with it and frees its slot", async () => {
  state.procs[0].crash();
  for (let i = 0; i < 50 && svc.manager.portFor(connectionId); i++) await sleep(20);
  assert.equal(svc.manager.portFor(connectionId), null);
  await sleep(20);
  assert.equal(conn()?.status, "expired");
  assert.match(String(conn()?.status_detail), /stopped unexpectedly/);

  state.loggedIn = false;
  const renew = await call(`${api.url}/v1/connections/${connectionId}/renew`, { method: "POST", token: token() });
  assert.equal(renew.status, 200);
  assert.equal(state.procs.length, 2, "a new gateway");
  assert.ok(svc.manager.portFor(connectionId));
});

test("disconnect logs out, stops the gateway and clears accounts", async () => {
  state.loggedIn = true;
  await svc.manager.whenReady(connectionId);
  await svc.sessions.tick(connectionId);
  const r = await call(`${api.url}/v1/connections/${connectionId}`, { method: "DELETE", token: token() });
  assert.equal(r.status, 200);
  assert.ok(state.requests.some((q) => q.path === "/v1/api/logout"));
  assert.equal(svc.manager.portFor(connectionId), null);
  assert.equal(conn()?.status, "disconnected");
  assert.equal((db.tables.get("broker_accounts") ?? []).filter((a) => a.connection_id === connectionId).length, 0);
  assert.equal(svc.manager.stats().running, 0);
});

test("Connect again: reuses an expired connection of the same environment, a new one after disconnect", async () => {
  const first = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "paper" } });
  assert.equal(first.status, 200, first.text);
  const paperId = first.json.connectionId;
  assert.notEqual(paperId, connectionId, "the disconnected live connection is not revived");
  const row = (db.tables.get("broker_connections") ?? []).find((c) => c.id === paperId);
  if (row) Object.assign(row, { status: "expired", status_detail: "x" });
  const again = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "paper" } });
  assert.equal(again.json.connectionId, paperId);
  assert.equal((db.tables.get("broker_connections") ?? []).find((c) => c.id === paperId)?.status, "pending");
  assert.equal(svc.manager.stats().running, 1);
  await call(`${api.url}/v1/connections/${paperId}`, { method: "DELETE", token: token() });
  assert.equal(svc.manager.stats().running, 0);
});

// ───────────────────────────── races and re-logins (review findings)

/** A live IBKR connection on its own gateway, logged in, with the two default accounts. */
async function liveConnection() {
  state.loggedIn = false;
  state.bridge = false;
  state.accounts = ["U1234567", "U7654321"];
  const r = await call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "production" } });
  assert.equal(r.status, 200, r.text);
  const id = r.json.connectionId;
  assert.equal(await svc.manager.whenReady(id), true);
  state.loggedIn = true;
  await svc.sessions.tick(id);
  const row = (db.tables.get("broker_connections") ?? []).find((c) => c.id === id);
  assert.equal(row?.status, "active");
  return id;
}

test("Connect and Reconnect at the same moment start one gateway; Disconnect leaves none running", async () => {
  const id = await liveConnection();
  // the gateway dies: the connection expires and the slot is released
  state.procs.at(-1).crash();
  for (let i = 0; i < 50 && svc.manager.portFor(id); i++) await sleep(10);
  assert.equal(svc.manager.portFor(id), null);
  state.loggedIn = false;
  const before = state.procs.length;

  const [a, b, c] = await Promise.all([
    call(`${api.url}/v1/ibkr/start`, { method: "POST", token: token(), body: { environment: "production" } }),
    call(`${api.url}/v1/connections/${id}/renew`, { method: "POST", token: token() }),
    call(`${api.url}/v1/connections/${id}/renew`, { method: "POST", token: token() }),
  ]);
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
  assert.equal(a.json.connectionId, id, "Connect reused the expired connection");
  assert.equal(state.procs.length, before + 1, "one JVM for the connection");
  assert.equal(svc.manager.stats().running, 1);
  assert.equal(gatewaysAlive(), 1);

  const del = await call(`${api.url}/v1/connections/${id}`, { method: "DELETE", token: token() });
  assert.equal(del.status, 200);
  await svc.scheduler.tick();
  assert.equal(svc.manager.stats().running, 0);
  assert.equal(gatewaysAlive(), 0, "no orphaned gateway");
});

test("Reconnect while the old gateway is still stopping: the login on the new one is noticed", async () => {
  const id = await liveConnection();
  const oldPort = /** @type {number} */ (svc.manager.portFor(id));
  // IBKR ends the session, the connection expires, and the slot is due for release
  state.loggedIn = false;
  state.bridge = false;
  await svc.sessions.tick(id);
  assert.equal(conn2(id)?.status, "expired");

  state.exitDelayMs = 300; // a real JVM takes a while to exit
  try {
    const releasing = svc.manager.stopSlot(oldPort, id); // what the scheduler does 30 minutes after expiry
    const renew = await call(`${api.url}/v1/connections/${id}/renew`, { method: "POST", token: token() });
    assert.equal(renew.status, 200, renew.text);
    assert.equal(renew.json.connection.status, "pending");
    await releasing;
    assert.ok(svc.sessions.watchedIds().includes(id), "the new gateway is watched after the old one exited");
    assert.equal(gatewaysAlive(), 1);

    // an exit event of another (older) gateway of this connection says nothing about the current one
    const current = svc.manager.portFor(id);
    svc.manager.events.emit("exit", { connectionId: id, port: current === ports[0] ? ports[1] : ports[0], code: 0, signal: null, expected: false });
    assert.ok(svc.sessions.watchedIds().includes(id));
    assert.equal(conn2(id)?.status, "pending");

    state.loggedIn = true;
    await svc.sessions.tick(id);
    assert.equal(conn2(id)?.status, "active", "the login was noticed");
    assert.equal(svc.sessions.isAuthenticated(id), true);
  } finally {
    state.exitDelayMs = 0;
  }
  await call(`${api.url}/v1/connections/${id}`, { method: "DELETE", token: token() });
});

test("logging in again with another IBKR username drops the accounts of the earlier login", async () => {
  const id = await liveConnection();
  const accounts = () => (db.tables.get("broker_accounts") ?? []).filter((a) => a.connection_id === id).map((a) => a.external_id).sort();
  assert.deepEqual(accounts(), ["U1234567", "U7654321"]);

  // competing session warning; the user reconnects with a second IBKR username
  state.loggedIn = false;
  state.bridge = false;
  await svc.sessions.tick(id);
  const renew = await call(`${api.url}/v1/connections/${id}/renew`, { method: "POST", token: token() });
  assert.equal(renew.status, 200);
  state.accounts = ["U5555555"];
  state.loggedIn = true;
  await svc.sessions.tick(id);
  assert.equal(conn2(id)?.status, "active");
  assert.deepEqual(accounts(), ["U5555555"]);

  const seenBefore = state.requests.length;
  const p = await call(`${api.url}/v1/portfolio`, { token: token() });
  assert.deepEqual(p.json.errors, []);
  assert.equal(p.json.accounts.length, 1);
  const asked = state.requests.slice(seenBefore).map((q) => q.path).filter((q) => q.startsWith("/v1/api/portfolio/U"));
  assert.ok(asked.every((q) => q.includes("U5555555")), "accounts of the earlier login are never queried");
  await call(`${api.url}/v1/connections/${id}`, { method: "DELETE", token: token() });
  state.accounts = ["U1234567", "U7654321"];
});

test("one IBKR account that cannot be read does not hide the others", async () => {
  const id = await liveConnection();
  state.failSummary.add("U7654321");
  try {
    svc.cache.invalidate(id);
    const p = await call(`${api.url}/v1/portfolio`, { token: token() });
    assert.equal(p.status, 200);
    assert.equal(p.json.accounts.length, 1, "the readable account is answered");
    assert.equal(p.json.positions.length, 32);
    assert.equal(p.json.errors.length, 1);
    assert.equal(p.json.errors[0].connectionId, id);
    assert.match(p.json.errors[0].message, /^IBKR account U76•••21: IBKR answered with an error \(500\)/);
  } finally {
    state.failSummary.clear();
  }
  await call(`${api.url}/v1/connections/${id}`, { method: "DELETE", token: token() });
});
