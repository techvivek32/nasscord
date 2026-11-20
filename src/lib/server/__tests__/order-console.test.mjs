import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { beforeEach, mock, test } from "node:test";

/*
 * Order entry in the console and the terminal's two server actions: setWorkspaceOrderEntry
 * (src/lib/server/console-actions.ts), requestOrderEntry and acceptOrderTerms (src/lib/server/order-actions.ts),
 * getWorkspaceOrderEntry, listWorkspaceOrderRequests and listOrderEntryFlags (src/lib/server/console.ts).
 * The session and the service-role client are replaced: the client is a small PostgREST-like query builder
 * over tables in memory, which answers the way Supabase's PostgREST does before the order entry migration ran:
 * Postgres 42703 for a missing column in a select or a filter, PGRST204 for one in a write payload, and
 * PGRST205 for a missing table (42P01 on request, as older PostgREST passed it through). Run with the command
 * in alias-hooks.mjs.
 */

process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";

/** @type {Map<string, Record<string, any>[]>} */
const tables = new Map();
/** "table.column" names that do not exist yet (42703 / PGRST204), and tables that do not exist yet (PGRST205). */
const missingColumns = new Set();
const missingTables = new Set();
/** Tables whose writes fail (a statement timeout, 57014): reads still work. */
const failingWrites = new Set();
/** The code a missing table answers: PGRST205 (current PostgREST) or 42P01 (older versions). */
let missingTableCode = "PGRST205";
const rows = (/** @type {string} */ t) => {
  if (!tables.has(t)) tables.set(t, []);
  return /** @type {Record<string, any>[]} */ (tables.get(t));
};

/** @type {{ uid: string, name: string, email: string, role: string, workspace?: string, workspaceId?: string } | null} */
let session = null;
mock.module("@/lib/auth", {
  exports: {
    getSession: async () => session,
    requireRole: async (/** @type {string[]} */ roles) => {
      if (!session || !roles.includes(session.role)) throw new Error("redirected");
      return session;
    },
    getAuthUser: async () => (session ? { id: session.uid, email: session.email } : null),
    getMemberRow: async () => null,
  },
});
// "next/cache" and "next/headers" have no exports map, so plain Node needs the file names; the mocks replace them anyway.
registerHooks({
  resolve: (specifier, context, next) => next(specifier === "next/cache" || specifier === "next/headers" ? `${specifier}.js` : specifier, context),
});
mock.module("next/cache", { exports: { revalidatePath: () => {}, revalidateTag: () => {} } });
// Outside a request there are no headers: the audit rows get no IP address, as in a background job.
mock.module("next/headers", {
  exports: {
    headers: async () => {
      throw new Error("no request");
    },
    cookies: async () => {
      throw new Error("no request");
    },
  },
});

/** A PostgREST-like query over the tables above (only what these modules use). */
function query(/** @type {string} */ table) {
  /** @type {Array<(r: Record<string, any>) => boolean>} */
  const filters = [];
  /** @type {string[]} */
  const touched = [];
  /** @type {string[]} columns of an insert, update or upsert payload */
  const written = [];
  let op = "select";
  /** @type {any} */
  let payload = null;
  /** @type {{ onConflict?: string }} */
  let upsertOpts = {};
  /** @type {[string, boolean] | null} */
  let order = null;
  let limit = Infinity;
  let single = false;

  const run = () => {
    if (missingTables.has(table)) return { data: null, error: { code: missingTableCode } };
    if (op !== "select" && failingWrites.has(table)) return { data: null, error: { code: "57014" } };
    if (written.some((c) => missingColumns.has(`${table}.${c}`))) return { data: null, error: { code: "PGRST204" } };
    if (touched.some((c) => missingColumns.has(`${table}.${c}`))) return { data: null, error: { code: "42703" } };
    const t = rows(table);
    let out;
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...(table === "audit_events" ? { id: t.length + 1, at: new Date().toISOString() } : {}), ...r }));
      t.push(...list);
      out = list;
    } else if (op === "upsert") {
      const keys = (upsertOpts.onConflict ?? "id").split(",");
      const hit = t.find((r) => keys.every((k) => r[k] === payload[k]));
      if (hit) Object.assign(hit, payload);
      else t.push({ ...payload });
      out = [hit ?? payload];
    } else if (op === "update") {
      const hits = t.filter((r) => filters.every((f) => f(r)));
      for (const r of hits) Object.assign(r, payload);
      out = hits;
    } else {
      out = t.filter((r) => filters.every((f) => f(r)));
      if (order) {
        const [col, asc] = order;
        out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      out = out.slice(0, limit);
    }
    const data = JSON.parse(JSON.stringify(out));
    if (single) return { data: data[0] ?? null, error: null };
    return { data, error: null };
  };

  /** @type {any} */
  const q = {
    select(/** @type {string} */ cols = "*") {
      if (op === "select") op = "select";
      touched.push(...cols.split(",").map((c) => c.trim()).filter((c) => c && c !== "*"));
      return q;
    },
    insert(/** @type {any} */ v) {
      op = "insert";
      payload = v;
      written.push(...Object.keys(Array.isArray(v) ? (v[0] ?? {}) : v));
      return q;
    },
    update(/** @type {any} */ v) {
      op = "update";
      payload = v;
      written.push(...Object.keys(v));
      return q;
    },
    upsert(/** @type {any} */ v, /** @type {any} */ o = {}) {
      op = "upsert";
      payload = v;
      upsertOpts = o;
      written.push(...Object.keys(v));
      return q;
    },
    eq: (/** @type {string} */ k, /** @type {any} */ v) => (touched.push(k), filters.push((r) => r[k] === v), q),
    neq: (/** @type {string} */ k, /** @type {any} */ v) => (touched.push(k), filters.push((r) => r[k] !== v), q),
    in: (/** @type {string} */ k, /** @type {any[]} */ v) => (touched.push(k), filters.push((r) => v.includes(r[k])), q),
    gte: (/** @type {string} */ k, /** @type {any} */ v) => (touched.push(k), filters.push((r) => r[k] != null && r[k] >= v), q),
    gt: (/** @type {string} */ k, /** @type {any} */ v) => (touched.push(k), filters.push((r) => r[k] != null && r[k] > v), q),
    lt: (/** @type {string} */ k, /** @type {any} */ v) => (touched.push(k), filters.push((r) => r[k] != null && r[k] < v), q),
    is: (/** @type {string} */ k, /** @type {any} */ v) => (touched.push(k), filters.push((r) => (r[k] ?? null) === v), q),
    order: (/** @type {string} */ col, /** @type {{ ascending?: boolean }} */ o = {}) => ((order = [col, o.ascending !== false]), q),
    limit: (/** @type {number} */ n) => ((limit = n), q),
    maybeSingle: async () => ((single = true), run()),
    single: async () => ((single = true), run()),
    then: (/** @type {any} */ resolve, /** @type {any} */ reject) => Promise.resolve(run()).then(resolve, reject),
  };
  return q;
}
mock.module("@/lib/supabase/admin", { exports: { isAdminConfigured: () => true, createAdminClient: () => ({ from: query }) } });

const consoleActions = await import("@/lib/server/console-actions");
const orderActions = await import("@/lib/server/order-actions");
const consoleReads = await import("@/lib/server/console");

/* ---------------------------------------------------------------- people */

const wid = randomUUID();
const ownerId = randomUUID();
const adminId = randomUUID();

const asTrader = () => (session = { uid: ownerId, name: "Tess", email: "tess@example.com", role: "trader", workspace: "tess-desk", workspaceId: wid });
const asTenant = () => (session = { uid: randomUUID(), name: "Acme", email: "acme@example.com", role: "tenant" });
const asAdmin = () => (session = { uid: adminId, name: "Owner", email: "owner@nasscord.com", role: "superadmin", workspace: "owner-desk", workspaceId: randomUUID() });

const audits = (/** @type {string} */ action) => rows("audit_events").filter((e) => e.action === action);

beforeEach(() => {
  tables.clear();
  missingColumns.clear();
  failingWrites.clear();
  missingTables.clear();
  missingTableCode = "PGRST205";
  rows("workspaces").push({ id: wid, slug: "tess-desk", name: "Tess Desk", status: "active", owner_id: ownerId, orders_enabled: false, orders_updated_at: null, orders_updated_by: null });
  rows("members").push(
    { user_id: ownerId, email: "tess@example.com", role: "trader", workspace_id: wid },
    { user_id: adminId, email: "owner@nasscord.com", role: "superadmin", workspace_id: null },
  );
  session = null;
});

/* ---------------------------------------------------------------- the console switch */

test("setWorkspaceOrderEntry: a trader and a tenant are denied and audited as denied", async () => {
  asTrader();
  const r = await consoleActions.setWorkspaceOrderEntry(wid, true);
  assert.deepEqual(r, { ok: false, error: "Only the super admin can do this." });
  asTenant();
  const t = await consoleActions.setWorkspaceOrderEntry(wid, true);
  assert.equal(t.ok, false);
  const denied = audits("workspace.order_entry.enable");
  assert.equal(denied.length, 2);
  assert.ok(denied.every((e) => e.result === "denied"));
  assert.equal(rows("workspaces")[0].orders_enabled, false, "nothing changed");
});

test("setWorkspaceOrderEntry: the super admin switches it on and off, each change audited with a readable target", async () => {
  asAdmin();
  const on = await consoleActions.setWorkspaceOrderEntry(wid, true);
  assert.deepEqual(on, { ok: true });
  const ws = rows("workspaces")[0];
  assert.equal(ws.orders_enabled, true);
  assert.equal(ws.orders_updated_by, adminId);
  assert.equal(typeof ws.orders_updated_at, "string");
  const [enable] = audits("workspace.order_entry.enable");
  assert.equal(enable.result ?? "ok", "ok");
  assert.equal(enable.target, "tess-desk · on");
  assert.equal(enable.workspace_id, wid);
  assert.equal(enable.actor_email, "owner@nasscord.com");

  const off = await consoleActions.setWorkspaceOrderEntry(wid, false);
  assert.deepEqual(off, { ok: true });
  assert.equal(rows("workspaces")[0].orders_enabled, false);
  assert.equal(audits("workspace.order_entry.disable")[0].target, "tess-desk · off");

  assert.deepEqual(await consoleActions.setWorkspaceOrderEntry("nope", true), { ok: false, error: "Pick a workspace." });
  assert.deepEqual(await consoleActions.setWorkspaceOrderEntry(randomUUID(), true), { ok: false, error: "That workspace no longer exists." });
});

test("setWorkspaceOrderEntry: before the migration it names the file to run", async () => {
  asAdmin();
  missingColumns.add("workspaces.orders_enabled");
  const r = await consoleActions.setWorkspaceOrderEntry(wid, true);
  assert.deepEqual(r, { ok: false, error: "Run supabase/migrations/20261121120000_order_entry.sql first. Order entry needs it." });
});

/* ---------------------------------------------------------------- the terminal's actions */

test("requestOrderEntry: one audit row per day, then already: true", async () => {
  asTrader();
  const first = await orderActions.requestOrderEntry();
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.already, false);
  assert.equal(first.ok && first.data.already, false);
  const second = await orderActions.requestOrderEntry();
  assert.equal(second.ok && second.already, true);
  const rowsOf = audits("workspace.order_entry.request");
  assert.equal(rowsOf.length, 1);
  assert.equal(rowsOf[0].target, "tess-desk · requested");
  assert.equal(rowsOf[0].workspace_id, wid);

  // A day later the request counts again.
  rowsOf[0].at = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const third = await orderActions.requestOrderEntry();
  assert.equal(third.ok && third.already, false);
  assert.equal(audits("workspace.order_entry.request").length, 2);
});

test("requestOrderEntry: a request whose audit row is not written is not reported as sent", async () => {
  asTrader();
  failingWrites.add("audit_events");
  assert.deepEqual(await orderActions.requestOrderEntry(), { ok: false, error: "We could not send the request. Try again." });
  assert.equal(audits("workspace.order_entry.request").length, 0);
  // Once the database writes again, the request goes through (no "already" from the failed try).
  failingWrites.clear();
  const again = await orderActions.requestOrderEntry();
  assert.equal(again.ok && again.already, false);
  assert.equal(audits("workspace.order_entry.request").length, 1);
});

test("requestOrderEntry: the super admin's sentence, already on, and a login without a trading workspace", async () => {
  asAdmin();
  assert.deepEqual(await orderActions.requestOrderEntry(), {
    ok: false,
    error: "Switch order entry on for your own desk in the console: Traders, your desk, Order entry.",
  });
  asTenant();
  assert.deepEqual(await orderActions.requestOrderEntry(), { ok: false, error: "Order entry belongs to a trading workspace." });
  rows("workspaces")[0].orders_enabled = true;
  asTrader();
  assert.deepEqual(await orderActions.requestOrderEntry(), { ok: false, error: "Order entry is already on for this workspace." });
  assert.equal(audits("workspace.order_entry.request").length, 0);
});

test("acceptOrderTerms: keeps the first time and audits once", async () => {
  asTrader();
  const r = await orderActions.acceptOrderTerms();
  assert.deepEqual(r, { ok: true });
  const first = rows("user_settings").find((s) => s.user_id === ownerId)?.order_terms_accepted_at;
  assert.equal(typeof first, "string");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await orderActions.acceptOrderTerms(), { ok: true });
  assert.equal(rows("user_settings").find((s) => s.user_id === ownerId)?.order_terms_accepted_at, first, "the first time is kept");
  const accepted = audits("user.order_terms.accept");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].target, "order entry notice");

  missingColumns.add("user_settings.order_terms_accepted_at");
  assert.deepEqual(await orderActions.acceptOrderTerms(), { ok: false, error: "Order entry is not set up on this server yet." });
});

/* ---------------------------------------------------------------- console reads */

test("getWorkspaceOrderEntry: the switch, who changed it, and the latest request", async () => {
  asTrader();
  await orderActions.requestOrderEntry();
  asAdmin();
  let s = await consoleReads.getWorkspaceOrderEntry(wid);
  assert.equal(s.enabled, false);
  assert.equal(s.migrated, true);
  assert.equal(typeof s.requestedAt, "string");
  assert.equal(s.requestedByEmail, "tess@example.com");

  await consoleActions.setWorkspaceOrderEntry(wid, true);
  s = await consoleReads.getWorkspaceOrderEntry(wid);
  assert.equal(s.enabled, true);
  assert.equal(typeof s.updatedAt, "string");
  assert.equal(s.updatedByEmail, "owner@nasscord.com");

  const flags = await consoleReads.listOrderEntryFlags();
  assert.equal(flags[wid], "on");

  missingColumns.add("workspaces.orders_enabled");
  assert.deepEqual(await consoleReads.getWorkspaceOrderEntry(wid), { enabled: false, migrated: false });
  assert.deepEqual(await consoleReads.listOrderEntryFlags(), {});
});

test("listOrderEntryFlags: requested while off", async () => {
  asTrader();
  await orderActions.requestOrderEntry();
  asAdmin();
  assert.deepEqual(await consoleReads.listOrderEntryFlags(), { [wid]: "requested" });
});

test("listWorkspaceOrderRequests: expired and stale sending computed like the service; empty before the migration", async () => {
  asAdmin();
  const now = Date.now();
  const iso = (/** @type {number} */ ms) => new Date(now + ms).toISOString();
  /** @param {Record<string, unknown>} over */
  const row = (over) => ({
    id: randomUUID(),
    workspace_id: wid,
    user_id: ownerId,
    broker_id: "alpaca",
    environment: "paper",
    account_display: "PA1•••89",
    symbol: "AAPL",
    side: "BUY",
    quantity: 10,
    order_type: "LMT",
    bracket: false,
    status: "preview",
    broker_order_id: null,
    expires_at: iso(60_000),
    sent_at: null,
    resolved_at: null,
    created_at: iso(-1_000),
    ...over,
  });
  rows("order_requests").push(
    row({ symbol: "OLD", status: "preview", expires_at: iso(-1_000), created_at: iso(-200_000) }),
    row({ symbol: "ASK", status: "needs_confirmation", expires_at: iso(-1), created_at: iso(-150_000) }),
    row({ symbol: "LIVE", status: "preview", created_at: iso(-100_000) }),
    row({ symbol: "STUCK", status: "sending", sent_at: iso(-180_000), created_at: iso(-190_000) }),
    row({ symbol: "SEND", status: "sending", sent_at: iso(-10_000), created_at: iso(-20_000) }),
    row({ symbol: "DONE", status: "placed", broker_order_id: "B-1", sent_at: iso(-5_000), created_at: iso(-6_000) }),
    row({ symbol: "OTHER", workspace_id: randomUUID() }),
  );
  const list = await consoleReads.listWorkspaceOrderRequests(wid);
  const by = Object.fromEntries(list.map((r) => [r.symbol, r]));
  assert.equal(list.length, 6, "only this workspace");
  assert.equal(by.OLD.status, "expired");
  assert.equal(by.ASK.status, "expired");
  assert.equal(by.LIVE.status, "preview");
  assert.equal(by.STUCK.status, "unknown");
  assert.equal(by.SEND.status, "sending");
  assert.equal(by.DONE.status, "placed");
  assert.equal(by.DONE.brokerOrderId, "B-1");
  assert.equal(by.DONE.userEmail, "tess@example.com");
  assert.equal(list[0].symbol, "DONE", "newest first");

  missingTables.add("order_requests");
  assert.deepEqual(await consoleReads.listWorkspaceOrderRequests(wid), [], "PGRST205: the table is not there yet");
  missingTableCode = "42P01";
  assert.deepEqual(await consoleReads.listWorkspaceOrderRequests(wid), [], "42P01 from an older PostgREST");
});

test("console reads refuse anyone but the console roles", async () => {
  asTrader();
  await assert.rejects(() => consoleReads.getWorkspaceOrderEntry(wid), /redirected/);
  await assert.rejects(() => consoleReads.listWorkspaceOrderRequests(wid), /redirected/);
});
