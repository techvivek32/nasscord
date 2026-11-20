import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, mock, test } from "node:test";
import { TEST_SECRET } from "../../../../services/broker/test/helpers/common.mjs";
import { createHarness, fakeTradingAdapter, fakeTradingState, seedTradingAccount } from "../../../../services/broker/test/helpers/harness.mjs";

/*
 * The app's order entry routes (/api/broker/orders/*) against the REAL broker service: services/broker with
 * its memory database and the fake trading adapter of its own test harness (alpaca_key, no network). Only the
 * Supabase session and the service-role client are replaced, the latter by a small query builder over the
 * service's memory database, so the app's switch check and the service's gate read the same rows.
 *
 * A wrapper around fetch records every call the app makes to the service and lets a test replace one answer
 * (a dropped socket after the service placed the order, a 500 without a code, an unreadable body).
 */

process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
process.env.BROKER_SERVICE_SECRET = TEST_SECRET;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
const state = fakeTradingState();

/** The Nasscord session the next route call sees. */
/** @type {{ user: { id: string } | null, member: Record<string, unknown> | null }} */
const session = { user: null, member: null };
mock.module("@/lib/auth", {
  exports: {
    getAuthUser: async () => session.user,
    getMemberRow: async () => session.member,
  },
});

/**
 * A failing read per table: { code } answers a PostgREST error, "throw" makes the call throw (a network failure).
 * @type {Record<string, { code: string } | "throw">}
 */
const adminFault = {};

/** The service-role client: reads over the harness's memory database (what orderEntryState needs). */
function fakeAdmin() {
  return {
    from(/** @type {string} */ table) {
      /** @type {Array<[string, unknown]>} */
      const filters = [];
      const q = {
        select: () => q,
        eq: (/** @type {string} */ k, /** @type {unknown} */ v) => (filters.push([k, v]), q),
        async maybeSingle() {
          const fault = adminFault[table];
          if (fault === "throw") throw new TypeError("fetch failed");
          if (fault) return { data: null, error: { code: fault.code } };
          const rows = (h.db.tables.get(table) ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
          return { data: rows[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
}
mock.module("@/lib/supabase/admin", { exports: { isAdminConfigured: () => true, createAdminClient: fakeAdmin } });

/* ---------------------------------------------------------------- the app's calls to the service */

const realFetch = globalThis.fetch;
/** "METHOD /path" of every call the app made to the broker service. */
const serviceCalls = /** @type {string[]} */ ([]);
/**
 * Replaces the service's answer to one call when it returns a Response (or throws). `forward` sends the call to
 * the real service first, so a test can lose an answer the service did produce.
 * @type {null | ((path: string, forward: () => Promise<Response>) => Promise<Response | undefined> | Response | undefined)}
 */
let intercept = null;

const appLog = /** @type {string[]} */ ([]);
const realError = console.error;

/** @type {Record<string, any>} */
const routes = {};

before(async () => {
  console.error = (...a) => appLog.push(a.map(String).join(" "));
  h = await createHarness({ adapters: [["alpaca", fakeTradingAdapter({ state })]] });
  process.env.BROKER_SERVICE_URL = h.api.url;
  globalThis.fetch = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (h && url.startsWith(h.api.url)) {
        serviceCalls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if (intercept) {
          const replaced = await intercept(new URL(url).pathname, () => realFetch(input, init));
          if (replaced) return replaced;
        }
      }
      return realFetch(input, init);
    }
  );
  routes.caps = await import("@/app/api/broker/orders/capabilities/route");
  routes.preview = await import("@/app/api/broker/orders/preview/route");
  routes.place = await import("@/app/api/broker/orders/place/route");
  routes.cancel = await import("@/app/api/broker/orders/cancel/route");
  routes.requests = await import("@/app/api/broker/orders/requests/route");
  routes.request = await import("@/app/api/broker/orders/requests/[id]/route");
  routes.check = await import("@/app/api/broker/orders/requests/[id]/check/route");
  routes.resolve = await import("@/app/api/broker/orders/requests/[id]/resolve/route");
});

after(async () => {
  console.error = realError;
  globalThis.fetch = realFetch;
  await h?.close();
});

beforeEach(() => {
  intercept = null;
  serviceCalls.length = 0;
});

/* ---------------------------------------------------------------- people, switch and accounts */

/** A member of the harness workspace, as the app's session sees them. @param {string} id @param {string} email */
const memberOf = (id, email) => ({
  user: { id },
  member: { user_id: id, email, role: "trader", workspace_id: h.wid, tenant_id: null, full_name: null, created_at: "", workspace_slug: null },
});

/**
 * The member the next calls act as: each test gets a new one (account() below), so the app's per-user limits
 * (10 places a minute) never meet across tests. The first is the harness's own trader, the workspace owner.
 * @type {{ id: string, email: string } | null}
 */
let current = null;

function owner() {
  return current ? memberOf(current.id, current.email) : memberOf(h.user, "trader@example.com");
}

/** Another login with a workspace of its own (role as given). */
function stranger(role = "trader") {
  const user = randomUUID();
  const wid = randomUUID();
  h.db.tables.set("members", [...h.rows("members"), { user_id: user, email: `x-${user.slice(0, 6)}@example.com`, role, workspace_id: wid }]);
  h.db.tables.set("workspaces", [...h.rows("workspaces"), { id: wid, name: "Elsewhere", owner_id: user, orders_enabled: true, status: "active" }]);
  return { user: { id: user }, member: { user_id: user, email: `x-${user.slice(0, 6)}@example.com`, role, workspace_id: wid, tenant_id: null, full_name: null, created_at: "", workspace_slug: null } };
}

const workspace = () => /** @type {Record<string, unknown>} */ (h.rows("workspaces").find((w) => w.id === h.wid));

/** @param {{ on?: boolean, status?: string }} o */
function setSwitch(o) {
  if (o.on !== undefined) workspace().orders_enabled = o.on;
  if (o.status !== undefined) workspace().status = o.status;
}

/** @param {boolean} accepted */
function setTerms(accepted) {
  const uid = current?.id ?? h.user;
  const rest = h.rows("user_settings").filter((r) => r.user_id !== uid);
  h.db.tables.set("user_settings", [...rest, { user_id: uid, order_terms_accepted_at: accepted ? new Date().toISOString() : null }]);
}

/**
 * A new member of the harness workspace with a broker login of their own (an active alpaca_key connection and
 * one included account), who accepted the notice. They act from now on. The workspace owner stays the harness
 * trader: the service lets a member trade the logins they connected.
 */
async function account() {
  const id = randomUUID();
  const email = `member-${id.slice(0, 6)}@example.com`;
  h.db.tables.set("members", [...h.rows("members"), { user_id: id, email, role: "trader", workspace_id: h.wid }]);
  current = { id, email };
  const seed = await seedTradingAccount(h, { userId: id, ownerId: h.user });
  setTerms(true);
  return seed.accountId;
}

/* ---------------------------------------------------------------- calls as a browser makes them */

/**
 * @param {"GET" | "POST"} method
 * @param {string} path
 * @param {{ json?: unknown, as?: ReturnType<typeof owner> | null, site?: string | null, contentType?: string, raw?: string }} [o]
 */
async function send(method, path, o = {}) {
  /** @type {Record<string, string>} */
  const headers = { host: "localhost:3000" };
  if (o.site !== null) headers["sec-fetch-site"] = o.site ?? "same-origin";
  let body;
  if (method === "POST") {
    headers["content-type"] = o.contentType ?? "application/json";
    body = o.raw ?? JSON.stringify(o.json ?? {});
  }
  const request = new Request(`http://127.0.0.1:3000${path}`, { method, headers, body });
  const who = o.as === undefined ? owner() : o.as;
  session.user = who?.user ?? null;
  session.member = who?.member ?? null;
  const res = await dispatch(method, path, request);
  const text = await res.text();
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** @param {string} method @param {string} path @param {Request} request @returns {Promise<Response>} */
async function dispatch(method, path, request) {
  let m;
  const ctx = (/** @type {string} */ id) => ({ params: Promise.resolve({ id }) });
  if (path === "/api/broker/orders/capabilities") return routes.caps.GET(request);
  if (path === "/api/broker/orders/preview") return routes.preview.POST(request);
  if (path === "/api/broker/orders/place") return routes.place.POST(request);
  if (path === "/api/broker/orders/cancel") return routes.cancel.POST(request);
  if (path === "/api/broker/orders/requests") return routes.requests.GET(request);
  if ((m = /^\/api\/broker\/orders\/requests\/([^/]+)\/check$/.exec(path))) return routes.check.POST(request, ctx(m[1]));
  if ((m = /^\/api\/broker\/orders\/requests\/([^/]+)\/resolve$/.exec(path))) return routes.resolve.POST(request, ctx(m[1]));
  if ((m = /^\/api\/broker\/orders\/requests\/([^/]+)$/.exec(path))) return routes.request.GET(request, ctx(m[1]));
  throw new Error(`no route for ${method} ${path}`);
}

/** @param {string} accountId @param {Record<string, unknown>} [over] */
const ticket = (accountId, over = {}) => ({ accountId, symbol: "AAPL", side: "BUY", quantity: 10, type: "LMT", limitPrice: 99.5, tif: "DAY", intent: "trade", ...over });

/** A preview that must succeed. @param {string} accountId @param {Record<string, unknown>} [over] */
async function preview(accountId, over = {}) {
  const r = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId, over) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.request.status, "preview");
  return r.json.request;
}

const calledService = (/** @type {string} */ fragment) => serviceCalls.some((c) => c.includes(fragment));

/* ---------------------------------------------------------------- tests */

test("capabilities: off answers without a service call; on answers the service's caps with the notice time", async () => {
  await account();
  setSwitch({ on: false });
  const off = await send("GET", "/api/broker/orders/capabilities");
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.enabled, false);
  assert.equal(off.json.reason, "off");
  assert.equal(off.json.message, "Order entry is not switched on for this workspace. Place orders in your broker's app.");
  assert.deepEqual(off.json.connections, {});
  assert.equal(serviceCalls.length, 0, "no service call while off");
  assert.equal(off.headers.get("cache-control"), "private, no-store");

  setSwitch({ on: true, status: "suspended" });
  const suspended = await send("GET", "/api/broker/orders/capabilities");
  assert.equal(suspended.json.reason, "suspended");
  assert.equal(suspended.json.message, "This workspace is suspended, so it cannot place orders.");

  setSwitch({ status: "active" });
  const on = await send("GET", "/api/broker/orders/capabilities");
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.enabled, true);
  assert.ok(Object.keys(on.json.connections).length >= 1);
  assert.equal(typeof on.json.termsAcceptedAt, "string");
  assert.ok(calledService("/v1/orders/capabilities"));
});

test("capabilities: a service failure answers 503 unavailable, never a 200 that says off", async () => {
  await account();
  setSwitch({ on: true, status: "active" });
  intercept = (path) => (path === "/v1/orders/capabilities" ? new Response("{}", { status: 500 }) : undefined);
  const r = await send("GET", "/api/broker/orders/capabilities");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "unavailable");
  intercept = (path) => {
    if (path === "/v1/orders/capabilities") throw new TypeError("fetch failed");
  };
  const down = await send("GET", "/api/broker/orders/capabilities");
  assert.equal(down.status, 503);
  assert.equal(down.json.code, "unavailable");
});

test("capabilities: a failed database read of the switch answers 503 unavailable, never a 200 that says off", async () => {
  await account();
  setSwitch({ on: true, status: "active" });
  try {
    for (const fault of [{ code: "57014" }, "throw"]) {
      adminFault.workspaces = /** @type {any} */ (fault);
      const r = await send("GET", "/api/broker/orders/capabilities");
      assert.equal(r.status, 503, r.text);
      assert.equal(r.json.code, "unavailable");
      assert.equal(serviceCalls.length, 0, "no service call");
    }
    // The notice unreadable is the same: no 200 that would show the notice again.
    delete adminFault.workspaces;
    adminFault.user_settings = { code: "57014" };
    const notice = await send("GET", "/api/broker/orders/capabilities");
    assert.equal(notice.status, 503, notice.text);
    // A POST still fails closed: the switch unreadable is off.
    delete adminFault.user_settings;
    adminFault.workspaces = { code: "57014" };
    const accountId = await account();
    const pv = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId) });
    assert.equal(pv.status, 403, pv.text);
    assert.equal(pv.json.code, "order_entry_off");
  } finally {
    delete adminFault.workspaces;
    delete adminFault.user_settings;
  }
  const ok = await send("GET", "/api/broker/orders/capabilities");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.enabled, true);
});

test("guards: cross-site, a body that is not JSON, signed out, a tenant login", async () => {
  const accountId = await account();
  const cross = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId), site: "cross-site" });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.code, "cross_site");
  assert.equal(cross.json.error, "For your safety, Nasscord accepts orders only from its own terminal pages.");
  const text = await send("POST", "/api/broker/orders/preview", { raw: JSON.stringify(ticket(accountId)), contentType: "text/plain" });
  assert.equal(text.status, 415);
  assert.equal(text.json.code, "not_json");
  const signedOut = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId), as: null });
  assert.equal(signedOut.status, 401);
  assert.equal(signedOut.json.code, "signed_out");
  const tenant = stranger("tenant");
  const t = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId), as: tenant });
  assert.equal(t.status, 403);
  assert.equal(t.json.code, "forbidden");
  assert.equal(serviceCalls.length, 0);
});

test("preview: 403 while off, suspended or before the notice, with no service call", async () => {
  const accountId = await account();
  setSwitch({ on: false });
  const off = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId) });
  assert.equal(off.status, 403);
  assert.equal(off.json.code, "order_entry_off");
  assert.equal(off.json.error, "Order entry is not switched on for this workspace.");

  setSwitch({ on: true, status: "suspended" });
  const suspended = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId) });
  assert.equal(suspended.status, 403);
  assert.equal(suspended.json.code, "workspace_suspended");

  setSwitch({ status: "active" });
  setTerms(false);
  const terms = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId) });
  assert.equal(terms.status, 403);
  assert.equal(terms.json.code, "terms_not_accepted");
  assert.equal(terms.json.error, "Read the order entry notice and confirm it before your first order.");
  assert.equal(serviceCalls.length, 0);

  setTerms(true);
  const bad = await send("POST", "/api/broker/orders/preview", { json: ticket(accountId, { limitPrice: 99.555 }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "bad_ticket");
  assert.equal(serviceCalls.length, 0);
});

test("preview, place, placed; a second place answers the same request and sends nothing more", async () => {
  const accountId = await account();
  const sentBefore = state.sent.length;
  const req = await preview(accountId, { symbol: "MSFT" });
  const placed = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
  assert.equal(placed.status, 200, placed.text);
  assert.equal(placed.json.request.id, req.id);
  assert.equal(placed.json.request.status, "placed");
  assert.equal(state.sent.length, sentBefore + 1);
  const again = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.request.status, "placed");
  assert.equal(again.json.request.brokerOrderId, placed.json.request.brokerOrderId);
  assert.equal(state.sent.length, sentBefore + 1, "one send");
});

test("place: 403 when the switch is turned off between preview and place, with no service call", async () => {
  const accountId = await account();
  const req = await preview(accountId, { symbol: "NVDA" });
  setSwitch({ on: false });
  serviceCalls.length = 0;
  const r = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "order_entry_off");
  assert.equal(serviceCalls.length, 0);
  const cancel = await send("POST", "/api/broker/orders/cancel", { json: { accountId, orderId: `alpaca:${accountId}:fake-1` } });
  assert.equal(cancel.status, 403);
  assert.equal(cancel.json.code, "order_entry_off");
  assert.equal(serviceCalls.length, 0);
  // Reads still answer while off.
  const one = await send("GET", `/api/broker/orders/requests/${req.id}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.request.id, req.id);
  const list = await send("GET", "/api/broker/orders/requests");
  assert.equal(list.status, 200, list.text);
  assert.ok(Array.isArray(list.json.requests));
  setSwitch({ on: true });
});

test("requests/:id of another workspace answers 404", async () => {
  const accountId = await account();
  const req = await preview(accountId, { symbol: "AMD" });
  const r = await send("GET", `/api/broker/orders/requests/${req.id}`, { as: stranger() });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "not_found");
  const bad = await send("GET", "/api/broker/orders/requests/not-a-uuid");
  assert.equal(bad.status, 404);
  assert.equal(bad.json.code, "not_found");
});

test("place: a lost answer after the service placed the order is 202 checking, and the stored request shows placed", async () => {
  const accountId = await account();
  const sentBefore = state.sent.length;
  const req = await preview(accountId, { symbol: "TSLA" });
  intercept = async (path, forward) => {
    if (path !== "/v1/orders/place") return undefined;
    await (await forward()).text();
    throw new TypeError("fetch failed");
  };
  const r = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
  assert.equal(r.status, 202, r.text);
  assert.deepEqual(r.json, { checking: true, requestId: req.id, error: "Nasscord could not confirm whether your broker received this order. Check Orders before you place it again." });
  intercept = null;
  const stored = await send("GET", `/api/broker/orders/requests/${req.id}`);
  assert.equal(stored.json.request.status, "placed");
  assert.equal(state.sent.length, sentBefore + 1, "the app never retried");
  assert.equal(serviceCalls.filter((c) => c === "POST /v1/orders/place").length, 1);
});

test("place: a 500 without a code, an unreadable body and an answer without the request are 202 checking", async () => {
  const accountId = await account();
  const answers = [
    () => new Response(JSON.stringify({ error: "Something went wrong." }), { status: 500, headers: { "content-type": "application/json" } }),
    () => new Response("<html>bad gateway</html>", { status: 200 }),
    () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ error: "x", code: "error" }), { status: 500, headers: { "content-type": "application/json" } }),
  ];
  for (const [i, answer] of answers.entries()) {
    const req = await preview(accountId, { symbol: `ZZ${i}` });
    intercept = (path) => (path === "/v1/orders/place" ? answer() : undefined);
    const r = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
    assert.equal(r.status, 202, `${i}: ${r.text}`);
    assert.equal(r.json.checking, true);
    assert.equal(r.json.requestId, req.id);
    intercept = null;
  }
});

test("place: a deliberate refusal of the service reaches the browser with its code", async () => {
  const accountId = await account();
  state.notices = [{ key: "fake.notice", text: "Read this first." }];
  const req = await preview(accountId, { symbol: "META" });
  state.notices = [];
  const r = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, "notices_not_acknowledged");
  assert.equal(r.json.error, "Confirm the order from the dialog that shows its notices.");

  intercept = (path) =>
    path === "/v1/orders/place"
      ? new Response(JSON.stringify({ error: "The broker service is restarting. Nothing was placed. Try again in a minute.", code: "shutting_down" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      : undefined;
  const down = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: ["fake.notice"] } });
  assert.equal(down.status, 503, down.text);
  assert.equal(down.json.code, "shutting_down");
  intercept = null;

  const ok = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: ["fake.notice"] } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.request.status, "placed");
});

test("place: a bad body is refused before the service", async () => {
  await account();
  const r = await send("POST", "/api/broker/orders/place", { json: { requestId: "nope" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "bad_request");
  assert.equal(r.json.error, "Send the order request id.");
  assert.equal(serviceCalls.length, 0);
});

test("unknown outcome: listed, Check again and I checked it answer the request", async () => {
  const accountId = await account();
  const req = await preview(accountId, { symbol: "NFLX" });
  state.place.push("throw");
  const placed = await send("POST", "/api/broker/orders/place", { json: { requestId: req.id, acknowledged: [] } });
  assert.equal(placed.status, 200, placed.text);
  assert.equal(placed.json.request.status, "unknown");
  const list = await send("GET", "/api/broker/orders/requests");
  assert.ok(list.json.requests.some((/** @type {any} */ x) => x.id === req.id));
  const check = await send("POST", `/api/broker/orders/requests/${req.id}/check`);
  assert.equal(check.status, 200, check.text);
  assert.equal(check.json.request.id, req.id);
  // Check and resolve do not need the switch.
  setSwitch({ on: false });
  const resolved = await send("POST", `/api/broker/orders/requests/${req.id}/resolve`);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(typeof resolved.json.request.resolvedAt, "string");
  setSwitch({ on: true });
  const after = await send("GET", "/api/broker/orders/requests");
  assert.ok(!after.json.requests.some((/** @type {any} */ x) => x.id === req.id), "a checked order leaves the list");
});

test("requests: the list answers 503 when the service fails", async () => {
  intercept = (path) => (path === "/v1/orders/requests" ? new Response("oops", { status: 500 }) : undefined);
  const r = await send("GET", "/api/broker/orders/requests");
  assert.equal(r.status, 503);
  assert.equal(r.json.code, "unavailable");
  assert.equal(r.json.error, "Nasscord could not load unconfirmed orders right now.");
});

test("cancel: a refusal keeps its code; a lost answer is 504 cancel_unknown", async () => {
  const accountId = await account();
  const wrong = await send("POST", "/api/broker/orders/cancel", { json: { accountId, orderId: `ibkr:${accountId}:1` } });
  assert.equal(wrong.status, 404, wrong.text);
  assert.equal(wrong.json.code, "order_not_open");
  const ok = await send("POST", "/api/broker/orders/cancel", { json: { accountId, orderId: `alpaca:${accountId}:fake-9` } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, "cancel_requested");
  intercept = (path) => {
    if (path === "/v1/orders/cancel") throw new TypeError("fetch failed");
  };
  const lost = await send("POST", "/api/broker/orders/cancel", { json: { accountId, orderId: `alpaca:${accountId}:fake-9` } });
  assert.equal(lost.status, 504);
  assert.equal(lost.json.code, "cancel_unknown");
  assert.equal(lost.json.error, "Nasscord could not confirm the cancel. Check Orders: the order may still be working.");
});

test("no secret in the app's log lines or answers", async () => {
  const joined = appLog.join("\n");
  assert.ok(!joined.includes(TEST_SECRET));
  assert.ok(!/Bearer /i.test(joined));
});
