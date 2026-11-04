import { createHmac, randomBytes } from "node:crypto";

/**
 * OAuth 1.0a request signing, HMAC-SHA1 (RFC 5849 section 3.4).
 * Pure functions plus a signer with an injectable clock and nonce, so the known-answer vectors in
 * test/oauth1.test.mjs can pin every step.
 */

/**
 * RFC 5849 section 3.6 / RFC 3986: everything except ALPHA, DIGIT, "-", ".", "_", "~" is
 * percent-encoded as UTF-8 with upper-case hex.
 * @param {string | number | boolean} value
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Decodes one application/x-www-form-urlencoded component ("+" is a space).
 * @param {string} s
 */
function formDecode(s) {
  return decodeURIComponent(s.replace(/\+/g, " "));
}

/**
 * Splits a query string or a form body into decoded [name, value] pairs, keeping duplicates
 * and empty values (RFC 5849 section 3.4.1.3.1).
 * @param {string} text without the leading "?"
 * @returns {Array<[string, string]>}
 */
export function parseForm(text) {
  if (!text) return [];
  return text
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const i = part.indexOf("=");
      return /** @type {[string, string]} */ (i === -1 ? [formDecode(part), ""] : [formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))]);
    });
}

/**
 * Base string URI (RFC 5849 section 3.4.1.2): lower-case scheme and host, default port dropped,
 * path kept, query and fragment removed.
 * @param {string} url
 */
export function baseStringUri(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

/**
 * Parameter normalisation (RFC 5849 section 3.4.1.3.2): encode names and values, sort by name
 * then value (byte order), join name=value with "&".
 * @param {Array<[string, string]>} pairs
 */
export function normalizeParameters(pairs) {
  return pairs
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Signature base string (RFC 5849 section 3.4.1.1).
 * @param {string} method
 * @param {string} url may carry a query; its parameters are included
 * @param {Array<[string, string]>} params oauth_* (without oauth_signature and realm) and body params
 */
export function signatureBaseString(method, url, params) {
  const query = new URL(url).search.replace(/^\?/, "");
  const all = [...parseForm(query), ...params];
  return [method.toUpperCase(), percentEncode(baseStringUri(url)), percentEncode(normalizeParameters(all))].join("&");
}

/**
 * HMAC-SHA1 key (RFC 5849 section 3.4.2): encoded consumer secret "&" encoded token secret.
 * @param {string} consumerSecret
 * @param {string} [tokenSecret]
 */
export function signingKey(consumerSecret, tokenSecret = "") {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret ?? "")}`;
}

/**
 * @param {string} baseString
 * @param {string} key
 */
export function hmacSha1(baseString, key) {
  return createHmac("sha1", key).update(baseString).digest("base64");
}

/**
 * The Authorization header (RFC 5849 section 3.5.1). `realm` is outside the signature.
 * @param {Record<string, string>} oauthParams including oauth_signature
 * @param {string | null} [realm] null leaves it out
 */
export function authorizationHeader(oauthParams, realm = null) {
  const parts = Object.entries(oauthParams).map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`);
  if (realm !== null) parts.unshift(`realm="${String(realm).replace(/"/g, "")}"`);
  return `OAuth ${parts.join(",")}`;
}

/**
 * Parses an OAuth Authorization header back into its parameters (used by the fake E*TRADE server
 * in the tests to verify what the client sent).
 * @param {string} header
 */
export function parseAuthorizationHeader(header) {
  if (!/^OAuth\s+/i.test(header)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of header.replace(/^OAuth\s+/i, "").matchAll(/([A-Za-z0-9_.~%-]+)="([^"]*)"/g)) {
    out[decodeURIComponent(m[1])] = decodeURIComponent(m[2]);
  }
  return out;
}

/**
 * @typedef {{
 *   method: string,
 *   url: string,
 *   consumerKey: string,
 *   consumerSecret: string,
 *   token?: string,
 *   tokenSecret?: string,
 *   extra?: Record<string, string>,
 *   bodyParams?: Array<[string, string]>,
 * }} SignInput
 */

/**
 * @param {{ now?: () => number, nonce?: () => string, version?: string | null }} [opts]
 *   now in ms; version "1.0" is sent unless null
 */
export function createOAuth1Signer(opts = {}) {
  const now = opts.now ?? Date.now;
  const nonce = opts.nonce ?? (() => randomBytes(16).toString("hex"));
  const version = opts.version === undefined ? "1.0" : opts.version;

  return {
    /**
     * @param {SignInput} input
     * @returns {{ params: Record<string, string>, baseString: string, signature: string }}
     */
    sign(input) {
      /** @type {Record<string, string>} */
      const params = {
        oauth_consumer_key: input.consumerKey,
        oauth_nonce: nonce(),
        oauth_signature_method: "HMAC-SHA1",
        oauth_timestamp: String(Math.floor(now() / 1000)),
      };
      if (input.token) params.oauth_token = input.token;
      if (version) params.oauth_version = version;
      Object.assign(params, input.extra ?? {});
      const pairs = /** @type {Array<[string, string]>} */ (Object.entries(params));
      const baseString = signatureBaseString(input.method, input.url, [...pairs, ...(input.bodyParams ?? [])]);
      const signature = hmacSha1(baseString, signingKey(input.consumerSecret, input.tokenSecret ?? ""));
      return { params: { ...params, oauth_signature: signature }, baseString, signature };
    },
  };
}

/** @typedef {ReturnType<typeof createOAuth1Signer>} OAuth1Signer */
