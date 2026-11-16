import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, mock, test } from "node:test";

/*
 * Unit tests of src/lib/server/oauth-return.ts: the return-origin allowlist, the binding nonce and
 * its cookie, the broker redirect check and the login-tab page. Run with the command in
 * alias-hooks.mjs.
 */

/** @type {Map<string, { status: string, whiteLabel: boolean, branding?: { domain?: string } }>} */
const tenants = new Map([
  ["trade.acme.com", { status: "active", whiteLabel: true, branding: { domain: "trade.acme.com" } }],
  ["desk.paused.com", { status: "suspended", whiteLabel: true, branding: { domain: "desk.paused.com" } }],
  ["plain.tenant.com", { status: "active", whiteLabel: false, branding: { domain: "plain.tenant.com" } }],
]);
mock.module("@/lib/tenant-server", { exports: { getTenantByDomain: async (/** @type {string} */ d) => tenants.get(d) ?? null } });
/** Workspace slugs that exist (the allowlist looks a subdomain up in workspaces). */
const slugs = new Set(["vivek-desk", "acme-traders"]);
/** A service-role client that answers `workspaces` by slug only. */
function fakeAdmin() {
  return {
    from: (/** @type {string} */ table) => {
      /** @type {Record<string, unknown>} */
      const where = {};
      const q = {
        select: () => q,
        eq: (/** @type {string} */ k, /** @type {unknown} */ v) => ((where[k] = v), q),
        async maybeSingle() {
          if (table !== "workspaces") throw new Error(`unexpected table ${table}`);
          return { data: slugs.has(String(where.slug)) ? { id: "w" } : null, error: null };
        },
      };
      return q;
    },
  };
}
mock.module("@/lib/supabase/admin", { exports: { isAdminConfigured: () => true, createAdminClient: fakeAdmin } });

/** @type {typeof import("../oauth-return.ts")} */
let m;
const saved = { NODE_ENV: process.env.NODE_ENV, NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL };

/** @param {Record<string, string | undefined>} env */
function setEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

before(async () => {
  setEnv({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://nasscord.com" });
  m = await import("@/lib/server/oauth-return");
});
after(() => setEnv(saved));

test("allowlist in production: canonical, workspace subdomains, active white-label tenants only", async () => {
  setEnv({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://nasscord.com" });
  assert.equal(m.canonicalOrigin(), "https://nasscord.com");
  assert.equal(await m.returnOriginKind("https://nasscord.com"), "canonical");
  assert.equal(await m.returnOriginKind("https://NASSCORD.com/"), "canonical", "normalized");
  assert.equal(await m.returnOriginKind("https://vivek-desk.nasscord.com"), "workspace");
  assert.equal(await m.returnOriginKind("https://trade.acme.com"), "tenant");

  assert.equal(await m.returnOriginKind("https://evil.example"), null, "a foreign site");
  assert.equal(await m.returnOriginKind("https://desk.paused.com"), null, "a suspended tenant");
  assert.equal(await m.returnOriginKind("https://plain.tenant.com"), null, "a tenant without white-label");
  assert.equal(await m.returnOriginKind("http://trade.acme.com"), null, "plain http in production");
  assert.equal(await m.returnOriginKind("http://nasscord.com"), null, "plain http canonical");
  assert.equal(await m.returnOriginKind("https://trade.acme.com:8443"), null, "an explicit port in production");
  assert.equal(await m.returnOriginKind("http://localhost:3000"), null, "localhost only outside production");
  assert.equal(await m.returnOriginKind("https://a.b.nasscord.com"), null, "nested subdomain");
  assert.equal(await m.returnOriginKind("https://www.nasscord.com"), null, "www is not a workspace");
  for (const reserved of ["ibkr-login", "status", "mail", "docs", "broker", "api", "admin", "app", "support"]) {
    assert.equal(await m.returnOriginKind(`https://${reserved}.nasscord.com`), null, `${reserved}: a reserved name is never a return origin`);
  }
  assert.equal(await m.returnOriginKind("https://does-not-exist-123.nasscord.com"), null, "a subdomain no workspace holds");
  assert.equal(await m.returnOriginKind("https://acme-traders.nasscord.com"), "workspace");
  assert.equal(
    await m.returnOriginKind("https://vivek-desk.nasscord.com", undefined, async () => {
      throw new Error("database down");
    }),
    null,
    "a failed workspace lookup refuses",
  );
  assert.equal(await m.returnOriginKind("https://nasscord.com.evil.example"), null, "suffix trick");
  assert.equal(await m.returnOriginKind("https://203.0.113.9"), null, "an IP address");
  assert.equal(await m.returnOriginKind("https://nasscord.com/app"), null, "a path is not an origin");
  assert.equal(await m.returnOriginKind("https://user@nasscord.com"), null, "user info");
  assert.equal(await m.returnOriginKind("javascript:alert(1)"), null);
  assert.equal(await m.returnOriginKind(null), null);
});

test("canonical origin: https required in production, localhost default outside it", () => {
  setEnv({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "http://nasscord.com" });
  assert.equal(m.canonicalOrigin(), null, "http refused in production");
  setEnv({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: undefined });
  assert.equal(m.canonicalOrigin(), null, "no default in production");
  setEnv({ NODE_ENV: "development", NEXT_PUBLIC_SITE_URL: undefined });
  assert.equal(m.canonicalOrigin(), "http://localhost:3000");
});

test("allowlist outside production: localhost and its subdomains", async () => {
  setEnv({ NODE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" });
  assert.equal(await m.returnOriginKind("http://localhost:3000"), "canonical");
  assert.equal(await m.returnOriginKind("http://vivek.localhost:3000"), "development");
  assert.equal(await m.returnOriginKind("http://evil.example"), null);
});

test("binding: 43-character nonce, sha256 hex hash, constant-time compare", () => {
  const b = m.newBinding();
  assert.match(b.nonce, m.OPAQUE_RE);
  assert.equal(b.hash, createHash("sha256").update(b.nonce).digest("hex"));
  assert.notEqual(m.newBinding().nonce, b.nonce);
  assert.equal(m.sameNonce(b.nonce, b.nonce), true);
  assert.equal(m.sameNonce(b.nonce, m.newBinding().nonce), false);
  assert.equal(m.sameNonce(null, b.nonce), false);
});

test("binding cookie: HttpOnly, SameSite=Lax, Path=/api/broker, 10 minutes, Secure on https", () => {
  const id = "0b7c8a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d";
  const c = m.bindingCookie(id, "n".repeat(43), "https://nasscord.com");
  assert.equal(c, `ns_oauth_${id}=${"n".repeat(43)}; Path=/api/broker; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
  assert.doesNotMatch(m.bindingCookie(id, "n".repeat(43), "http://localhost:3000"), /Secure/);
  assert.match(m.clearBindingCookie(id, "https://nasscord.com"), /^ns_oauth_[0-9a-f-]+=; Path=\/api\/broker; Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
});

test("binding cookies on a request: by connection id, the 8 newest, junk ignored", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
  const nonce = (/** @type {number} */ i) => `${String(i).padStart(2, "0")}${"x".repeat(41)}`;
  const cookie = [
    "sb-access=abc",
    ...ids.map((id, i) => `ns_oauth_${id}=${nonce(i)}`),
    "ns_oauth_not-a-uuid=" + "y".repeat(43),
    `ns_oauth_${ids[0]}=short`,
  ].join("; ");
  const req = new Request("http://localhost:3000/api/broker/callback/schwab", { headers: { cookie } });
  const all = m.allBindings(req);
  assert.equal(Object.keys(all).length, 8, "the service reads at most 8");
  assert.equal(all[ids[9]], nonce(9), "the newest are kept");
  assert.equal(all[ids[0]], undefined, "the oldest are dropped");
  assert.equal(m.bindingFromCookies(req, ids[3]), nonce(3));
  assert.equal(m.bindingFromCookies(req, ids[3].toUpperCase()), nonce(3), "ids compare in lower case");
  assert.equal(m.bindingFromCookies(new Request("http://x/"), ids[3]), null);
});

test("request origin: forwarded host and proto, else the request URL", () => {
  const r = new Request("http://127.0.0.1:3000/api/broker/oauth/start", { headers: { "x-forwarded-host": "Trade.Acme.com", "x-forwarded-proto": "https" } });
  assert.equal(m.requestOrigin(r), "https://trade.acme.com");
  const local = new Request("http://localhost:3000/api/x", { headers: { host: "localhost:3000" } });
  assert.equal(m.requestOrigin(local), "http://localhost:3000");
});

test("same-origin calls: Sec-Fetch-Site and Origin must name this host", () => {
  const own = "https://nasscord.com";
  const call = (/** @type {Record<string, string>} */ headers) => m.sameOriginCall(new Request("https://nasscord.com/api/broker/oauth/go", { method: "POST", headers }), own);
  assert.equal(call({ "sec-fetch-site": "same-origin", origin: own }), true);
  assert.equal(call({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), false);
  assert.equal(call({ "sec-fetch-site": "same-site", origin: "https://vivek.nasscord.com" }), false);
  assert.equal(call({ origin: "https://evil.example" }), false);
  assert.equal(call({ origin: "null" }), false);
  assert.equal(call({}), false, "a browser POST carries one of the two");
  assert.equal(call({ origin: own }), true);
});

test("broker redirect: https only; http to localhost outside production", () => {
  setEnv({ NODE_ENV: "production" });
  assert.equal(m.brokerRedirect("https://api.schwabapi.com/v1/oauth/authorize?x=1"), "https://api.schwabapi.com/v1/oauth/authorize?x=1");
  assert.equal(m.brokerRedirect("http://api.schwabapi.com/v1/oauth/authorize"), null);
  assert.equal(m.brokerRedirect("http://127.0.0.1:9001/authorize"), null, "no local fakes in production");
  assert.equal(m.brokerRedirect("javascript:alert(1)"), null);
  assert.equal(m.brokerRedirect("https://user:pw@evil.example/"), null);
  assert.equal(m.brokerRedirect(42), null);
  setEnv({ NODE_ENV: "test" });
  assert.equal(m.brokerRedirect("http://127.0.0.1:9001/authorize"), "http://127.0.0.1:9001/authorize");
  assert.equal(m.brokerRedirect("http://evil.example/authorize"), null);
});

test("callback segments: OAuth brokers and snaptrade only", () => {
  for (const b of ["schwab", "tradestation", "tradier", "tastytrade", "webull", "alpaca", "snaptrade"]) assert.equal(m.callbackSegment(b), b);
  assert.equal(m.callbackSegment("SCHWAB"), "schwab");
  for (const b of ["ibkr", "etrade", "fidelity", "robinhood", "vanguard", "", "..", "schwab/x"]) assert.equal(m.callbackSegment(b), null, b);
  assert.ok(m.REDIRECT_METHODS.has("schwab_oauth") && m.REDIRECT_METHODS.has("snaptrade") && m.REDIRECT_METHODS.has("tradier_oauth"));
  assert.ok(!m.REDIRECT_METHODS.has("alpaca_key") && !m.REDIRECT_METHODS.has("ibkr_gateway") && !m.REDIRECT_METHODS.has("etrade_oauth1"));
});

test("login-tab page: escaped, unframeable, no referrer, no outside resources", async () => {
  const res = m.flowPage({ status: 200, title: "<t>", heading: 'Desk "<img src=x onerror=alert(1)>"', paragraphs: ["a & b"], form: { action: "/api/broker/oauth/go", fields: { cid: "c\"><script>", n: "n" }, button: "Go" } });
  const html = await res.text();
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /"><script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /a &amp; b/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(res.headers.get("referrer-policy"), "same-origin", "the form posts back with its Origin");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const plain = m.flowPage({ status: 400, title: "x", heading: "x", paragraphs: [] });
  assert.equal(plain.headers.get("referrer-policy"), "no-referrer");
  // The one inline script is allowed by its hash and nothing else.
  const script = /<script>([^<]*)<\/script>/.exec(html)?.[1] ?? "";
  const hash = createHash("sha256").update(script).digest("base64");
  assert.match(res.headers.get("content-security-policy") ?? "", new RegExp(`script-src 'sha256-${hash.replace(/[+/=]/g, (c) => `\\${c}`)}'`));
});

test("see-other: no referrer, no cache, cookies appended", () => {
  const r = m.seeOther("https://broker.example/authorize", ["a=1", "b=2"]);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "https://broker.example/authorize");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(r.headers.getSetCookie(), ["a=1", "b=2"]);
});
