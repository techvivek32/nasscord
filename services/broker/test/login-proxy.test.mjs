import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import {
  browserResponseHeaders,
  createLoginProxy,
  createLoginTokens,
  gatewayRequestHeaders,
  isAllowedLoginPath,
  LOGIN_COOKIE,
  maskEmail,
  rewriteLocation,
  rewriteSetCookie,
  TICKET_TTL_MS,
} from "../src/ibkr/login-proxy.mjs";
import { silentLogger } from "../src/log.mjs";
import { listen } from "./helpers/common.mjs";

const SECRET = "s".repeat(48);

test("tickets: one-time, 2-minute life, tamper-proof, bound to the secret", () => {
  let t = 1_793_700_000_000;
  const tokens = createLoginTokens(SECRET, { now: () => t });
  const cid = randomUUID();
  const ticket = tokens.issueTicket(cid);
  assert.equal(TICKET_TTL_MS, 2 * 60_000);
  assert.equal(tokens.peekTicket(ticket), cid, "the confirmation page checks it");
  assert.equal(tokens.peekTicket(ticket), cid, "without using it");
  assert.equal(tokens.redeemTicket(ticket), cid);
  assert.equal(tokens.redeemTicket(ticket), null, "a ticket works once");
  assert.equal(tokens.peekTicket(ticket), null, "a used ticket no longer shows the page");

  const late = tokens.issueTicket(cid);
  t += 2 * 60_000;
  assert.equal(tokens.peekTicket(late), null, "expired after 2 minutes");
  assert.equal(tokens.redeemTicket(late), null, "expired after 2 minutes");

  const fresh = tokens.issueTicket(cid);
  const [payload, sig] = fresh.split(".");
  const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), cid: randomUUID() })).toString("base64url");
  assert.equal(tokens.redeemTicket(`${other}.${sig}`), null, "changed payload");
  assert.equal(createLoginTokens("t".repeat(48), { now: () => t }).redeemTicket(fresh), null, "other secret");
  assert.equal(tokens.redeemTicket("garbage"), null);
  assert.equal(tokens.redeemTicket(undefined), null);
  assert.equal(tokens.redeemTicket(fresh), cid);
});

test("cookies: <cid>.<exp>.<sig>, expiry and tampering", () => {
  let t = 1_793_700_000_000;
  const tokens = createLoginTokens(SECRET, { now: () => t });
  const cid = randomUUID();
  const v = tokens.cookieValue(cid);
  assert.match(v, /^[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.readCookie(v), cid);
  const [c, exp, sig] = v.split(".");
  assert.equal(tokens.readCookie(`${c}.${Number(exp) + 3600}.${sig}`), null, "extended expiry");
  assert.equal(tokens.readCookie(`${randomUUID()}.${exp}.${sig}`), null, "other connection");
  assert.equal(tokens.readCookie(`${c}.${exp}.${sig.slice(0, -1)}A`), null);
  // a ticket signature is not a cookie signature
  assert.equal(tokens.readCookie(undefined), null);
  t += 60 * 60_000;
  assert.equal(tokens.readCookie(v), null, "expired");
});

test("allowlist: the login pages and assets only", () => {
  /** @type {Array<[string, string, boolean]>} */
  const cases = [
    ["GET", "/", true],
    ["GET", "/sso/Login", true],
    ["GET", "/sso/lib/xyz.bundle.min.js", true],
    ["POST", "/sso/Authenticator", true],
    ["POST", "/sso/Dispatcher", true],
    ["POST", "/sso/report", true],
    ["GET", "/css/am/login.min.css", true],
    ["GET", "/css/bootstrap-5.2.2/bootstrap.min.css", true],
    ["GET", "/scripts/common/js/jquery-3.7.0/jquery.min.js", true],
    ["GET", "/images/common/logos/ibkr/interactive-brokers.svg", true],
    ["GET", "/fonts/fontawesome-6.4.2/webfonts/fa-solid-900.woff2", true],
    ["HEAD", "/fonts/proxima-nova/Proxima-Nova-Regular.woff2", true],
    ["POST", "/portal.proxy/v1/gstat/bulletins", true],
    ["GET", "/v1/api/iserver/auth/status", true],
    ["POST", "/v1/api/iserver/auth/status", false],
    ["POST", "/v1/api/iserver/auth/ssodh/init", false],
    ["GET", "/v1/api/iserver/accounts", false],
    ["GET", "/v1/api/portfolio/accounts", false],
    ["POST", "/v1/api/iserver/account/U1/orders", false],
    ["POST", "/v1/api/tickle", false],
    ["POST", "/v1/api/logout", false],
    ["GET", "/demo", false],
    ["GET", "/demo/index.html", false],
    ["POST", "/css/am/login.min.css", false],
    ["DELETE", "/sso/Login", false],
    ["GET", "/sso/../v1/api/iserver/accounts", false],
    ["GET", "/sso/%2e%2e/v1/api/iserver/accounts", false],
    ["GET", "/css/..%2fv1/api", false],
    ["GET", "//evil.example/x", false],
    ["GET", "/credential.recovery/login-help", false],
    ["GET", "/AccountManagement/OneBarAuthentication", false],
  ];
  for (const [m, p, ok] of cases) assert.equal(isAllowedLoginPath(m, p), ok, `${m} ${p}`);
});

test("maskEmail keeps the first letter and the domain", () => {
  assert.equal(maskEmail("trader.one@example.com"), "t•••@example.com");
  assert.equal(maskEmail("a@b.co"), "a•••@b.co");
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail("not-an-email"), null);
  assert.equal(maskEmail("@x.com"), null);
});

test("Set-Cookie becomes host-only; Location becomes relative", () => {
  assert.equal(
    rewriteSetCookie("JSESSIONID=ABC.node; Path=/sso; HttpOnly;Secure;SameSite=None", true),
    "JSESSIONID=ABC.node; HttpOnly; Path=/; SameSite=Lax; Secure",
  );
  assert.equal(
    rewriteSetCookie('partnerID=""; Domain=.ibkr.com; Expires=Thu, 01 Jan 1970 00:00:10 GMT; Path=/;Secure;SameSite=None', false),
    'partnerID=""; Expires=Thu, 01 Jan 1970 00:00:10 GMT; Path=/; SameSite=Lax',
  );
  assert.equal(rewriteSetCookie("x-sess-uuid=0.1; secure; HttpOnly", false), "x-sess-uuid=0.1; HttpOnly; Path=/; SameSite=Lax");
  assert.equal(rewriteLocation("http://localhost:7200/sso/Login?forwardTo=22"), "/sso/Login?forwardTo=22");
  assert.equal(rewriteLocation("https://127.0.0.1:5000/"), "/");
  assert.equal(rewriteLocation("/sso/Login?RL=1"), "/sso/Login?RL=1");
  assert.equal(rewriteLocation("https://www.interactivebrokers.com/x"), "https://www.interactivebrokers.com/x");
});

test("forwarding headers are stripped, the login cookie stays on the login host", () => {
  const h = gatewayRequestHeaders(
    {
      host: "ibkr-login.nasscord.com",
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.9",
      "x-forwarded-host": "ibkr-login.nasscord.com",
      "x-forwarded-proto": "https",
      forwarded: "for=203.0.113.9",
      connection: "keep-alive",
      cookie: `${LOGIN_COOKIE}=abc; JSESSIONID=xyz; other=1`,
      "user-agent": "Mozilla/5.0",
    },
    7200,
  );
  assert.deepEqual(h, { "user-agent": "Mozilla/5.0", host: "localhost:7200", cookie: "JSESSIONID=xyz; other=1" });
  const r = browserResponseHeaders({ connection: "keep-alive", "transfer-encoding": "chunked", "content-type": "text/html" }, true);
  assert.equal(r["content-type"], "text/html");
  assert.equal(r["x-frame-options"], "DENY");
  assert.equal(r.connection, undefined);
  assert.equal(r["transfer-encoding"], undefined);
});

// ─────────────────────────────────────────── the proxy against a fake gateway

/** @type {Array<{ method: string, url: string, headers: http.IncomingHttpHeaders, body: string }>} */
const seen = [];
let flakyHits = 0;
/** @type {Awaited<ReturnType<typeof listen>>} */
let upstream;
/** @type {Awaited<ReturnType<typeof listen>>} */
let proxy;
const CID = randomUUID();
const CID_NO_GATEWAY = randomUUID();
const CID_BAD_PORT = randomUUID();
const CID_REMOVED = randomUUID();
let authenticated = false;
const tokens = createLoginTokens(SECRET);

before(async () => {
  upstream = await listen((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === "/") {
        res.writeHead(302, {
          location: `http://localhost:${upstream.port}/sso/Login?forwardTo=22&RL=1&ip2loc=US`,
          "set-cookie": ["JSESSIONID=J1.node; Path=/sso; HttpOnly;Secure;SameSite=None", "URL_PARAM=x; Domain=.ibkr.com; Path=/;Secure"],
        });
        return res.end();
      }
      if (req.url?.startsWith("/sso/Login")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<html><div class="loginformWrapper"></div><script src="lib/xyz.bundle.min.js"></script></html>');
      }
      if (req.url === "/css/flaky.css") {
        flakyHits++;
        if (flakyHits === 1) {
          // the Java gateway's habit: bytes that are not an HTTP response
          res.socket?.write("garbage that is not HTTP\r\n\r\n");
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "text/css" });
        return res.end("body{}");
      }
      if (req.url === "/v1/api/iserver/auth/status") {
        res.writeHead(401, { "content-type": "text/plain" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  const login = createLoginProxy({
    tokens,
    resolvePort: (cid) => (cid === CID ? upstream.port : cid === CID_BAD_PORT ? 1 : null),
    isSlotPort: (p) => p === upstream.port,
    whenReady: async () => true,
    isAuthenticated: () => authenticated,
    describe: async (cid) => (cid === CID ? { workspace: "Desk <A>", email: "trader.one@example.com" } : cid === CID_REMOVED ? null : { workspace: null, email: null }),
    cookieSecure: false,
    appUrl: "http://localhost:3100",
    log: silentLogger,
  });
  proxy = await listen((req, res) => login.handle(req, res));
  proxy.server.on("upgrade", (req, socket) => login.upgrade(req, socket));
});

after(async () => {
  await proxy?.close();
  await upstream?.close();
});

/**
 * Raw request so paths reach the proxy exactly as written.
 * @param {string} method
 * @param {string} path
 * @param {{ cookie?: string, body?: string, headers?: Record<string, string> }} [o]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function raw(method, path, o = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxy.port,
        method,
        path,
        agent: false,
        headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/**
 * The Continue button: a same-origin form POST of the ticket.
 * @param {string} ticket
 * @param {Record<string, string>} [headers]
 */
function cont(ticket, headers = { origin: `http://127.0.0.1:${proxy.port}`, "sec-fetch-site": "same-origin" }) {
  return raw("POST", "/start", {
    body: `t=${encodeURIComponent(ticket)}`,
    headers: { "content-type": "application/x-www-form-urlencoded", host: `127.0.0.1:${proxy.port}`, ...headers },
  });
}

/** @returns {Promise<string>} */
async function loginCookie() {
  const r = await cont(tokens.issueTicket(CID));
  assert.equal(r.status, 303);
  const sc = /** @type {string[]} */ (r.headers["set-cookie"])[0];
  return sc.split(";")[0];
}

test("GET /start shows whose workspace the login joins, sets no cookie and keeps the ticket", async () => {
  const ticket = tokens.issueTicket(CID);
  seen.length = 0;
  const r = await raw("GET", `/start?t=${encodeURIComponent(ticket)}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.match(r.body, /Connect IBKR to Nasscord/);
  assert.match(r.body, /the Nasscord workspace <strong>Desk &#60;A&#62;<\/strong>/, "named and escaped");
  assert.match(r.body, /t•••@example\.com/);
  assert.doesNotMatch(r.body, /trader\.one/, "the full email is never shown");
  assert.match(r.body, /If you did not press Connect in Nasscord just now, close this page\./);
  assert.match(r.body, /<form method="post" action="\/start"><input type="hidden" name="t" value="[A-Za-z0-9_.-]+">/);
  assert.match(String(r.headers["content-security-policy"]), /form-action 'self'/);
  assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "same-origin", "keeps the Origin header on the form POST");
  assert.equal(seen.length, 0, "nothing of IBKR is loaded before Continue");
  assert.equal(tokens.peekTicket(ticket), CID, "showing the page does not use the ticket");

  const generic = await raw("GET", `/start?t=${encodeURIComponent(tokens.issueTicket(CID_BAD_PORT))}`);
  assert.equal(generic.status, 200);
  assert.match(generic.body, /connected to a Nasscord workspace\./);
  const removed = await raw("GET", `/start?t=${encodeURIComponent(tokens.issueTicket(CID_REMOVED))}`);
  assert.equal(removed.status, 410, "a disconnected connection shows no page");
  const noGateway = await raw("GET", `/start?t=${encodeURIComponent(tokens.issueTicket(CID_NO_GATEWAY))}`);
  assert.equal(noGateway.status, 410);
  const bad = await raw("GET", "/start?t=garbage");
  assert.equal(bad.status, 400);
  assert.match(bad.body, /2 minutes/);
});

test("Continue (same-origin POST /start) sets the HttpOnly cookie and redirects to /; the ticket is single use", async () => {
  const ticket = tokens.issueTicket(CID);
  const r = await cont(ticket);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, "/");
  const sc = /** @type {string[]} */ (r.headers["set-cookie"])[0];
  assert.match(sc, new RegExp(`^${LOGIN_COOKIE}=${CID}\\.\\d+\\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600$`));
  assert.doesNotMatch(sc, /Secure/, "http public URL: no Secure flag");
  const again = await cont(ticket);
  assert.equal(again.status, 400);
  assert.match(again.body, /expired/);
  const page = await raw("GET", `/start?t=${encodeURIComponent(ticket)}`);
  assert.equal(page.status, 400, "a used link no longer shows the confirmation");
  assert.equal((await cont(tokens.issueTicket(CID_NO_GATEWAY))).status, 410);
  // no Origin or Sec-Fetch-Site at all (not a browser): allowed, the ticket is the credential
  assert.equal((await cont(tokens.issueTicket(CID), {})).status, 303);
});

test("another site cannot press Continue for the visitor", async () => {
  const ticket = tokens.issueTicket(CID);
  for (const headers of /** @type {Array<Record<string, string>>} */ ([
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { origin: "https://evil.example" },
    { origin: "null" },
  ])) {
    const r = await cont(ticket, headers);
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.equal(r.headers["set-cookie"], undefined);
  }
  assert.equal(tokens.peekTicket(ticket), CID, "a refused POST does not use the ticket");
  const json = await raw("POST", "/start", {
    body: JSON.stringify({ t: ticket }),
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${proxy.port}`, host: `127.0.0.1:${proxy.port}` },
  });
  assert.equal(json.status, 400, "only the form encoding is read");
});

test("the login page loads through the proxy with stripped headers and rewritten cookies", async () => {
  const cookie = await loginCookie();
  seen.length = 0;
  const r = await raw("GET", "/", {
    cookie: `${cookie}; JSESSIONID=old`,
    headers: { "x-forwarded-for": "198.51.100.7", "x-real-ip": "198.51.100.7", "x-forwarded-host": "ibkr-login.example" },
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/sso/Login?forwardTo=22&RL=1&ip2loc=US");
  assert.deepEqual(r.headers["set-cookie"], ["JSESSIONID=J1.node; HttpOnly; Path=/; SameSite=Lax", "URL_PARAM=x; Path=/; SameSite=Lax"]);
  const up = seen[0];
  assert.equal(up.url, "/");
  assert.equal(up.headers["x-forwarded-for"], undefined);
  assert.equal(up.headers["x-real-ip"], undefined);
  assert.equal(up.headers["x-forwarded-host"], undefined);
  assert.equal(up.headers.host, `localhost:${upstream.port}`);
  assert.equal(up.headers.cookie, "JSESSIONID=old", "the nsibkr cookie is not passed to the gateway");
  assert.equal(up.headers.connection, "close", "a fresh loopback connection per request");

  const page = await raw("GET", "/sso/Login?forwardTo=22&RL=1&ip2loc=US", { cookie });
  assert.equal(page.status, 200);
  assert.match(page.body, /loginformWrapper/);
  assert.equal(page.headers["x-frame-options"], "DENY");

  const post = await raw("POST", "/sso/Authenticator", { cookie, body: "ACTION=INIT&USER=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(post.status, 200);
  assert.equal(seen.at(-1)?.body, "ACTION=INIT&USER=x");

  const status = await raw("GET", "/v1/api/iserver/auth/status", { cookie });
  assert.equal(status.status, 401, "unauthenticated status passes through");
});

test("anything outside the allowlist is a 403 and never reaches the gateway", async () => {
  const cookie = await loginCookie();
  seen.length = 0;
  for (const [m, p] of [
    ["GET", "/v1/api/portfolio/accounts"],
    ["POST", "/v1/api/iserver/auth/ssodh/init"],
    ["GET", "/sso/../v1/api/iserver/accounts"],
    ["GET", "/sso/%2e%2e/v1/api/iserver/accounts"],
    ["GET", "/demo"],
  ]) {
    const r = await raw(m, p, { cookie });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const nav = await raw("GET", "/demo", { cookie, headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(nav.status, 302, "a page navigation outside the login goes to the status page");
  assert.equal(nav.headers.location, "/done");
  const apiNav = await raw("GET", "/v1/api/portfolio/accounts", { cookie, headers: { accept: "text/html" } });
  assert.equal(apiNav.status, 403);
  const api = await raw("GET", "/v1/api/iserver/accounts", { cookie });
  assert.deepEqual(JSON.parse(api.body), { error: "Not available on the login host." });
  assert.equal(seen.length, 0);
  const abs = await raw("GET", `http://127.0.0.1:${upstream.port}/sso/Login`, { cookie });
  assert.equal(abs.status, 400, "absolute-form request targets are refused");
});

test("no cookie, a forged cookie, or a port that is not a slot: refused", async () => {
  assert.equal((await raw("GET", "/sso/Login")).status, 401);
  assert.equal((await raw("GET", "/v1/api/iserver/auth/status")).status, 401);
  assert.equal((await raw("GET", "/", { cookie: `${LOGIN_COOKIE}=${CID}.9999999999.${"A".repeat(43)}` })).status, 401);
  const bad = `${LOGIN_COOKIE}=${tokens.cookieValue(CID_BAD_PORT)}`;
  assert.equal((await raw("GET", "/", { cookie: bad })).status, 410);
});

test("a GET that hits a parse error is retried once on a fresh connection", async () => {
  const cookie = await loginCookie();
  flakyHits = 0;
  const r = await raw("GET", "/css/flaky.css", { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body, "body{}");
  assert.equal(flakyHits, 2);
});

test("after the login, / goes to the done page; websockets are refused", async () => {
  const cookie = await loginCookie();
  authenticated = true;
  try {
    const r = await raw("GET", "/", { cookie });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/done");
    const done = await raw("GET", "/done", { cookie });
    assert.match(done.body, /You are logged in to IBKR/);
    assert.match(String(done.headers["content-security-policy"] ?? ""), /default-src 'none'/);
  } finally {
    authenticated = false;
  }
  const ws = await raw("GET", "/v1/api/ws", { cookie, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } }).catch((e) => e);
  assert.ok(ws instanceof Error || ws.status === 403);
});
