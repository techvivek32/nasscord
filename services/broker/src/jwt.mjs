import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Service JWT from the Nasscord app (contract section 5): HS256 with BROKER_SERVICE_SECRET.
 * No JWT library: the format is small enough to check by hand, and doing it here means
 * there is exactly one algorithm the service will ever accept.
 */

export const JWT_ISSUER = "nasscord-app";
export const JWT_AUDIENCE = "nasscord-broker";
/** A token issued further than this in the future is refused (clock skew allowance). */
export const MAX_FUTURE_IAT_SEC = 120;
/** The app issues 60 s tokens. Anything that claims to live longer than this is refused. */
export const MAX_LIFETIME_SEC = 300;

export const ROLES = /** @type {const} */ (["superadmin", "tenant", "trader", "tenant_user"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]*$/;

/**
 * @typedef {{
 *   iss: string, aud: string, sub: string, wid: string | null,
 *   role: "superadmin" | "tenant" | "trader" | "tenant_user",
 *   iat: number, exp: number,
 * }} ServiceClaims
 */

export class JwtError extends Error {
  /** @param {string} reason short machine-readable reason */
  constructor(reason) {
    super(`service token rejected: ${reason}`);
    this.name = "JwtError";
    this.reason = reason;
  }
}

/** @param {unknown} v */
const b64json = (v) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

/**
 * Signs claims the same way the app does. Used by tests and local tooling.
 * @param {Record<string, unknown>} claims
 * @param {string | Buffer} secret
 */
export function signServiceJwt(claims, secret) {
  const head = b64json({ alg: "HS256", typ: "JWT" });
  const body = b64json(claims);
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/**
 * @param {string} part
 * @param {string} what
 */
function parseJson(part, what) {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new JwtError(`${what} is not valid JSON`);
  }
}

/**
 * Verifies signature and claims. Throws JwtError with the reason; returns the claims.
 * @param {unknown} token
 * @param {string | Buffer} secret
 * @param {{ now?: () => number }} [opts] now in milliseconds
 * @returns {ServiceClaims}
 */
export function verifyServiceJwt(token, secret, opts = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) throw new JwtError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => p.length > 0 && B64URL.test(p))) throw new JwtError("malformed");
  const [head, body, sig] = parts;

  const header = parseJson(head, "header");
  if (header.alg !== "HS256") throw new JwtError("algorithm must be HS256");
  if (header.typ !== undefined && header.typ !== "JWT") throw new JwtError("type must be JWT");
  if (header.crit !== undefined) throw new JwtError("critical headers are not supported");

  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  // Lengths are public (always 32 for HS256); compare the bytes in constant time.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new JwtError("bad signature");

  const c = parseJson(body, "payload");
  if (c.iss !== JWT_ISSUER) throw new JwtError("wrong issuer");
  const audOk = Array.isArray(c.aud) ? c.aud.includes(JWT_AUDIENCE) : c.aud === JWT_AUDIENCE;
  if (!audOk) throw new JwtError("wrong audience");
  if (typeof c.sub !== "string" || !UUID.test(c.sub)) throw new JwtError("sub must be a user id");
  if (!(c.wid === null || c.wid === undefined || (typeof c.wid === "string" && UUID.test(c.wid)))) {
    throw new JwtError("wid must be a workspace id or null");
  }
  if (!ROLES.includes(c.role)) throw new JwtError("unknown role");
  if (!Number.isFinite(c.iat) || !Number.isFinite(c.exp)) throw new JwtError("iat and exp are required");

  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  if (c.exp <= nowSec) throw new JwtError("expired");
  if (c.iat > nowSec + MAX_FUTURE_IAT_SEC) throw new JwtError("issued in the future");
  if (c.exp <= c.iat) throw new JwtError("exp before iat");
  if (c.exp - c.iat > MAX_LIFETIME_SEC) throw new JwtError("lifetime too long");

  return {
    iss: c.iss,
    aud: JWT_AUDIENCE,
    sub: c.sub.toLowerCase(),
    wid: typeof c.wid === "string" ? c.wid.toLowerCase() : null,
    role: c.role,
    iat: c.iat,
    exp: c.exp,
  };
}

/**
 * Pulls the token out of "Authorization: Bearer <jwt>".
 * @param {string | undefined} header
 */
export function bearerToken(header) {
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+([A-Za-z0-9._-]+)\s*$/i.exec(header);
  return m ? m[1] : null;
}
