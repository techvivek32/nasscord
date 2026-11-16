import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * SnapTrade request and webhook signatures (docs.snaptrade.com/docs/request-signatures,
 * docs.snaptrade.com/docs/webhooks).
 *
 * Requests: every call carries `clientId` and a Unix `timestamp` in the query (plus `userId` and
 * `userSecret` on user calls) and a `Signature` header:
 *   base64(HMAC-SHA256(consumerKey as UTF-8, canonical JSON of { content, path, query }))
 * - content: the JSON body, or null for a call without one (GET, DELETE);
 * - path: the request path without the query string, in the form the URL uses (with the /api/v1
 *   prefix when the base has it);
 * - query: the raw query string exactly as sent, without the leading "?";
 * - canonical JSON: object keys sorted at every level, no whitespace, UTF-8.
 * Webhooks: the `Signature` header is base64(HMAC-SHA256(consumerKey, canonical JSON of the
 * payload)). SnapTrade's own example builds that with Python's json.dumps(sort_keys=True), which
 * escapes non-ASCII characters, so the check accepts that form, the JavaScript form and the raw body.
 *
 * Nothing here logs; the consumer key never leaves this module except as the HMAC key.
 */

/**
 * Canonical JSON: keys sorted (by UTF-16 code unit, as Array#sort and Python's sort_keys do for
 * these keys), no whitespace. Values JSON cannot hold behave as in JSON.stringify: undefined and
 * functions are left out of objects and become null in arrays; non-finite numbers become null.
 * `ascii` escapes every character outside printable ASCII as \uXXXX, like Python's json.dumps.
 * @param {unknown} value
 * @param {{ ascii?: boolean }} [opts]
 * @returns {string}
 */
export function canonicalJson(value, opts = {}) {
  const text = write(value);
  return opts.ascii ? text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) : text;
}

/** @param {unknown} v @returns {string} */
function write(v) {
  if (v === null) return "null";
  if (typeof v === "object" && typeof (/** @type {any} */ (v).toJSON) === "function") return write(/** @type {any} */ (v).toJSON());
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "number":
      return Number.isFinite(v) ? JSON.stringify(v) : "null";
    case "boolean":
      return v ? "true" : "false";
    case "bigint":
      throw new TypeError("canonicalJson: a bigint has no JSON form");
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === "function" || typeof x === "symbol" ? "null" : write(x))).join(",")}]`;
      const o = /** @type {Record<string, unknown>} */ (v);
      const parts = [];
      for (const k of Object.keys(o).sort()) {
        const x = o[k];
        if (x === undefined || typeof x === "function" || typeof x === "symbol") continue;
        parts.push(`${JSON.stringify(k)}:${write(x)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return "null";
  }
}

/**
 * A copy of a JSON value with object keys in sorted order, so the body sent is byte for byte the
 * `content` that was signed.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function sortedCopy(value) {
  return JSON.parse(canonicalJson(value));
}

/** @param {string} key @param {string} text */
const hmac = (key, text) => createHmac("sha256", Buffer.from(key, "utf8")).update(text, "utf8").digest();

/**
 * The Signature header of one request.
 * @param {string} consumerKey
 * @param {{ path: string, query: string, content: unknown }} req
 */
export function snaptradeSignature(consumerKey, req) {
  if (typeof consumerKey !== "string" || !consumerKey) throw new Error("snaptrade: the consumer key is missing");
  if (typeof req.path !== "string" || !req.path.startsWith("/") || req.path.includes("?")) throw new Error("snaptrade: sign the path without its query string");
  const query = String(req.query ?? "").replace(/^\?/, "");
  return hmac(consumerKey, canonicalJson({ content: req.content === undefined ? null : req.content, path: req.path, query })).toString("base64");
}

/**
 * Constant-time comparison of two base64 signatures.
 * @param {Buffer} expected the HMAC digest
 * @param {string} given the header value
 */
function sameDigest(expected, given) {
  const got = Buffer.from(String(given).trim(), "base64");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Checks a webhook's Signature header against the raw body and its canonical forms. Answers the
 * parsed payload when the signature matches, null otherwise (also for a body that is not a JSON
 * object, or a missing header).
 * @param {string} consumerKey
 * @param {Buffer | string} rawBody
 * @param {string | null | undefined} signature
 * @returns {Record<string, unknown> | null}
 */
export function verifyWebhookSignature(consumerKey, rawBody, signature) {
  if (!consumerKey || typeof signature !== "string" || !signature.trim()) return null;
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidates = new Set([canonicalJson(payload, { ascii: true }), canonicalJson(payload), raw]);
  let ok = false;
  // Every candidate is compared (no early exit), so the time taken says nothing about which form matched.
  for (const text of candidates) if (sameDigest(hmac(consumerKey, text), signature)) ok = true;
  return ok ? /** @type {Record<string, unknown>} */ (payload) : null;
}
