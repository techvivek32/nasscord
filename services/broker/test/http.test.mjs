import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BrokerAuthError, HttpError, ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed, retryAfterMs } from "../src/http.mjs";
import { createLimiter } from "../src/limits.mjs";
import { listen } from "./helpers/common.mjs";

/** @type {Array<{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders, body: string }>} */
const seen = [];
/** @type {Awaited<ReturnType<typeof listen>>} */
let broker;

before(async () => {
  broker = await listen((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() });
      const path = new URL(req.url ?? "/", "http://x").pathname;
      /** @param {number} s @param {string} body @param {Record<string, string>} [h] */
      const send = (s, body, h = {}) => {
        res.writeHead(s, { "content-type": "application/json", ...h });
        res.end(body);
      };
      if (path === "/v2/account") return send(200, JSON.stringify({ id: "acct-1" }));
      if (path === "/v2/positions") return send(200, "");
      if (path === "/slow") return setTimeout(() => send(200, "{}"), 300);
      if (path === "/limited") return send(429, "{}", { "retry-after": "7" });
      if (path === "/quota") return send(400, "Quota Violation", { "content-type": "text/plain" });
      if (path === "/denied") return send(401, JSON.stringify({ message: "bad key" }));
      if (path === "/missing") return send(404, "{}");
      if (path === "/down") return send(503, "{}");
      if (path === "/html") return send(200, "<html>oops</html>", { "content-type": "text/html" });
      if (path === "/oauth/token") return send(400, JSON.stringify({ error: "invalid_grant" }));
      send(404, "{}");
    });
  });
});
after(() => broker?.close());

/** @param {Partial<import("../src/http.mjs").BrokerHttpOptions>} [o] */
const client = (o = {}) =>
  createBrokerHttp({
    name: "Alpaca",
    base: broker.url,
    allow: [
      ["GET", /^\/v2\/account$/],
      ["GET", /^\/v2\/positions$/],
      ["GET", /^\/(slow|limited|quota|denied|missing|down|html)$/],
      ["POST", /^\/oauth\/token$/],
    ],
    timeoutMs: 2_000,
    ...o,
  });

test("the allowlist: anything off it throws before the network", async () => {
  const http = client();
  const before = seen.length;
  for (const [method, path] of [
    ["POST", "/v2/orders"],
    ["DELETE", "/v2/positions"],
    ["POST", "/v2/account"],
    ["GET", "/v2/orders"],
    ["GET", "/v2/account/../orders"],
    ["GET", "/v2/account/%2e%2e/orders"],
    ["GET", "/v2//account"],
    ["GET", "/v2/account?x=1"],
    ["GET", "/v2/account#frag"],
    ["GET", "v2/account"],
    ["GET", "/v2/accountx"],
    ["PATCH", "/v2/account"],
  ]) {
    await assert.rejects(http.request(method, path), ReadOnlyViolation, `${method} ${path}`);
  }
  assert.equal(seen.length, before, "no request reached the broker");

  // A rule must cover the whole path, anchored or not.
  const loose = /** @type {[string, RegExp][]} */ ([["GET", /\/v2\/account/]]);
  assert.equal(isAllowed(loose, "GET", "/v2/account"), true);
  assert.equal(isAllowed(loose, "GET", "/v2/account/orders"), false);
  assert.equal(isAllowed(loose, "GET", "/x/v2/account"), false);
  assert.equal(http.allows("POST", "/oauth/token"), true);
});

test("reads: query, headers, JSON, empty bodies", async () => {
  const http = client({ headers: async () => ({ "apca-api-key-id": "KEYID" }) });
  seen.length = 0;
  assert.deepEqual(await http.get("/v2/account", { status: "all", symbols: ["AAPL", "MSFT"], skip: undefined }), { id: "acct-1" });
  assert.equal(seen[0].url, "/v2/account?status=all&symbols=AAPL%2CMSFT");
  assert.equal(seen[0].headers["apca-api-key-id"], "KEYID");
  assert.equal(seen[0].headers.accept, "application/json");
  assert.equal(await http.get("/v2/positions"), null);
  const raw = await http.request("POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: "r-token" }, raw: true });
  assert.equal(raw.status, 400);
  assert.deepEqual(raw.json, { error: "invalid_grant" });
  assert.equal(seen.at(-1)?.body, "grant_type=refresh_token&refresh_token=r-token");
  assert.equal(seen.at(-1)?.headers["content-type"], "application/x-www-form-urlencoded");
});

test("errors: 429 and Quota Violation pause the bucket; 401 is BrokerAuthError; the rest are 502", async () => {
  const limiter = createLimiter({ maxWaitMs: 50 });
  const http = client({ limiter, bucket: { key: "alpaca:conn-1", ratePerSec: 10 } });
  await assert.rejects(http.get("/limited"), (e) => e instanceof HttpError && e.status === 429 && e.retryAfterSec === 7);
  await assert.rejects(http.get("/v2/account"), (e) => e instanceof HttpError && e.status === 429, "the bucket waits for Retry-After");

  const t = client({ limiter: createLimiter({ maxWaitMs: 50 }), bucket: { key: "tradier:tok", ratePerSec: 2 } });
  await assert.rejects(t.get("/quota"), (e) => e instanceof HttpError && e.status === 429 && /limiting requests/.test(e.message));

  const h = client();
  await assert.rejects(h.get("/denied"), (e) => e instanceof BrokerAuthError && e.brokerStatus === 401 && e.status === 409);
  await assert.rejects(h.get("/missing"), (e) => e instanceof HttpError && e.status === 502 && e.code === "broker_http");
  await assert.rejects(h.get("/down"), (e) => e instanceof HttpError && e.status === 502 && /Alpaca is not answering/.test(e.message));
  await assert.rejects(h.get("/html"), (e) => e instanceof HttpError && e.code === "broker_reply");
  await assert.rejects(client({ timeoutMs: 50 }).get("/slow"), (e) => e instanceof HttpError && e.code === "broker_timeout");
  const dead = createBrokerHttp({ name: "Alpaca", base: "http://127.0.0.1:1", allow: [["GET", /^\/v2\/account$/]] });
  await assert.rejects(dead.get("/v2/account"), (e) => e instanceof HttpError && e.code === "broker_unreachable");
});

test("no secret in an error: the query, headers and body never reach a message", async () => {
  const http = client({ headers: () => ({ authorization: "Bearer sk-live-SECRET" }) });
  for (const path of ["/denied", "/missing", "/down", "/html", "/limited"]) {
    try {
      await http.get(path, { token: "QUERY-SECRET" });
      assert.fail("should throw");
    } catch (e) {
      const text = `${/** @type {Error} */ (e).message} ${JSON.stringify(e)}`;
      assert.ok(!text.includes("QUERY-SECRET") && !text.includes("sk-live-SECRET") && !text.includes(broker.url), path);
    }
  }
});

test("Retry-After as seconds or a date, X-Ratelimit-Reset as epoch seconds", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after": "3" }), now), 3000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Mon, 16 Nov 2026 12:00:10 GMT" }), now), 10_000);
  assert.equal(retryAfterMs(new Headers({ "x-ratelimit-reset": String(now / 1000 + 20) }), now), 20_000);
  assert.equal(retryAfterMs(new Headers({}), now), 0);
  assert.throws(() => createBrokerHttp({ name: "X", base: "ftp://x", allow: [["GET", /^\/$/]] }), /not an http/);
  assert.throws(() => createBrokerHttp({ name: "X", base: "https://x", allow: [] }), /allowlist is required/);
});
