import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { bundleLooksValid, SERVICE_ROOT } from "../src/config.mjs";
import { createGatewayHttp } from "../src/ibkr/gateway-http.mjs";
import { createGatewayManager, portIsFree } from "../src/ibkr/gateway-manager.mjs";
import { createLoginProxy, createLoginTokens } from "../src/ibkr/login-proxy.mjs";
import { silentLogger } from "../src/log.mjs";
import { listen } from "./helpers/common.mjs";
import { freePorts } from "./helpers/fake-gateway.mjs";

/**
 * Starts the REAL IBKR Client Portal Gateway from its bundle and loads the login page through the
 * login proxy. Skipped when Java or the bundle is missing. Needs the internet: the gateway fetches
 * IBKR's login page from api.ibkr.com. No credentials are ever sent.
 *
 * Bundle lookup: $IBKR_GATEWAY_BUNDLE, then services/broker/vendor/clientportal.gw, then the
 * owner's local copy.
 */

const javaBin = process.env.JAVA_BIN || "java";
const java = spawnSync(javaBin, ["-version"], { encoding: "utf8" });
const hasJava = java.status === 0;
const bundle = [
  process.env.IBKR_GATEWAY_BUNDLE,
  path.join(SERVICE_ROOT, "vendor", "clientportal.gw"),
  process.platform === "win32" ? "D:\\ibkr sagar nipani\\trad\\client-protal" : undefined,
].find((p) => p && bundleLooksValid(p));
const skip = !hasJava ? "java is not installed" : !bundle ? "the IBKR gateway bundle is not available" : false;

const runtime = mkdtempSync(path.join(os.tmpdir(), "nasscord-gw-int-"));
/** @type {ReturnType<typeof createGatewayManager> | null} */
let manager = null;
/** @type {Awaited<ReturnType<typeof listen>> | null} */
let proxy = null;

after(async () => {
  await manager?.stopAll();
  await proxy?.close();
  rmSync(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/**
 * @param {number} port
 * @param {string} p
 * @param {string} [cookie]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function get(port, p, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: p,
        agent: false,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
          accept: "*/*",
          ...(cookie ? { cookie } : {}),
        },
        timeout: 45_000,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

test("real gateway: login page through the login proxy, auth status unauthenticated", { skip, timeout: 110_000 }, async (t) => {
  const [port] = await freePorts(1);
  const cid = randomUUID();
  manager = createGatewayManager({
    bundle: /** @type {string} */ (bundle),
    runtime,
    ports: [port],
    javaBin,
    log: silentLogger,
    readyTimeoutMs: 60_000,
  });
  assert.equal(manager.bundleAvailable(), true);
  assert.equal(await manager.start(cid), port);
  const ready = await manager.whenReady(cid);
  assert.equal(ready, true, `gateway did not start: ${manager.output(cid).join(" | ")}`);

  const conf = readFileSync(path.join(runtime, `slot-${port}`, "conf.yaml"), "utf8");
  assert.match(conf, new RegExp(`listenPort: ${port}`));
  assert.match(conf, /listenSsl: false/);
  assert.doesNotMatch(conf, /sslPwd|sslCert/);

  const tokens = createLoginTokens("i".repeat(48));
  const m = manager;
  const login = createLoginProxy({
    tokens,
    resolvePort: (id) => m.portFor(id),
    isSlotPort: m.isSlotPort,
    whenReady: (id) => m.whenReady(id),
    isAuthenticated: () => false,
    cookieSecure: false,
    log: silentLogger,
  });
  proxy = await listen((req, res) => login.handle(req, res));

  // the confirmation page (nothing of IBKR yet), then Continue
  const ticket = tokens.issueTicket(cid);
  const confirm = await get(proxy.port, `/start?t=${encodeURIComponent(ticket)}`);
  assert.equal(confirm.status, 200);
  assert.match(confirm.body, /If you did not press Connect in Nasscord just now, close this page/);
  const start = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: /** @type {NonNullable<typeof proxy>} */ (proxy).port,
        method: "POST",
        path: "/start",
        agent: false,
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res));
      },
    );
    req.on("error", reject);
    req.end(`t=${encodeURIComponent(ticket)}`);
  });
  const started = /** @type {http.IncomingMessage} */ (start);
  assert.equal(started.statusCode, 303);
  const cookie = /** @type {string[]} */ (started.headers["set-cookie"])[0].split(";")[0];

  const root = await get(proxy.port, "/", cookie);
  assert.equal(root.status, 302, "the gateway sends / to its SSO login page");
  const location = String(root.headers.location);
  assert.match(location, /^\/sso\/Login\?/, "relative redirect");

  const page = await get(proxy.port, location, cookie);
  if (page.status >= 500 || !/loginformWrapper|IBSSO/.test(page.body)) {
    t.skip(`IBKR's login servers did not answer from here (status ${page.status})`);
    return;
  }
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Login<\/title>/);
  for (const c of /** @type {string[]} */ (page.headers["set-cookie"] ?? [])) {
    assert.doesNotMatch(c, /Domain=/i, "cookies are host-only");
    assert.match(c, /Path=\//);
  }

  const bundleJs = await get(proxy.port, "/sso/lib/xyz.bundle.min.js", cookie);
  assert.equal(bundleJs.status, 200);
  assert.match(String(bundleJs.headers["content-type"]), /javascript/);
  const css = await get(proxy.port, "/css/am/login.min.css", cookie);
  assert.equal(css.status, 200);

  const status = await get(proxy.port, "/v1/api/iserver/auth/status", cookie);
  assert.equal(status.status, 401, "auth status reads unauthenticated through the login host");
  assert.equal((await get(proxy.port, "/v1/api/portfolio/accounts", cookie)).status, 403);
  assert.equal((await get(proxy.port, "/demo", cookie)).status, 403);

  // the service's own keepalive calls, straight to the gateway on loopback
  const gw = createGatewayHttp({ isSlotPort: m.isSlotPort });
  const direct = await gw.get(cid, port, "/iserver/auth/status");
  assert.equal(direct.status, 401);
  const tickle = await gw.post(cid, port, "/tickle", {});
  assert.notEqual(tickle.status, 411, "POSTs carry a Content-Length");

  await m.stop(cid);
  assert.equal(m.portFor(cid), null);
  assert.equal(await portIsFree(port), true, "the JVM is gone and the port is free");
});
