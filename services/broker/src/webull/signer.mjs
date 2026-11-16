import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Webull's request signature (developer.webull.com/apis/docs/authentication/signature), written by
 * hand because Webull ships no Node SDK.
 *
 * 1. Merge the query parameters with the signing headers (x-app-key, x-signature-algorithm,
 *    x-signature-version, x-signature-nonce, x-timestamp, host). Sort the names; a name that appears
 *    more than once gets its values sorted and joined with "&". Join as name=value with "&": str1.
 *    Values are signed as they are, not URL-encoded.
 * 2. With a body: str2 = upper-case hex digest of the exact body bytes (MD5 for HMAC-SHA1, SHA-256
 *    for HMAC-SHA256, as the official Python SDK does).
 * 3. str3 = path & str1 [& str2], URL-encoded like Python's quote(str3, safe=""): everything except
 *    letters, digits and "-._~" becomes %XX.
 * 4. signature = base64(HMAC(app_secret + "&", encoded str3)).
 *
 * The App Secret is only ever the HMAC key: it is never a header, a query value or part of a body
 * (Webull's generated reference lists an "x-app-secret" header; the Signature page and the SDK say
 * it is not sent, and Nasscord never sends it). x-signature and x-version are not signed.
 *
 * Nothing here logs. The signed string holds the client id and secret of a token request's body
 * only as their digest.
 */

export const WEBULL_SIGNATURE_VERSION = "1.0";
/** @typedef {"HMAC-SHA1" | "HMAC-SHA256"} WebullAlgorithm */
/** @type {ReadonlyArray<WebullAlgorithm>} */
export const WEBULL_ALGORITHMS = Object.freeze(["HMAC-SHA1", "HMAC-SHA256"]);

/** The headers that take part in the signature, besides the query parameters. */
export const SIGNED_HEADER_NAMES = Object.freeze(["x-app-key", "x-signature-algorithm", "x-signature-version", "x-signature-nonce", "x-timestamp", "host"]);

/**
 * Python's urllib.parse.quote(s, safe=""): UTF-8, and only A-Z a-z 0-9 - . _ ~ left as they are.
 * encodeURIComponent also leaves ! ' ( ) * alone, so those are encoded here too.
 * @param {string} s
 */
export function pyQuote(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Upper-case hex digest of a body, or null when there is no body.
 * @param {string | Buffer | null | undefined} body
 * @param {WebullAlgorithm} [algorithm]
 */
export function bodyDigest(body, algorithm = "HMAC-SHA1") {
  if (body === null || body === undefined || body.length === 0) return null;
  return createHash(algorithm === "HMAC-SHA256" ? "sha256" : "md5")
    .update(typeof body === "string" ? Buffer.from(body, "utf8") : body)
    .digest("hex")
    .toUpperCase();
}

/**
 * The encoded string to sign (step 1 to 3).
 * @param {{
 *   path: string,
 *   params: Array<[string, string]>,
 *   body?: string | Buffer | null,
 *   algorithm?: WebullAlgorithm,
 * }} p params: the query parameters and the signing headers, as name and value pairs
 */
export function stringToSign(p) {
  /** @type {Map<string, string[]>} */
  const byName = new Map();
  for (const [k, v] of p.params) {
    const list = byName.get(k) ?? [];
    list.push(String(v));
    byName.set(k, list);
  }
  const names = [...byName.keys()].sort(codeUnitOrder);
  const str1 = names
    .map((k) => {
      const values = /** @type {string[]} */ (byName.get(k));
      return `${k}=${values.length > 1 ? [...values].sort(codeUnitOrder).join("&") : values[0]}`;
    })
    .join("&");
  const str2 = bodyDigest(p.body, p.algorithm);
  // Without a path (Webull's gRPC subscriptions, not used here) the pairs are joined with "=".
  const str3 = p.path ? `${p.path}&${str1}${str2 ? `&${str2}` : ""}` : `${names.map((k) => `${k}=${byName.get(k)?.join("&")}`).join("=")}${str2 ? `&${str2}` : ""}`;
  return pyQuote(str3);
}

/** Plain string order (what Python's sorted() and Java's TreeMap do for ASCII names). @param {string} a @param {string} b */
function codeUnitOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * base64(HMAC(app_secret + "&", encoded)).
 * @param {string} appSecret
 * @param {string} encoded
 * @param {WebullAlgorithm} [algorithm]
 */
export function hmacSignature(appSecret, encoded, algorithm = "HMAC-SHA1") {
  return createHmac(algorithm === "HMAC-SHA256" ? "sha256" : "sha1", `${appSecret}&`)
    .update(encoded, "utf8")
    .digest("base64");
}

/**
 * Webull's x-timestamp: UTC, seconds, no milliseconds ("2022-01-04T03:55:31Z").
 * @param {number} ms
 */
export function webullTimestamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A fresh x-signature-nonce: 32 hex characters, never reused. */
export const newNonce = () => randomBytes(16).toString("hex");

/**
 * The signature of one request, from its parts (the published example's inputs).
 * @param {{
 *   appKey: string,
 *   appSecret: string,
 *   host: string,
 *   path: string,
 *   query?: Array<[string, string]>,
 *   body?: string | Buffer | null,
 *   timestamp: string,
 *   nonce: string,
 *   algorithm?: WebullAlgorithm,
 * }} p
 */
export function computeSignature(p) {
  const algorithm = p.algorithm ?? "HMAC-SHA1";
  /** @type {Array<[string, string]>} */
  const params = [
    ...(p.query ?? []),
    ["x-app-key", p.appKey],
    ["x-signature-algorithm", algorithm],
    ["x-signature-version", WEBULL_SIGNATURE_VERSION],
    ["x-signature-nonce", p.nonce],
    ["x-timestamp", p.timestamp],
    ["host", p.host],
  ];
  return hmacSignature(p.appSecret, stringToSign({ path: p.path, params, body: p.body, algorithm }), algorithm);
}

/**
 * The headers of one signed request to `url` (its path, query and host are signed; `body` must be
 * the exact bytes that are sent). The host header itself is left to fetch, which sends the URL's
 * host. Never returns the App Secret.
 * @param {{
 *   appKey: string,
 *   appSecret: string,
 *   url: string | URL,
 *   body?: string | Buffer | null,
 *   now: number,
 *   version: string,
 *   nonce?: string,
 *   algorithm?: WebullAlgorithm,
 * }} p version: x-version (the token endpoint takes "v2", the trading endpoints "v3")
 * @returns {Record<string, string>}
 */
export function signRequest(p) {
  if (!p.appKey || !p.appSecret) throw new Error("webull: request signing needs WEBULL_APP_KEY and WEBULL_APP_SECRET");
  const u = typeof p.url === "string" ? new URL(p.url) : p.url;
  const algorithm = p.algorithm ?? "HMAC-SHA1";
  const timestamp = webullTimestamp(p.now);
  const nonce = p.nonce ?? newNonce();
  const signature = computeSignature({
    appKey: p.appKey,
    appSecret: p.appSecret,
    host: u.host,
    path: u.pathname,
    query: [...u.searchParams.entries()],
    body: p.body ?? null,
    timestamp,
    nonce,
    algorithm,
  });
  return {
    "x-app-key": p.appKey,
    "x-timestamp": timestamp,
    "x-signature-algorithm": algorithm,
    "x-signature-version": WEBULL_SIGNATURE_VERSION,
    "x-signature-nonce": nonce,
    "x-version": p.version,
    "x-signature": signature,
  };
}
