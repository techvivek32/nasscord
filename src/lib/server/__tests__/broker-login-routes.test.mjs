import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, mock, test } from "node:test";
import { TEST_SECRET } from "../../../../services/broker/test/helpers/common.mjs";
import { startFakeOAuth2, simulateBrowserApproval } from "../../../../services/broker/test/helpers/fake-oauth2.mjs";
import { createHarness, fakeAggregatorAdapter, fakeKeyAdapter, fakeOAuthAdapter } from "../../../../services/broker/test/helpers/harness.mjs";

/*
 * The app's broker-login routes (WP1) against the REAL broker service: services/broker with its
 * memory database, a fake OAuth broker, a fake key adapter and a fake SnapTrade adapter (the
 * service's own test harness). Only the Supabase session, the service-role client and the tenant
 * lookup are replaced. Each "browser" keeps its own cookies per host and its own Nasscord session,
 * and every route handler is called the way Next calls it.
 *
 * Covers critique F1 (the canonical-host hop, the takeover of D1, callback with an unknown or expired
 * state, finish signed out, with the wrong cookie and from another workspace, renew answering every
 * next.kind) and F3 (no secret, code, state, ticket or nonce in a log line or a response that should
 * not carry it).
 */

process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
process.env.BROKER_SERVICE_SECRET = TEST_SECRET;

const CANONICAL = "http://localhost:3000";
const TENANT_HOST = "trade.acme.test";
const TENANT = `http://${TENANT_HOST}`;

/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {Awaited<ReturnType<typeof startFakeOAuth2>>} */
let schwab;
/** @type {Map<string, { account: string, environment: "production" | "paper" }>} */
const keys = new Map([["alpaca-secret-1234567", { account: "ALP-ACC-1", environment: "paper" }]]);

/** The Nasscord session the next route call sees (each browser sets its own before a call). */
/** @type {{ user: { id: string } | null, member: Record<string, unknown> | null }} */
const session = { user: null, member: null };
mock.module("@/lib/auth", {
  exports: {
    getAuthUser: async () => session.user,
    getMemberRow: async () => session.member,
  },
});

/** The service-role client: a read-only query builder over the harness's memory database. */
function fakeAdmin() {
  return {
    from(/** @type {string} */ table) {
      /** @type {Array<[string, unknown, string]>} */
      const filters = [];
      const q = {
        select: () => q,
        eq: (/** @type {string} */ k, /** @type {unknown} */ v) => (filters.push([k, v, "eq"]), q),
        neq: (/** @type {string} */ k, /** @type {unknown} */ v) => (filters.push([k, v, "neq"]), q),
        limit: () => q,
        async maybeSingle() {
          const rows = (h.db.tables.get(table) ?? []).filter((r) => filters.every(([k, v, op]) => (op === "eq" ? r[k] === v : r[k] !== v)));
          return { data: rows[0] ?? null, error: null };
        },
      };
      return q;
    },
  };
}
mock.module("@/lib/supabase/admin", { exports: { isAdminConfigured: () => true, createAdminClient: fakeAdmin } });

/** @type {Map<string, { status: string, whiteLabel: boolean, branding: { domain: string } }>} */
const tenants = new Map([
  [TENANT_HOST, { status: "active", whiteLabel: true, branding: { domain: TENANT_HOST } }],
  ["paused.acme.test", { status: "suspended", whiteLabel: true, branding: { domain: "paused.acme.test" } }],
]);
mock.module("@/lib/tenant-server", { exports: { getTenantByDomain: async (/** @type {string} */ d) => tenants.get(d) ?? null } });

/** Everything the app logs while the tests run, and every answer the routes gave (body and Location). */
const appLog = /** @type {string[]} */ ([]);
const answers = /** @type {string[]} */ ([]);
const realError = console.error;
const realWarn = console.warn;
const realLog = console.log;

/** @type {Record<string, any>} */
const routes = {};

before(async () => {
  console.error = (...a) => appLog.push(a.map(String).join(" "));
  console.warn = (...a) => appLog.push(a.map(String).join(" "));
  console.log = (...a) => appLog.push(a.map(String).join(" "));
  schwab = await startFakeOAuth2({ clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456", sub: "schwab-user-1" });
  h = await createHarness({
    env: { BROKER_AUDIENCE: "schwab_oauth=all", SNAPTRADE_CLIENT_ID: "snap-id", SNAPTRADE_CONSUMER_KEY: "snap-key" },
    adapters: [
      ["alpaca", fakeKeyAdapter({ keys })],
      ["schwab", fakeOAuthAdapter({ server: schwab })],
      ["snaptrade", fakeAggregatorAdapter()],
    ],
  });
  process.env.BROKER_SERVICE_URL = h.api.url;
  routes.options = await import("@/app/api/broker/options/route");
  routes.key = await import("@/app/api/broker/key/connect/route");
  routes.oauthStart = await import("@/app/api/broker/oauth/start/route");
  routes.aggStart = await import("@/app/api/broker/aggregator/start/route");
  routes.go = await import("@/app/api/broker/oauth/go/route");
  routes.callback = await import("@/app/api/broker/callback/[broker]/route");
  routes.finish = await import("@/app/api/broker/oauth/finish/route");
  routes.renew = await import("@/app/api/broker/connections/[id]/renew/route");
});

after(async () => {
  console.error = realError;
  console.warn = realWarn;
  console.log = realLog;
  await h?.close();
  await schwab?.close();
});

/* ---------------------------------------------------------------- people and browsers */

/**
 * A new trader, in a workspace of their own unless `wid` names one, so per-user limits never meet and
 * one test's logins never meet another's (a new start removes the workspace's unfinished attempts).
 */
function newMember(o = /** @type {{ wid?: string, workspaceName?: string }} */ ({})) {
  const user = randomUUID();
  const wid = o.wid ?? randomUUID();
  const email = `trader-${user.slice(0, 6)}@example.com`;
  h.db.tables.set("members", [...(h.db.tables.get("members") ?? []), { user_id: user, email, role: "trader", workspace_id: wid }]);
  if (!(h.db.tables.get("workspaces") ?? []).some((w) => w.id === wid)) {
    h.db.tables.set("workspaces", [...(h.db.tables.get("workspaces") ?? []), { id: wid, name: o.workspaceName ?? "Desk One" }]);
  }
  return { user: { id: user }, member: { user_id: user, email, role: "trader", workspace_id: wid, tenant_id: null, full_name: null, created_at: "", workspace_slug: null } };
}

/**
 * One browser: cookies per host (path-aware), its own Nasscord session, and calls into the route
 * handlers with the headers a browser and Caddy would send.
 * @param {{ session?: ReturnType<typeof newMember> | null, ip?: string }} [o]
 */
function browser(o = {}) {
  /** @type {Map<string, Map<string, { value: string, path: string }>>} */
  const jar = new Map();
  const ip = o.ip ?? `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

  /** @param {string} host @param {string} path */
  function cookieHeader(host, path) {
    const c = jar.get(host);
    if (!c) return "";
    return [...c.entries()]
      .filter(([, v]) => path.startsWith(v.path))
      .map(([k, v]) => `${k}=${v.value}`)
      .join("; ");
  }

  /** @param {string} host @param {string[]} setCookies */
  function store(host, setCookies) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      const maxAge = attrs.find((a) => a.toLowerCase().startsWith("max-age="));
      const c = jar.get(host) ?? new Map();
      if (maxAge && Number(maxAge.slice(8)) <= 0) c.delete(name);
      else c.set(name, { value, path });
      jar.set(host, c);
    }
  }

  /**
   * @param {"GET" | "POST"} method
   * @param {string} url absolute
   * @param {{ json?: unknown, form?: Record<string, string>, site?: string, origin?: string | null }} [r]
   */
  async function send(method, url, r = {}) {
    const u = new URL(url);
    /** @type {Record<string, string>} */
    const headers = { host: u.host, "x-forwarded-host": u.host, "x-forwarded-proto": u.protocol.replace(":", ""), "x-forwarded-for": ip };
    const cookie = cookieHeader(u.host, u.pathname);
    if (cookie) headers.cookie = cookie;
    if (r.site) headers["sec-fetch-site"] = r.site;
    if (r.origin) headers.origin = r.origin;
    /** @type {string | undefined} */
    let body;
    if (r.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(r.json);
    } else if (r.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(r.form).toString();
    }
    // Next's server sees the app's own listener address, not the public host.
    const request = new Request(`http://127.0.0.1:3000${u.pathname}${u.search}`, { method, headers, body });
    session.user = o.session?.user ?? null;
    session.member = o.session?.member ?? null;
    const res = await dispatch(method, u.pathname, request);
    store(u.host, res.headers.getSetCookie());
    const text = await res.text();
    answers.push(`${res.headers.get("location") ?? ""} ${text}`);
    /** @type {any} */
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json, location: res.headers.get("location") };
  }

  return {
    jar,
    send,
    /** @param {string} host @param {string} name */
    cookie: (host, name) => jar.get(host)?.get(name)?.value ?? null,
    /** A fetch from a Nasscord page on `origin` (same-origin, JSON). @param {string} origin @param {string} path @param {unknown} [json] */
    api: (origin, path, json) => send("POST", `${origin}${path}`, { json: json ?? {}, site: "same-origin", origin }),
  };
}

/** @param {string} method @param {string} pathname @param {Request} request @returns {Promise<Response>} */
async function dispatch(method, pathname, request) {
  let m;
  if (pathname === "/api/broker/options") return routes.options.GET(request);
  if (pathname === "/api/broker/key/connect") return routes.key.POST(request);
  if (pathname === "/api/broker/oauth/start") return routes.oauthStart.POST(request);
  if (pathname === "/api/broker/aggregator/start") return routes.aggStart.POST(request);
  if (pathname === "/api/broker/oauth/go") return method === "GET" ? routes.go.GET(request) : routes.go.POST(request);
  if (pathname === "/api/broker/oauth/finish") return routes.finish.GET(request);
  if ((m = /^\/api\/broker\/callback\/([^/]+)$/.exec(pathname))) return routes.callback.GET(request, { params: Promise.resolve({ broker: m[1] }) });
  if ((m = /^\/api\/broker\/connections\/([^/]+)\/renew$/.exec(pathname))) return routes.renew.POST(request, { params: Promise.resolve({ id: m[1] }) });
  throw new Error(`no route for ${method} ${pathname}`);
}

const schwabApp = { brokerId: "schwab", client: "user", clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456" };

/** @param {string} id */
const row = (id) => h.rows("broker_connections").find((r) => r.id === id);

/**
 * The whole Schwab user-app login as the browser runs it, from the user's own host.
 * @param {ReturnType<typeof browser>} b
 * @param {string} origin where the user started
 */
async function startSchwab(b, origin) {
  // Each login is another Schwab user unless a test says otherwise (the same user merges).
  schwab.state.sub = `schwab-${randomUUID()}`;
  const start = await b.api(origin, "/api/broker/oauth/start", schwabApp);
  assert.equal(start.status, 200, start.text);
  return start.json;
}

/* ---------------------------------------------------------------- tests */

test("options: the service's answer for this user, with the callback base", async () => {
  const b = browser({ session: newMember() });
  const r = await b.send("GET", `${TENANT}/api/broker/options`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.callbackBase, CANONICAL);
  const schwabUser = r.json.options.find((/** @type {any} */ o) => o.brokerId === "schwab" && o.client === "user");
  assert.equal(schwabUser.available, true);
  assert.equal(schwabUser.callbackUrl, `${CANONICAL}/api/broker/callback/schwab`);
  const signedOut = await browser().send("GET", `${TENANT}/api/broker/options`);
  assert.equal(signedOut.status, 401);
});

test("OAuth from a tenant domain: start, confirm on the canonical host, callback, finish", async () => {
  const b = browser({ session: newMember() });
  const { connectionId: id, openUrl } = await startSchwab(b, TENANT);
  assert.ok(openUrl.startsWith(`${CANONICAL}/api/broker/oauth/go?cid=${id}&n=`), "the hop is on the canonical host");
  const nonce = new URL(openUrl).searchParams.get("n");
  assert.equal(b.cookie(TENANT_HOST, `ns_oauth_${id}`), nonce, "binding cookie on the user's host");
  assert.equal(b.cookie("localhost:3000", `ns_oauth_${id}`), null, "not yet on the canonical host");
  assert.equal(row(id)?.status, "pending");

  // The new tab: a confirmation page naming the workspace and who asked.
  const page = await b.send("GET", openUrl);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /Desk One/);
  assert.match(page.text, /tr•••@example\.com/);
  assert.match(page.text, /Next you log in to [^.]+ on its own page\./);
  assert.match(page.text, /<form method="post" action="\/api\/broker\/oauth\/go">/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");

  // Continue: same-origin POST sets the canonical cookie and goes to the broker.
  const go = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: String(nonce) }, site: "same-origin", origin: CANONICAL });
  assert.equal(go.status, 303, go.text);
  assert.ok(go.location?.startsWith(schwab.urls.authorize), "to the broker's authorize page");
  assert.equal(go.headers.get("referrer-policy"), "no-referrer");
  assert.equal(b.cookie("localhost:3000", `ns_oauth_${id}`), nonce, "the canonical host holds the binding now");

  // The broker sends the browser back to the one registered URL.
  const approval = await simulateBrowserApproval(String(go.location));
  assert.equal(approval.callbackUrl, `${CANONICAL}/api/broker/callback/schwab`);
  // A link checker's HEAD uses nothing up (Next would run GET for a route without HEAD).
  assert.equal(routes.callback.HEAD().status, 200);
  assert.equal(h.rows("broker_oauth_pending").find((p) => p.connection_id === id)?.stage, "authorize");
  const cb = await b.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
  assert.equal(cb.status, 303, cb.text);
  assert.equal(routes.finish.HEAD().status, 200);
  assert.equal(routes.go.HEAD().status, 200);
  const fin = new URL(String(cb.location));
  assert.equal(fin.origin, TENANT, "back to the user's own host");
  assert.equal(fin.pathname, "/api/broker/oauth/finish");
  assert.deepEqual([...fin.searchParams.keys()].sort(), ["cid", "ticket"], "only the connection id and the one-time ticket travel");
  assert.ok(!String(cb.location).includes(String(approval.code)) && !String(cb.location).includes(String(approval.state)));
  assert.equal(b.cookie("localhost:3000", `ns_oauth_${id}`), null, "the canonical cookie is cleared");

  const userCookie = b.cookie(TENANT_HOST, `ns_oauth_${id}`);
  assert.ok(userCookie);
  const done = await b.send("GET", String(cb.location));
  assert.equal(done.status, 303, done.text);
  assert.equal(done.location, `/app/brokers?connected=${id}`);
  assert.equal(b.cookie(TENANT_HOST, `ns_oauth_${id}`), null, "the user-host cookie is cleared");
  assert.equal(row(id)?.status, "active");
  assert.ok(h.rows("broker_accounts").some((a) => a.connection_id === id), "accounts listed");

  // The ticket works once. The cookie goes back into the jar, so the replay passes the route's own
  // checks and reaches the broker service's ticket check (POST /v1/connect/claim).
  b.jar.get(TENANT_HOST)?.set(`ns_oauth_${id}`, { value: String(userCookie), path: "/api/broker" });
  const again = await b.send("GET", String(cb.location));
  assert.equal(again.status, 410, again.text);
  assert.match(again.text, /expired or was already used/);
  assert.equal(again.location, null);
  assert.equal(row(id)?.status, "active", "a replay leaves the connection as it is");
});

test("OAuth started on the canonical host: the hop goes straight on (this browser holds the binding)", async () => {
  const b = browser({ session: newMember() });
  const { connectionId: id, openUrl } = await startSchwab(b, CANONICAL);
  const go = await b.send("GET", openUrl);
  assert.equal(go.status, 303, go.text);
  assert.ok(go.location?.startsWith(schwab.urls.authorize));
  const approval = await simulateBrowserApproval(String(go.location));
  const cb = await b.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
  assert.equal(cb.status, 303, cb.text);
  assert.ok(String(cb.location).startsWith(`${CANONICAL}/api/broker/oauth/finish?`));
  assert.ok(b.cookie("localhost:3000", `ns_oauth_${id}`), "kept: it is also the user-host cookie finish needs");
  const done = await b.send("GET", String(cb.location));
  assert.equal(done.location, `/app/brokers?connected=${id}`);
  assert.equal(b.cookie("localhost:3000", `ns_oauth_${id}`), null);
  assert.equal(row(id)?.status, "active");
});

test("the same broker login twice in one workspace: finish lands on the existing connection", async () => {
  const me = newMember();
  const b = browser({ session: me });
  /** @returns {Promise<{ id: string, landed: string | null }>} */
  const login = async () => {
    const start = await b.api(TENANT, "/api/broker/oauth/start", schwabApp);
    const id = start.json.connectionId;
    const go = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: String(new URL(start.json.openUrl).searchParams.get("n")) }, site: "same-origin", origin: CANONICAL });
    const approval = await simulateBrowserApproval(String(go.location));
    const cb = await b.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
    const done = await b.send("GET", String(cb.location));
    return { id, landed: done.location };
  };
  schwab.state.sub = `schwab-${randomUUID()}`;
  const first = await login();
  assert.equal(first.landed, `/app/brokers?connected=${first.id}`);
  const second = await login();
  assert.equal(second.landed, `/app/brokers?connected=${first.id}`, "the id the claim answered, not the one the start did");
  assert.equal(row(second.id), undefined, "the new row was merged away");
  assert.equal(row(first.id)?.status, "active");
});

test("takeover (D1): a victim approving an attacker's login has no canonical cookie and is refused", async () => {
  const attacker = browser({ session: newMember() });
  const { connectionId: id, openUrl } = await startSchwab(attacker, TENANT);
  const nonce = String(new URL(openUrl).searchParams.get("n"));
  // The attacker does the hop himself and forwards the broker's page to the victim.
  const go = await attacker.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: nonce }, site: "same-origin", origin: CANONICAL });
  assert.equal(go.status, 303);
  const approval = await simulateBrowserApproval(String(go.location));
  const victim = browser();
  const cb = await victim.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
  assert.equal(cb.status, 403, cb.text);
  assert.equal(cb.location, null, "no ticket, no redirect to the attacker's host");
  assert.match(cb.text, /another browser/);
  assert.equal(row(id), undefined, "the login is removed");
  // The attacker cannot replay the state with his own cookie afterwards.
  const replay = await attacker.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
  assert.notEqual(replay.status, 303);
});

test("takeover (D1): a forwarded hop link shows whose workspace it is, and a cross-site auto-submit is refused", async () => {
  const otherWid = randomUUID();
  const attacker = browser({ session: newMember({ wid: otherWid, workspaceName: 'Free <b>"money"</b>' }) });
  const { connectionId: id, openUrl } = await startSchwab(attacker, TENANT);
  const nonce = String(new URL(openUrl).searchParams.get("n"));
  const victim = browser();
  const page = await victim.send("GET", openUrl, { site: "cross-site" });
  assert.equal(page.status, 200);
  assert.match(page.text, /Free &lt;b&gt;&quot;money&quot;&lt;\/b&gt;/, "the attacker's workspace, escaped");
  assert.match(page.text, /If someone sent you this link, close this tab/);
  const forged = await victim.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: nonce }, site: "cross-site", origin: "https://evil.example" });
  assert.equal(forged.status, 403);
  assert.equal(forged.location, null);
  assert.equal(victim.cookie("localhost:3000", `ns_oauth_${id}`), null, "no binding for the victim's browser");
  assert.equal(h.rows("broker_oauth_pending").find((p) => p.connection_id === id)?.stage, "start", "nothing used up");
});

test("callback: unknown state, missing state, a denied approval, a wrong host", async () => {
  const b = browser({ session: newMember() });
  const unknown = await b.send("GET", `${CANONICAL}/api/broker/callback/schwab?code=abc&state=${"s".repeat(43)}`);
  assert.equal(unknown.status, 410, unknown.text);
  assert.match(unknown.text, /expired or was already used/);
  const missing = await b.send("GET", `${CANONICAL}/api/broker/callback/schwab?code=abc`);
  assert.equal(missing.status, 400);
  const unknownBroker = await b.send("GET", `${CANONICAL}/api/broker/callback/vanguard?code=abc&state=${"s".repeat(43)}`);
  assert.equal(unknownBroker.status, 404);
  const elsewhere = await b.send("GET", `${TENANT}/api/broker/callback/schwab?code=abc&state=${"s".repeat(43)}`);
  assert.equal(elsewhere.status, 404, "the callback answers on the canonical host only");

  const { connectionId: id } = await startSchwab(b, CANONICAL);
  const go = await b.send("GET", `${CANONICAL}/api/broker/oauth/go?cid=${id}&n=${b.cookie("localhost:3000", `ns_oauth_${id}`)}`);
  const authorize = new URL(String(go.location));
  const denied = await b.send("GET", `${CANONICAL}/api/broker/callback/schwab?error=access_denied&state=${authorize.searchParams.get("state")}`);
  assert.equal(denied.status, 400, denied.text);
  assert.match(denied.text, /did not grant access/);
  assert.equal(row(id), undefined, "a login that never connected is removed");
});

test("finish: signed out, without the cookie, with the wrong cookie, from another workspace", async () => {
  /** A login that reached the claim step on the tenant host; returns its finish URL. @param {ReturnType<typeof browser>} b */
  async function toClaim(b) {
    const { connectionId: id, openUrl } = await startSchwab(b, TENANT);
    const nonce = String(new URL(openUrl).searchParams.get("n"));
    const go = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: nonce }, site: "same-origin", origin: CANONICAL });
    const approval = await simulateBrowserApproval(String(go.location));
    const cb = await b.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
    assert.equal(cb.status, 303, cb.text);
    return { id, finish: String(cb.location) };
  }

  // Signed out on the user's host: nothing is used, the user is told to sign in.
  const me = newMember();
  const b1 = browser({ session: me });
  const one = await toClaim(b1);
  const signedOut = await browser().send("GET", one.finish);
  assert.equal(signedOut.status, 401);
  assert.match(signedOut.text, /Sign in to Nasscord/);
  assert.equal(h.rows("broker_oauth_pending").find((p) => p.connection_id === one.id)?.stage, "claim", "the ticket was not used");

  // Another browser of the same user (the session, but not the cookie): refused before the service.
  const noCookie = await browser({ session: me }).send("GET", one.finish);
  assert.equal(noCookie.status, 403);
  assert.match(noCookie.text, /another browser/);

  // A member of another workspace with the original browser's cookie copied: not their connection.
  const outsider = browser({ session: newMember({ wid: randomUUID(), workspaceName: "Other" }) });
  outsider.jar.set(TENANT_HOST, new Map(b1.jar.get(TENANT_HOST)));
  const foreign = await outsider.send("GET", one.finish);
  assert.equal(foreign.status, 404);
  assert.notEqual(row(one.id)?.status, "active");

  // The right session with a cookie that does not match: the service refuses and removes the login.
  const b2 = browser({ session: newMember() });
  const two = await toClaim(b2);
  b2.jar.get(TENANT_HOST)?.set(`ns_oauth_${two.id}`, { value: "w".repeat(43), path: "/api/broker" });
  const wrong = await b2.send("GET", two.finish);
  assert.equal(wrong.status, 403, wrong.text);
  assert.notEqual(row(two.id)?.status, "active");

  // The original browser still finishes its own login.
  const ok = await b1.send("GET", one.finish);
  assert.equal(ok.status, 303, ok.text);
  assert.equal(row(one.id)?.status, "active");
});

test("start: refused from a foreign origin, a suspended tenant, a cross-site call, sandbox in production", async () => {
  const b = browser({ session: newMember() });
  const foreign = await b.api("http://evil.example", "/api/broker/oauth/start", schwabApp);
  assert.equal(foreign.status, 400);
  assert.match(foreign.json.error, /cannot return to this address/);
  const paused = await b.api("http://paused.acme.test", "/api/broker/oauth/start", schwabApp);
  assert.equal(paused.status, 400);
  const crossSite = await b.send("POST", `${TENANT}/api/broker/oauth/start`, { json: schwabApp, site: "cross-site", origin: "https://evil.example" });
  assert.equal(crossSite.status, 403);
  const halfApp = await b.api(TENANT, "/api/broker/oauth/start", { ...schwabApp, clientSecret: "" });
  assert.equal(halfApp.status, 400);

  process.env.NODE_ENV = "production";
  try {
    const sandbox = await b.api(TENANT, "/api/broker/oauth/start", { brokerId: "tastytrade", environment: "sandbox" });
    assert.equal(sandbox.status, 400);
    assert.match(sandbox.json.error, /sample data/);
    const aggSandbox = await b.api(TENANT, "/api/broker/aggregator/start", { brokerId: "fidelity", environment: "sandbox" });
    assert.equal(aggSandbox.status, 400, aggSandbox.text);
    assert.match(aggSandbox.json.error, /sample data/);
  } finally {
    process.env.NODE_ENV = "test";
  }
  const aggUnknown = await b.api(TENANT, "/api/broker/aggregator/start", { brokerId: "fidelity", environment: "nope" });
  assert.equal(aggUnknown.status, 400);
});

test("SnapTrade: portal through the canonical callback; a browser without the hop is refused", async () => {
  const b = browser({ session: newMember() });
  const start = await b.api(TENANT, "/api/broker/aggregator/start", { brokerId: "fidelity" });
  assert.equal(start.status, 200, start.text);
  const { connectionId: id, openUrl } = start.json;
  const nonce = String(new URL(openUrl).searchParams.get("n"));
  // The confirmation page says SnapTrade's portal comes first, not Fidelity's own page.
  const page = await b.send("GET", openUrl);
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /Next you choose and log in to Fidelity through SnapTrade\./);
  assert.doesNotMatch(page.text, /on its own page/);
  const go = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: nonce }, site: "same-origin", origin: CANONICAL });
  assert.equal(go.status, 303, go.text);
  const portal = new URL(String(go.location));
  assert.equal(portal.origin, "https://portal.example.test");
  const back = String(portal.searchParams.get("customRedirect"));
  assert.equal(back, `${CANONICAL}/api/broker/callback/snaptrade?cid=${id}`);
  const cb = await b.send("GET", `${back}&status=SUCCESS&connection_id=auth-777`);
  assert.equal(cb.status, 303, cb.text);
  assert.ok(String(cb.location).startsWith(`${TENANT}/api/broker/oauth/finish?cid=${id}&ticket=`));
  assert.ok(!String(cb.location).includes("auth-777"), "the authorization id stays on the canonical host");
  const done = await b.send("GET", String(cb.location));
  assert.equal(done.location, `/app/brokers?connected=${id}`);
  assert.equal(row(id)?.status, "active");

  // Someone else's browser lands on the callback of a portal link that was forwarded to them.
  const b2 = browser({ session: newMember() });
  const s2 = await b2.api(TENANT, "/api/broker/aggregator/start", { brokerId: "robinhood" });
  const n2 = String(new URL(s2.json.openUrl).searchParams.get("n"));
  const go2 = await b2.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: s2.json.connectionId, n: n2 }, site: "same-origin", origin: CANONICAL });
  const back2 = String(new URL(String(go2.location)).searchParams.get("customRedirect"));
  const stranger = await browser().send("GET", `${back2}&status=SUCCESS&connection_id=auth-888`);
  assert.equal(stranger.status, 403, stranger.text);
  assert.equal(row(s2.json.connectionId), undefined, "removed: whoever did the hop cannot finish it now");
  // The page names no intermediary as the broker: SnapTrade is not what the user connected.
  assert.match(stranger.text, /The broker was not connected/);
  assert.doesNotMatch(stranger.text, /SnapTrade was not connected/);

  // Webull has a login of its own (Webull Connect) and is read through SnapTrade meanwhile: the
  // hop page cannot tell from the broker, so the connection row says which.
  const b3 = browser({ session: newMember() });
  const s3 = await b3.api(TENANT, "/api/broker/aggregator/start", { brokerId: "webull" });
  assert.equal(s3.status, 200, s3.text);
  const page3 = await b3.send("GET", s3.json.openUrl);
  assert.equal(page3.status, 200, page3.text);
  assert.match(page3.text, /Next you choose and log in to [^.]+ through SnapTrade\./);
});

test("key connect: Alpaca key, replace-key mode, and renew answering api_key", async () => {
  const b = browser({ session: newMember() });
  const r = await b.api(TENANT, "/api/broker/key/connect", { brokerId: "alpaca", keyId: "PKTEST1234", secret: "alpaca-secret-1234567" });
  assert.equal(r.status, 200, r.text);
  const id = r.json.connection.id;
  assert.equal(r.json.connection.environment, "paper");
  assert.ok(!r.text.includes("alpaca-secret-1234567"), "the secret never comes back");
  const short = await b.api(TENANT, "/api/broker/key/connect", { brokerId: "alpaca", secret: "short" });
  assert.equal(short.status, 400);
  const sandbox = await b.api(TENANT, "/api/broker/key/connect", { brokerId: "alpaca", environment: "sandbox", secret: "alpaca-secret-1234567" });
  assert.equal(sandbox.status, 400, "no sample-data environment for keys");

  // Alpaca stops accepting the key (regenerated): Reconnect asks for the new key.
  keys.delete("alpaca-secret-1234567");
  keys.set("alpaca-secret-NEW-7654321", { account: "ALP-ACC-1", environment: "paper" });
  const renew = await b.api(TENANT, `/api/broker/connections/${id}/renew`);
  assert.equal(renew.status, 200, renew.text);
  assert.deepEqual(renew.json.next, { kind: "api_key" });
  assert.equal(renew.headers.getSetCookie().length, 0, "no login cookie for a key");
  const rekey = await b.api(TENANT, "/api/broker/key/connect", { brokerId: "alpaca", keyId: "PKTEST1234", secret: "alpaca-secret-NEW-7654321", connectionId: id });
  assert.equal(rekey.status, 200, rekey.text);
  assert.equal(rekey.json.connection.id, id, "the same connection, Included switches kept");
  const notMine = await b.api(TENANT, "/api/broker/key/connect", { brokerId: "alpaca", secret: "alpaca-secret-NEW-7654321", connectionId: randomUUID() });
  assert.equal(notMine.status, 404);
});

test("renew of an OAuth connection: next.kind redirect with the hop and the binding cookie, then the same login", async () => {
  const b = browser({ session: newMember() });
  const { connectionId: id } = await startSchwab(b, CANONICAL);
  const first = await b.send("GET", `${CANONICAL}/api/broker/oauth/go?cid=${id}&n=${b.cookie("localhost:3000", `ns_oauth_${id}`)}`);
  const a1 = await simulateBrowserApproval(String(first.location));
  const cb1 = await b.send("GET", `${a1.callbackUrl}?code=${encodeURIComponent(String(a1.code))}&state=${a1.state}`);
  await b.send("GET", String(cb1.location));
  assert.equal(row(id)?.status, "active");

  const renew = await b.api(TENANT, `/api/broker/connections/${id}/renew`);
  assert.equal(renew.status, 200, renew.text);
  assert.equal(renew.json.next.kind, "redirect");
  const hop = new URL(renew.json.next.url);
  assert.equal(`${hop.origin}${hop.pathname}`, `${CANONICAL}/api/broker/oauth/go`);
  assert.equal(hop.searchParams.get("cid"), id);
  assert.equal(b.cookie(TENANT_HOST, `ns_oauth_${id}`), hop.searchParams.get("n"), "binding cookie set on the user's host");
  assert.equal(row(id)?.status, "active", "reads go on while the new login runs");

  const go = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: String(hop.searchParams.get("n")) }, site: "same-origin", origin: CANONICAL });
  const a2 = await simulateBrowserApproval(String(go.location));
  const cb2 = await b.send("GET", `${a2.callbackUrl}?code=${encodeURIComponent(String(a2.code))}&state=${a2.state}`);
  assert.equal(cb2.status, 303, cb2.text);
  const done = await b.send("GET", String(cb2.location));
  assert.equal(done.location, `/app/brokers?connected=${id}`);
  assert.equal(row(id)?.status, "active");
});

test("renew of IBKR and E*TRADE: next plus the fields the existing dialogs read; the IBKR link stays on the server", async () => {
  // A stand-in service answers the renew; the route's mapping is under test here (the real IBKR
  // and E*TRADE renew paths are covered by the broker service's own tests).
  const me = newMember();
  const ibkrId = randomUUID();
  const etradeId = randomUUID();
  const otherId = randomUUID();
  const base = { workspace_id: me.member.workspace_id, user_id: me.user.id, status: "active", environment: "production" };
  h.db.tables.set("broker_connections", [
    ...(h.db.tables.get("broker_connections") ?? []),
    { ...base, id: ibkrId, broker_id: "ibkr", method: "ibkr_gateway" },
    { ...base, id: etradeId, broker_id: "etrade", method: "etrade_oauth1" },
    { ...base, id: otherId, broker_id: "etrade", method: "etrade_oauth1" },
  ]);
  const connection = (/** @type {string} */ id, /** @type {string} */ brokerId, /** @type {string} */ method) => ({
    id, brokerId, method, environment: "production", status: "expired", statusDetail: null, sessionExpiresAt: null, lastOkAt: null, accounts: [],
  });
  const stub = http.createServer((req, res) => {
    const id = /\/v1\/connections\/([^/]+)\/renew$/.exec(req.url ?? "")?.[1];
    /** @type {unknown} */
    let body = { error: "no" };
    if (id === ibkrId) body = { connection: connection(id, "ibkr", "ibkr_gateway"), loginUrl: "https://ibkr-login.example/start?t=SECRET-TICKET", next: { kind: "gateway_login" } };
    if (id === etradeId) {
      const authorizeUrl = "https://us.etrade.com/e/t/etws/authorize?key=k&token=t";
      body = { connection: connection(id, "etrade", "etrade_oauth1"), loginUrl: authorizeUrl, next: { kind: "oauth1_verifier", authorizeUrl } };
    }
    if (id === otherId) body = { connection: { ...connection(id, "etrade", "etrade_oauth1"), status: "active" } };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", () => r(undefined)));
  const previous = process.env.BROKER_SERVICE_URL;
  process.env.BROKER_SERVICE_URL = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (stub.address()).port}`;
  try {
    const b = browser({ session: me });
    const ibkr = await b.api(TENANT, `/api/broker/connections/${ibkrId}/renew`);
    assert.equal(ibkr.status, 200, ibkr.text);
    assert.deepEqual(ibkr.json.next, { kind: "gateway_login" });
    assert.equal(ibkr.json.needsLogin, true);
    assert.ok(!ibkr.text.includes("SECRET-TICKET"), "the login host link never reaches the browser");

    const etrade = await b.api(TENANT, `/api/broker/connections/${etradeId}/renew`);
    assert.equal(etrade.status, 200, etrade.text);
    assert.deepEqual(etrade.json.next, { kind: "oauth1_verifier", authorizeUrl: "https://us.etrade.com/e/t/etws/authorize?key=k&token=t" });
    assert.equal(etrade.json.authorizeUrl, "https://us.etrade.com/e/t/etws/authorize?key=k&token=t");

    const fine = await b.api(TENANT, `/api/broker/connections/${otherId}/renew`);
    assert.equal(fine.status, 200);
    assert.equal(fine.json.next, undefined, "no next: the session works again");
    assert.equal(fine.json.connection.status, "connected");

    const notMine = await browser({ session: newMember({ wid: randomUUID(), workspaceName: "Elsewhere" }) }).api(TENANT, `/api/broker/connections/${ibkrId}/renew`);
    assert.equal(notMine.status, 404);
  } finally {
    process.env.BROKER_SERVICE_URL = previous;
    await new Promise((r) => stub.close(() => r(undefined)));
  }
});

test("start: 503 when the broker service's OAUTH_CALLBACK_BASE is not this site", async () => {
  // Another broker service whose callback base names another origin. The options cache is per role,
  // so this member has a role no other test uses: the answer comes from this service, not the cache.
  const other = await createHarness({
    env: { BROKER_AUDIENCE: "schwab_oauth=all", OAUTH_CALLBACK_BASE: "https://elsewhere.example", SNAPTRADE_CLIENT_ID: "snap-id", SNAPTRADE_CONSUMER_KEY: "snap-key" },
    adapters: [
      ["schwab", fakeOAuthAdapter({ server: schwab })],
      ["snaptrade", fakeAggregatorAdapter()],
    ],
  });
  const previous = process.env.BROKER_SERVICE_URL;
  process.env.BROKER_SERVICE_URL = other.api.url;
  try {
    const me = newMember();
    me.member.role = "tenant_user";
    const b = browser({ session: me });
    const oauth = await b.api(TENANT, "/api/broker/oauth/start", schwabApp);
    assert.equal(oauth.status, 503, oauth.text);
    assert.match(oauth.json.error, /OAUTH_CALLBACK_BASE/);
    assert.equal(oauth.headers.getSetCookie().length, 0, "no binding cookie");
    const agg = await b.api(TENANT, "/api/broker/aggregator/start", { brokerId: "fidelity" });
    assert.equal(agg.status, 503, agg.text);
    assert.equal(other.rows("broker_connections").length, 0, "nothing started on the service");
  } finally {
    process.env.BROKER_SERVICE_URL = previous;
    await other.close();
  }
});

test("callback: a login past its 10 minutes is refused and removed", async () => {
  const b = browser({ session: newMember() });
  const { connectionId: id, openUrl } = await startSchwab(b, TENANT);
  const go = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: id, n: String(new URL(openUrl).searchParams.get("n")) }, site: "same-origin", origin: CANONICAL });
  assert.equal(go.status, 303, go.text);
  const approval = await simulateBrowserApproval(String(go.location));
  // The window runs out while the user is on the broker's page. (The hand-off row's clock is moved,
  // not the service's: the app signs its service JWT with the real clock.)
  const pending = h.rows("broker_oauth_pending").find((p) => p.connection_id === id);
  assert.ok(pending);
  pending.expires_at = new Date(Date.now() - 1000).toISOString();
  const cb = await b.send("GET", `${approval.callbackUrl}?code=${encodeURIComponent(String(approval.code))}&state=${approval.state}`);
  assert.equal(cb.status, 410, cb.text);
  assert.equal(cb.location, null, "no ticket travels");
  assert.match(cb.text, /longer than 10 minutes/);
  assert.equal(row(id), undefined, "a login that never connected is removed");
});

test("hop and callback: 60 of each per client address in 10 minutes, then 429", async () => {
  const b = browser({ ip: "203.0.113.61" });
  for (let i = 0; i < 60; i++) {
    const r = await b.send("GET", `${CANONICAL}/api/broker/oauth/go`);
    assert.equal(r.status, 400, `hop ${i + 1}`);
  }
  const hop = await b.send("GET", `${CANONICAL}/api/broker/oauth/go`);
  assert.equal(hop.status, 429, hop.text);
  assert.match(hop.text, /Too many login attempts/);
  const post = await b.send("POST", `${CANONICAL}/api/broker/oauth/go`, { form: { cid: randomUUID(), n: "n".repeat(43) }, site: "same-origin", origin: CANONICAL });
  assert.equal(post.status, 429, "the Continue button counts against the same guard");

  for (let i = 0; i < 60; i++) {
    const r = await b.send("GET", `${CANONICAL}/api/broker/callback/schwab`);
    assert.equal(r.status, 400, `callback ${i + 1}`);
  }
  const cb = await b.send("GET", `${CANONICAL}/api/broker/callback/schwab?code=abc&state=${"s".repeat(43)}`);
  assert.equal(cb.status, 429, cb.text);
  assert.match(cb.text, /Too many login attempts/);
  // Another address is not held back by this one.
  const elsewhere = await browser({ ip: "203.0.113.62" }).send("GET", `${CANONICAL}/api/broker/oauth/go`);
  assert.equal(elsewhere.status, 400);
});

test("no secret, code, state, ticket or nonce reaches a log line; no secret or code comes back in an answer", () => {
  const all = [...appLog, ...h.logLines].join("\n");
  for (const secret of ["schwab-app-secret-456", "alpaca-secret-1234567", "alpaca-secret-NEW-7654321"]) {
    assert.ok(!all.includes(secret), `logged: ${secret}`);
    assert.ok(!answers.some((a) => a.includes(secret)), `answered: ${secret}`);
  }
  assert.ok(answers.length > 40, "the answers were captured");
  assert.ok(!answers.some((a) => /[?&]code=/.test(a)), "no answer of the app carries a broker code");
  assert.doesNotMatch(all, /code=|state=|ticket=|[?&]n=/, "no query strings in the logs");
  assert.doesNotMatch(all, /ns_oauth_[0-9a-f-]{36}=[A-Za-z0-9_-]{20,}/, "no binding cookie values in the logs");
});
