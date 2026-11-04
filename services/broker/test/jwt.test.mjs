import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { bearerToken, JwtError, signServiceJwt, verifyServiceJwt } from "../src/jwt.mjs";

const SECRET = "x".repeat(40);
const NOW = 1_793_700_000_000; // 2026-11-03
const nowSec = Math.floor(NOW / 1000);
const opts = { now: () => NOW };

/** @param {Record<string, unknown>} [over] */
function claims(over = {}) {
  return {
    iss: "nasscord-app",
    aud: "nasscord-broker",
    sub: randomUUID(),
    wid: randomUUID(),
    role: "trader",
    iat: nowSec,
    exp: nowSec + 60,
    ...over,
  };
}

/** @param {() => unknown} fn @param {string} reason */
function rejects(fn, reason) {
  assert.throws(fn, (e) => e instanceof JwtError && e.reason === reason, `expected "${reason}"`);
}

test("accepts a valid token and returns normalised claims", () => {
  const c = claims({ sub: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" });
  const out = verifyServiceJwt(signServiceJwt(c, SECRET), SECRET, opts);
  assert.equal(out.sub, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(out.role, "trader");
  assert.equal(out.wid, c.wid);
});

test("accepts wid null and an audience list containing the service", () => {
  const out = verifyServiceJwt(signServiceJwt(claims({ wid: null, aud: ["x", "nasscord-broker"], role: "superadmin" }), SECRET), SECRET, opts);
  assert.equal(out.wid, null);
});

test("accepts a token issued up to 120 s in the future (clock skew)", () => {
  verifyServiceJwt(signServiceJwt(claims({ iat: nowSec + 119, exp: nowSec + 179 }), SECRET), SECRET, opts);
});

test("rejects expired tokens, including exactly at exp", () => {
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ iat: nowSec - 61, exp: nowSec - 1 }), SECRET), SECRET, opts), "expired");
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ iat: nowSec - 60, exp: nowSec }), SECRET), SECRET, opts), "expired");
});

test("rejects a token issued more than 120 s in the future", () => {
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ iat: nowSec + 121, exp: nowSec + 181 }), SECRET), SECRET, opts), "issued in the future");
});

test("rejects wrong audience and wrong issuer", () => {
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ aud: "someone-else" }), SECRET), SECRET, opts), "wrong audience");
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ iss: "evil" }), SECRET), SECRET, opts), "wrong issuer");
});

test("rejects a bad signature, a wrong secret and a tampered payload", () => {
  const t = signServiceJwt(claims(), SECRET);
  rejects(() => verifyServiceJwt(t, "y".repeat(40), opts), "bad signature");
  const [h, , s] = t.split(".");
  const forged = Buffer.from(JSON.stringify(claims({ role: "superadmin" }))).toString("base64url");
  rejects(() => verifyServiceJwt(`${h}.${forged}.${s}`, SECRET, opts), "bad signature");
  rejects(() => verifyServiceJwt(`${h}.${t.split(".")[1]}.${s.slice(0, -2)}`, SECRET, opts), "bad signature");
});

test("rejects alg none and any algorithm other than HS256", () => {
  const body = Buffer.from(JSON.stringify(claims())).toString("base64url");
  const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  rejects(() => verifyServiceJwt(`${none}.${body}.x`, SECRET, opts), "algorithm must be HS256");
  const hs512 = Buffer.from(JSON.stringify({ alg: "HS512", typ: "JWT" })).toString("base64url");
  const sig = createHmac("sha512", SECRET).update(`${hs512}.${body}`).digest("base64url");
  rejects(() => verifyServiceJwt(`${hs512}.${body}.${sig}`, SECRET, opts), "algorithm must be HS256");
});

test("rejects malformed tokens", () => {
  rejects(() => verifyServiceJwt("", SECRET, opts), "malformed");
  rejects(() => verifyServiceJwt("a.b", SECRET, opts), "malformed");
  rejects(() => verifyServiceJwt("a.b.c.d", SECRET, opts), "malformed");
  rejects(() => verifyServiceJwt("a+b.c.d", SECRET, opts), "malformed");
  rejects(() => verifyServiceJwt(42, SECRET, opts), "malformed");
});

test("rejects bad claim shapes and over-long lifetimes", () => {
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ sub: "not-a-uuid" }), SECRET), SECRET, opts), "sub must be a user id");
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ wid: "nope" }), SECRET), SECRET, opts), "wid must be a workspace id or null");
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ role: "admin" }), SECRET), SECRET, opts), "unknown role");
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ exp: undefined }), SECRET), SECRET, opts), "iat and exp are required");
  rejects(() => verifyServiceJwt(signServiceJwt(claims({ exp: nowSec + 3600 }), SECRET), SECRET, opts), "lifetime too long");
});

test("bearerToken reads only a Bearer header", () => {
  assert.equal(bearerToken("Bearer a.b.c"), "a.b.c");
  assert.equal(bearerToken("bearer a.b.c "), "a.b.c");
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(undefined), null);
});
