import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { bodyDigest, computeSignature, newNonce, pyQuote, signRequest, stringToSign, webullTimestamp } from "../src/webull/signer.mjs";

/**
 * Webull's request signature against the worked example published on
 * developer.webull.com/apis/docs/authentication/signature (expected kvlS6opdZDhEBo5jq40nHYXaLvM=).
 */

const EXAMPLE = Object.freeze({
  appKey: "776da210ab4a452795d74e726ebd74b6",
  appSecret: "0f50a2e853334a9aae1a783bee120c1f",
  host: "api.webull.com",
  path: "/trade/place_order",
  query: /** @type {Array<[string, string]>} */ ([
    ["a1", "webull"],
    ["a2", "123"],
    ["a3", "xxx"],
    ["q1", "yyy"],
  ]),
  body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
  timestamp: "2022-01-04T03:55:31Z",
  nonce: "48ef5afed43d4d91ae514aaeafbc29ba",
});

test("the published example: body MD5, the encoded string and the signature", () => {
  assert.equal(bodyDigest(EXAMPLE.body), "E296C96787E1A309691CEF3692F5EEDD");
  const encoded = stringToSign({
    path: EXAMPLE.path,
    params: [
      ...EXAMPLE.query,
      ["x-app-key", EXAMPLE.appKey],
      ["x-signature-algorithm", "HMAC-SHA1"],
      ["x-signature-version", "1.0"],
      ["x-signature-nonce", EXAMPLE.nonce],
      ["x-timestamp", EXAMPLE.timestamp],
      ["host", EXAMPLE.host],
    ],
    body: EXAMPLE.body,
  });
  assert.equal(
    encoded,
    "%2Ftrade%2Fplace_order%26a1%3Dwebull%26a2%3D123%26a3%3Dxxx%26host%3Dapi.webull.com%26q1%3Dyyy%26x-app-key%3D776da210ab4a452795d74e726ebd74b6%26x-signature-algorithm%3DHMAC-SHA1%26x-signature-nonce%3D48ef5afed43d4d91ae514aaeafbc29ba%26x-signature-version%3D1.0%26x-timestamp%3D2022-01-04T03%3A55%3A31Z%26E296C96787E1A309691CEF3692F5EEDD",
  );
  assert.equal(computeSignature(EXAMPLE), "kvlS6opdZDhEBo5jq40nHYXaLvM=");
});

test("the query order does not matter; a changed byte of the body, path or host does", () => {
  const reversed = { ...EXAMPLE, query: [...EXAMPLE.query].reverse() };
  assert.equal(computeSignature(reversed), "kvlS6opdZDhEBo5jq40nHYXaLvM=");
  assert.notEqual(computeSignature({ ...EXAMPLE, body: EXAMPLE.body.replace("123", "124") }), "kvlS6opdZDhEBo5jq40nHYXaLvM=");
  assert.notEqual(computeSignature({ ...EXAMPLE, body: EXAMPLE.body.replace(":", ": ") }), "kvlS6opdZDhEBo5jq40nHYXaLvM=", "whitespace changes the MD5");
  assert.notEqual(computeSignature({ ...EXAMPLE, path: "/trade/cancel_order" }), "kvlS6opdZDhEBo5jq40nHYXaLvM=");
  assert.notEqual(computeSignature({ ...EXAMPLE, host: "api.sandbox.webull.com" }), "kvlS6opdZDhEBo5jq40nHYXaLvM=");
});

test("no body: no digest and no trailing separator; a repeated name joins its sorted values with &", () => {
  const encoded = stringToSign({ path: "/trading/accounts/list", params: [["b", "2"], ["a", "z"], ["a", "y"]] });
  assert.equal(decodeURIComponent(encoded), "/trading/accounts/list&a=y&z&b=2");
  assert.equal(bodyDigest(""), null);
  assert.equal(bodyDigest(null), null);
});

test("URL encoding is Python's quote(safe=''): only letters, digits and -._~ stay", () => {
  assert.equal(pyQuote("a-b_c.d~e"), "a-b_c.d~e");
  assert.equal(pyQuote("/x?y=1&z=2"), "%2Fx%3Fy%3D1%26z%3D2");
  assert.equal(pyQuote("!'()* "), "%21%27%28%29%2A%20");
  assert.equal(pyQuote("é"), "%C3%A9");
});

test("HMAC-SHA256 (the official SDK's choice): SHA-256 body digest and key", () => {
  const sig = computeSignature({ ...EXAMPLE, algorithm: "HMAC-SHA256" });
  const digest = createHash("sha256").update(EXAMPLE.body).digest("hex").toUpperCase();
  const str3 = `${EXAMPLE.path}&a1=webull&a2=123&a3=xxx&host=api.webull.com&q1=yyy&x-app-key=${EXAMPLE.appKey}&x-signature-algorithm=HMAC-SHA256&x-signature-nonce=${EXAMPLE.nonce}&x-signature-version=1.0&x-timestamp=${EXAMPLE.timestamp}&${digest}`;
  const want = createHmac("sha256", `${EXAMPLE.appSecret}&`).update(encodeURIComponent(str3)).digest("base64");
  assert.equal(sig, want);
});

test("signRequest: the headers Webull wants, the URL's host, path and query signed, and never the secret", () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0, 789);
  const body = "client_id=abc&client_secret=def&grant_type=refresh_token&refresh_token=r%2Bt";
  const headers = signRequest({ appKey: EXAMPLE.appKey, appSecret: EXAMPLE.appSecret, url: "http://127.0.0.1:9300/oauth2/tokens/create?x=1", body, now, version: "v2", nonce: "n1" });
  assert.deepEqual(Object.keys(headers).sort(), ["x-app-key", "x-signature", "x-signature-algorithm", "x-signature-nonce", "x-signature-version", "x-timestamp", "x-version"]);
  assert.equal(headers["x-timestamp"], "2026-11-16T12:00:00Z", "UTC, seconds, no milliseconds");
  assert.equal(headers["x-signature-algorithm"], "HMAC-SHA1");
  assert.equal(headers["x-signature-version"], "1.0");
  assert.equal(headers["x-version"], "v2");
  assert.equal(
    headers["x-signature"],
    computeSignature({ appKey: EXAMPLE.appKey, appSecret: EXAMPLE.appSecret, host: "127.0.0.1:9300", path: "/oauth2/tokens/create", query: [["x", "1"]], body, timestamp: "2026-11-16T12:00:00Z", nonce: "n1" }),
  );
  const all = JSON.stringify(headers);
  assert.ok(!all.includes(EXAMPLE.appSecret), "the app secret is the HMAC key only");
  assert.ok(!Object.keys(headers).some((k) => k.toLowerCase() === "x-app-secret"));
  assert.throws(() => signRequest({ appKey: "", appSecret: "s", url: "https://x.test/a", now, version: "v2" }), /WEBULL_APP_KEY and WEBULL_APP_SECRET/);
});

test("nonces are fresh and timestamps have no milliseconds", () => {
  const a = newNonce();
  const b = newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(webullTimestamp(Date.UTC(2022, 0, 4, 3, 55, 31, 999)), "2022-01-04T03:55:31Z");
});
