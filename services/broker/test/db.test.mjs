import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createDb, createStore, DbError, encodeFilter } from "../src/db.mjs";
import { listen } from "./helpers/common.mjs";

/** @type {Array<{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders, body: string }>} */
const seen = [];
/** @type {Awaited<ReturnType<typeof listen>>} */
let rest;
let failNext = false;

before(async () => {
  rest = await listen((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (failNext) {
        failNext = false;
        res.writeHead(409, { "content-type": "application/json" });
        return res.end(JSON.stringify({ code: "23505", message: "duplicate key value violates unique constraint" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "row-1" }]));
    });
  });
});
after(() => rest?.close());

test("filters encode to PostgREST syntax", () => {
  assert.equal(encodeFilter("id", "abc"), "id=eq.abc");
  assert.equal(encodeFilter("status", ["in", ["active", "pending"]]), `status=in.${encodeURIComponent('("active","pending")')}`);
  assert.equal(encodeFilter("session_expires_at", ["lte", "2026-11-04T05:00:00.000Z"]), "session_expires_at=lte.2026-11-04T05%3A00%3A00.000Z");
  assert.equal(encodeFilter("status_detail", null), "status_detail=is.null");
  assert.equal(encodeFilter("included", true), "included=eq.true");
  assert.throws(() => encodeFilter("id; drop", "x"), DbError);
  assert.throws(() => encodeFilter("id", ["like", "x"]), DbError);
});

test("calls go to /rest/v1 with the service role and the right Prefer headers", async () => {
  const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig";
  const db = createDb({ url: `${rest.url}/`, serviceRoleKey: jwtLike });
  seen.length = 0;
  await db.select("broker_connections", { filters: { workspace_id: "w1", status: "active" }, order: "created_at.asc" });
  await db.insert("audit_events", { action: "x" });
  await db.update("broker_connections", { id: "c1" }, { status: "expired" });
  await db.upsert("broker_accounts", [{ connection_id: "c1", external_id: "U1" }], { onConflict: "connection_id,external_id" });
  await db.remove("broker_secrets", { connection_id: "c1" });

  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [
    "GET /rest/v1/broker_connections?select=*&workspace_id=eq.w1&status=eq.active&order=created_at.asc",
    "POST /rest/v1/audit_events",
    "PATCH /rest/v1/broker_connections?id=eq.c1",
    "POST /rest/v1/broker_accounts?on_conflict=connection_id%2Cexternal_id",
    "DELETE /rest/v1/broker_secrets?connection_id=eq.c1",
  ]);
  for (const s of seen) {
    assert.equal(s.headers.apikey, jwtLike);
    assert.equal(s.headers.authorization, `Bearer ${jwtLike}`);
  }
  assert.equal(seen[1].headers.prefer, "return=representation");
  assert.equal(seen[3].headers.prefer, "resolution=merge-duplicates,return=representation");
  assert.deepEqual(JSON.parse(seen[2].body), { status: "expired" });
});

test("a new-style secret key (not a JWT) goes in apikey only", async () => {
  const db = createDb({ url: rest.url, serviceRoleKey: "sb_secret_abcdef" });
  seen.length = 0;
  await db.select("members", { filters: { user_id: "u" }, columns: "email" });
  assert.equal(seen[0].headers.apikey, "sb_secret_abcdef");
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].url, "/rest/v1/members?select=email&user_id=eq.u");
});

test("errors become DbError with the status and code; unfiltered writes are refused", async () => {
  const db = createDb({ url: rest.url, serviceRoleKey: "k" });
  failNext = true;
  await assert.rejects(db.insert("broker_connections", {}), (e) => e instanceof DbError && e.status === 409 && e.code === "23505");
  assert.throws(() => db.update("broker_connections", {}, { status: "x" }), DbError);
  assert.throws(() => db.remove("broker_connections", {}), DbError);
  const store = createStore(db);
  assert.deepEqual(await store.listAccounts([]), [], "no query for an empty id list");
});

test("the hand-off and aggregator-user calls: single-use updates and deletes, one-login lookup", async () => {
  const store = createStore(createDb({ url: rest.url, serviceRoleKey: "k" }));
  seen.length = 0;
  const hash = "a".repeat(64);
  await store.putPending({ connection_id: "c1", binding_hash: hash, return_origin: "https://nasscord.com", expires_at: "2026-11-16T12:10:00.000Z" });
  await store.advancePending({ state_hash: hash }, ["authorize"], { stage: "exchanging", state_hash: null });
  await store.takePendingClaim("c1", hash);
  await store.listExpiredPending("2026-11-16T12:00:00.000Z");
  await store.findConnectionByRef({ workspaceId: "w1", brokerId: "schwab", environment: "production", externalRef: "sub:1" });
  await store.getAggregatorUser("w1");
  await store.deleteAggregatorUser("w1");

  assert.deepEqual(
    seen.map((s) => `${s.method} ${decodeURIComponent(s.url)}`),
    [
      "POST /rest/v1/broker_oauth_pending?on_conflict=connection_id",
      `PATCH /rest/v1/broker_oauth_pending?state_hash=eq.${hash}&stage=in.("authorize")`,
      `DELETE /rest/v1/broker_oauth_pending?connection_id=eq.c1&ticket_hash=eq.${hash}&stage=eq.claim`,
      "GET /rest/v1/broker_oauth_pending?select=*&expires_at=lte.2026-11-16T12:00:00.000Z&order=expires_at.asc&limit=200",
      "GET /rest/v1/broker_connections?select=*&workspace_id=eq.w1&broker_id=eq.schwab&environment=eq.production&external_ref=eq.sub:1&status=neq.disconnected&order=created_at.asc",
      "GET /rest/v1/broker_aggregator_users?select=*&workspace_id=eq.w1",
      "DELETE /rest/v1/broker_aggregator_users?workspace_id=eq.w1",
    ],
  );
  const put = JSON.parse(seen[0].body);
  assert.deepEqual(
    { stage: put.stage, state_hash: put.state_hash, ticket_hash: put.ticket_hash, external_ref: put.external_ref },
    { stage: "start", state_hash: null, ticket_hash: null, external_ref: null },
    "a new login resets the row",
  );
  assert.equal(seen[1].headers.prefer, "return=representation", "the update answers the row it took");
  assert.equal(seen[2].headers.prefer, "return=representation", "the delete answers the row it took");
});

test("the memory database refuses what the migration's checks refuse", async () => {
  const { createMemoryDb } = await import("./helpers/memory-db.mjs");
  const db = createMemoryDb();
  const base = { workspace_id: "w1", user_id: "u1", status: "active" };
  /** @param {Record<string, unknown>} row */
  const insert = (row) => db.insert("broker_connections", { ...base, ...row });
  // Existing rows stay valid.
  await insert({ broker_id: "ibkr", method: "ibkr_gateway", environment: "paper" });
  await insert({ broker_id: "etrade", method: "etrade_oauth1", environment: "sandbox" });
  await insert({ broker_id: "alpaca", method: "alpaca_key", environment: "paper", external_ref: "acct-1" });
  await insert({ broker_id: "webull", method: "webull_oauth", environment: "sandbox" });
  await insert({ broker_id: "webull", method: "snaptrade", environment: "production", external_ref: "auth-1" });
  for (const [row, why] of /** @type {Array<[Record<string, unknown>, RegExp]>} */ ([
    [{ broker_id: "vanguard", method: "snaptrade", environment: "production" }, /broker_id_check/],
    [{ broker_id: "alpaca", method: "schwab_oauth", environment: "production" }, /method_broker_check/],
    [{ broker_id: "alpaca", method: "alpaca_key", environment: "sandbox" }, /sandbox_check/],
    [{ broker_id: "webull", method: "snaptrade", environment: "sandbox" }, /sandbox_check/],
    [{ broker_id: "schwab", method: "schwab_oauth", environment: "paper" }, /paper_check/],
    [{ broker_id: "fidelity", method: "snaptrade", environment: "paper" }, /paper_check/],
    [{ broker_id: "alpaca", method: "alpaca_key", environment: "paper", external_ref: "acct-1" }, /one_login_idx/],
    [{ broker_id: "alpaca", method: "alpaca_key", environment: "production", external_ref: "x".repeat(201) }, /external_ref_check/],
  ])) {
    await assert.rejects(insert(row), why);
  }
  // The same login in another environment, or after a disconnect, is allowed.
  await insert({ broker_id: "alpaca", method: "alpaca_key", environment: "production", external_ref: "acct-1" });
  await db.update("broker_connections", { external_ref: "acct-1", environment: "paper" }, { status: "disconnected" });
  await insert({ broker_id: "alpaca", method: "alpaca_key", environment: "paper", external_ref: "acct-1" });
  await assert.rejects(
    db.insert("broker_oauth_pending", { connection_id: "c1", binding_hash: "nope", return_origin: "https://nasscord.com", expires_at: "2026-01-01T00:00:00Z" }),
    /binding_hash_check/,
  );
  await assert.rejects(
    db.insert("broker_oauth_pending", { connection_id: "c1", binding_hash: "a".repeat(64), return_origin: "https://evil.example/path", expires_at: "2026-01-01T00:00:00Z" }),
    /return_origin_check/,
  );
});
