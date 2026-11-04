import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSecretBox, SecretError } from "../src/secrets.mjs";

const key = randomBytes(32);
const box = createSecretBox({ key, keyVersion: 1 });
const value = { consumerKey: "ck-123", consumerSecret: "cs-456", accessToken: "a+b/c=", accessSecret: "s" };

/** @param {string} b64 */
const flip = (b64) => {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0x01;
  return buf.toString("base64");
};

test("round trip with a fresh 12-byte IV and a 16-byte tag", () => {
  const id = randomUUID();
  const a = box.encrypt(id, value);
  const b = box.encrypt(id, value);
  assert.equal(a.key_version, 1);
  assert.equal(Buffer.from(a.iv, "base64").length, 12);
  assert.equal(Buffer.from(a.tag, "base64").length, 16);
  assert.notEqual(a.iv, b.iv, "IV must be random per write");
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.deepEqual(box.decrypt(id, a), value);
  assert.ok(!a.ciphertext.includes("ck-123") && !Buffer.from(a.ciphertext, "base64").toString().includes("ck-123"));
});

test("tampering with ciphertext, tag or IV is detected", () => {
  const id = randomUUID();
  const sealed = box.encrypt(id, value);
  for (const field of /** @type {const} */ (["ciphertext", "tag", "iv"])) {
    assert.throws(() => box.decrypt(id, { ...sealed, [field]: flip(sealed[field]) }), SecretError, field);
  }
  assert.throws(() => box.decrypt(id, { ...sealed, tag: Buffer.from(sealed.tag, "base64").subarray(0, 8).toString("base64") }), SecretError);
});

test("the connection id is the AAD: a row moved to another connection does not decrypt", () => {
  const sealed = box.encrypt(randomUUID(), value);
  assert.throws(() => box.decrypt(randomUUID(), sealed), SecretError);
});

test("a different key does not decrypt", () => {
  const id = randomUUID();
  const sealed = box.encrypt(id, value);
  const other = createSecretBox({ key: randomBytes(32), keyVersion: 1 });
  assert.throws(() => other.decrypt(id, sealed), SecretError);
});

test("key rotation: old rows decrypt with the previous key and are flagged for re-sealing", () => {
  const id = randomUUID();
  const oldKey = randomBytes(32);
  const sealedOld = createSecretBox({ key: oldKey, keyVersion: 1 }).encrypt(id, value);
  const rotated = createSecretBox({ key: randomBytes(32), keyVersion: 2, previousKeys: new Map([[1, oldKey]]) });
  assert.deepEqual(rotated.decrypt(id, sealedOld), value);
  assert.equal(rotated.needsRotation(sealedOld), true);
  const resealed = rotated.encrypt(id, value);
  assert.equal(resealed.key_version, 2);
  assert.equal(rotated.needsRotation(resealed), false);
  assert.throws(() => rotated.decrypt(id, { ...resealed, key_version: 3 }), /no key for key_version 3/);
});

test("refuses keys that are not 32 bytes", () => {
  assert.throws(() => createSecretBox({ key: randomBytes(16), keyVersion: 1 }), SecretError);
});
