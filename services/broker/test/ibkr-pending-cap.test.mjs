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
 * IBKR_MAX_PENDING_LOGINS: gateways waiting for a login are capped, so logins that are started and
 * never finished cannot take every slot. A connection that already has a gateway reuses it.
 */

const one = { sub: randomUUID(), wid: randomUUID() };
const two = { sub: randomUUID(), wid: randomUUID() };
const state = createGatewayState();
const runtime = mkdtempSync(path.join(os.tmpdir(), "nasscord-rt-"));
const bundle = fakeBundle();

/** @type {ReturnType<typeof createBrokerService>} */
let svc;
/** @type {Awaited<ReturnType<typeof listen>>} */
let api;

before(async () => {
  const ports = await freePorts(2);
  const db = createMemoryDb();
  db.tables.set("workspaces", [
    { id: one.wid, name: "Desk One" },
    { id: two.wid, name: "Desk Two" },
  ]);
  db.tables.set("members", [
    { user_id: one.sub, email: "one@example.com", role: "trader", workspace_id: one.wid },
    { user_id: two.sub, email: "two@example.com", role: "trader", workspace_id: two.wid },
  ]);
  svc = createBrokerService(
    testConfig({
      IBKR_GATEWAY_BUNDLE: bundle,
      IBKR_GATEWAY_RUNTIME: runtime,
      IBKR_GATEWAY_PORTS: `${ports[0]}-${ports[1]}`,
      IBKR_MAX_PENDING_LOGINS: "1",
    }),
    { db, spawn: fakeGatewaySpawner(state) },
  );
  api = await listen((req, res) => svc.api.handle(req, res));
});

after(async () => {
  svc.sessions.stopAll();
  await svc.manager.stopAll();
  await api?.close();
  rmSync(runtime, { recursive: true, force: true });
  rmSync(bundle, { recursive: true, force: true });
});

/** @param {{ sub: string, wid: string }} who */
const start = (who) => call(`${api.url}/v1/ibkr/start`, { method: "POST", token: jwtFor(who), body: { environment: "paper" } });

test("a second login waiting at once is refused while a slot is still free; the first one is reused", async () => {
  const first = await start(one);
  assert.equal(first.status, 200);
  assert.equal(svc.manager.list().length, 1);

  const second = await start(two);
  assert.equal(second.status, 503);
  assert.equal(second.json.code, "too_many_pending");
  assert.match(second.json.error, /Too many IBKR logins are waiting/);
  assert.equal(svc.manager.list().length, 1, "no second gateway was started");

  const again = await start(one);
  assert.equal(again.status, 200, "Connect again reuses the waiting gateway");
  assert.equal(again.json.connectionId, first.json.connectionId);
  assert.equal(svc.manager.list().length, 1);
});
