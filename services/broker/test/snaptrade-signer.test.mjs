import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, snaptradeSignature, sortedCopy, verifyWebhookSignature } from "../src/snaptrade/signer.mjs";

/**
 * SnapTrade's signatures. The expected values were computed with SnapTrade's own Python example
 * (json.dumps(sort_keys=True, separators=(",", ":")), HMAC-SHA256 with the consumer key as UTF-8,
 * base64), so these vectors check this JavaScript against the documented recipe, not against itself.
 */

const KEY = "YOUR_CONSUMER_KEY_e7Q2";

test("canonical JSON: keys sorted at every level, no whitespace, null content", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: true, x: null }], c: "s" } }), '{"a":{"c":"s","d":[3,{"x":null,"y":true}]},"b":1}');
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson({ u: undefined, f: () => 1, n: Number.NaN, list: [undefined] }), '{"list":[null],"n":null}', "as JSON.stringify would");
  assert.equal(canonicalJson({ name: "Café" }), '{"name":"Café"}', "UTF-8 as is (requests)");
  assert.equal(canonicalJson({ name: "Café" }, { ascii: true }), '{"name":"Caf\\u00e9"}', "Python's ensure_ascii form (webhooks)");
  assert.equal(JSON.stringify(sortedCopy({ b: 1, a: { d: 2, c: 1 } })), '{"a":{"c":1,"d":2},"b":1}', "the body sent is the content signed");
});

test("request signature: a GET without a body matches SnapTrade's Python recipe", () => {
  const sig = snaptradeSignature(KEY, {
    path: "/api/v1/accounts",
    query: "clientId=NASSCORD-TEST&timestamp=1715123456&userId=0b6a3c1e-5f2d-4a8e-9c1b-2d3e4f5a6b7c&userSecret=s3cr3t-0001",
    content: null,
  });
  assert.equal(sig, "q/wocj+wYNW/Thj9Y6f+P9SiWztc4PD7EqUaoZULq+A=");
  // A leading "?" is not part of the signed query.
  assert.equal(
    snaptradeSignature(KEY, { path: "/api/v1/accounts", query: "?clientId=NASSCORD-TEST&timestamp=1715123456&userId=0b6a3c1e-5f2d-4a8e-9c1b-2d3e4f5a6b7c&userSecret=s3cr3t-0001", content: null }),
    sig,
  );
});

test("request signature: a POST body is signed with its keys sorted, wherever they were", () => {
  const sig = snaptradeSignature(KEY, {
    path: "/api/v1/snapTrade/registerUser",
    query: "clientId=NASSCORD-TEST&timestamp=1715123456",
    content: { userId: "w-1", nested: { b: 2, a: [1, { z: null, y: true }] } },
  });
  assert.equal(sig, "/UH/CC8pvDkdhf83U8vGhcL3z6KLLi7NZ1PeB7OJD48=");
});

test("request signature: the path, the query, the content and the key all count", () => {
  const base = { path: "/api/v1/accounts", query: "clientId=A&timestamp=1", content: null };
  const sig = snaptradeSignature(KEY, base);
  assert.notEqual(snaptradeSignature(KEY, { ...base, path: "/accounts" }), sig, "the /api/v1 prefix is part of the path signed");
  assert.notEqual(snaptradeSignature(KEY, { ...base, query: "clientId=A&timestamp=2" }), sig);
  assert.notEqual(snaptradeSignature(KEY, { ...base, content: {} }), sig, "an empty body is not null");
  assert.notEqual(snaptradeSignature(`${KEY}x`, base), sig);
  assert.throws(() => snaptradeSignature(KEY, { ...base, path: "/api/v1/accounts?x=1" }), /without its query/);
  assert.throws(() => snaptradeSignature("", base), /consumer key/);
});

test("webhook: SnapTrade's own signature (canonical JSON, non-ASCII escaped) is accepted", () => {
  const payload = {
    webhookId: "wh-1",
    clientId: "NASSCORD-TEST",
    eventTimestamp: "2026-11-16T14:00:00.000000Z",
    userId: "u-1",
    eventType: "ACCOUNT_HOLDINGS_UPDATED",
    brokerageAuthorizationId: "a-1",
    accountId: "acc-1",
    details: { name: "Café" },
  };
  const signature = "75r+0Y6x5CydM5oDQgZpjIR4S+/YmYtL95tvph28gjI=";
  // Sent pretty-printed and in another key order: what counts is the canonical form.
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const body = Buffer.from(JSON.stringify(reordered, null, 2));
  const out = verifyWebhookSignature(KEY, body, signature);
  assert.deepEqual(out, payload);
});

test("webhook: a signature of the raw body is accepted too; anything else is refused", () => {
  const raw = '{"eventType":"TRADE_DETECTION","userId":"u-2"}';
  const rawSig = createHmac("sha256", KEY).update(raw).digest("base64");
  assert.deepEqual(verifyWebhookSignature(KEY, Buffer.from(raw), rawSig), { eventType: "TRADE_DETECTION", userId: "u-2" });
  assert.equal(verifyWebhookSignature(`${KEY}x`, Buffer.from(raw), rawSig), null, "another key");
  assert.equal(verifyWebhookSignature(KEY, Buffer.from(raw.replace("u-2", "u-3")), rawSig), null, "a changed body");
  assert.equal(verifyWebhookSignature(KEY, Buffer.from(raw), ""), null, "no signature");
  assert.equal(verifyWebhookSignature(KEY, Buffer.from(raw), undefined), null);
  assert.equal(verifyWebhookSignature(KEY, Buffer.from(raw), "not base64 at all"), null);
  assert.equal(verifyWebhookSignature(KEY, Buffer.from("[1,2]"), createHmac("sha256", KEY).update("[1,2]").digest("base64")), null, "not an object");
  assert.equal(verifyWebhookSignature(KEY, Buffer.from("{oops"), rawSig), null, "not JSON");
  assert.equal(verifyWebhookSignature("", Buffer.from(raw), rawSig), null, "no key: nothing verifies");
});
