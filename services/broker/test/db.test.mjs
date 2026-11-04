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
