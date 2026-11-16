import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { badRequest, HttpError, SessionExpiredError, unavailable } from "./errors.mjs";
import { createBrokerHttp } from "./http.mjs";
import { iso, parseTime } from "./time.mjs";

/**
 * The generic OAuth 2.0 authorization-code engine (docs/real-backend.md, "Connect flows"), driven by
 * a small per-broker profile. It owns:
 * - the authorize URL (state, optional PKCE S256) built at the canonical-host hop,
 * - the code exchange at the canonical callback, and the token refresh,
 * - the sealed secret of each OAuth connection in broker_secrets (with a short in-memory copy),
 * - a circuit breaker for the token endpoint (tastytrade and Webull block the whole service IP after
 *   repeated failed logins), per broker and client: Nasscord's platform client has one, and each
 *   user's own app its own, so one user's rejected app never pauses anyone else. Only failures that
 *   point at the service or the client count (network errors, timeouts, 5xx, invalid_client); a
 *   single user's revoked grant (invalid_grant) or a refused code does not.
 *
 * Refresh rules:
 * - accessToken(conn) refreshes when less than refreshBeforeMs (2 min) is left, under the lock
 *   "token:<id>" so a read and the scheduler never refresh the same connection twice.
 * - A refreshed pair is written to broker_secrets BEFORE the new access token is used: with a
 *   rotating refresh token the old one is dead the moment the broker answers, so an unsaved pair
 *   would lose the connection. If the write fails the call fails and nothing unsaved is cached.
 * - invalid_grant or invalid_client on refresh: the connection is expired with the profile's
 *   sentence and the user reconnects (next.kind "redirect").
 * - A hard expiry (Schwab: 7 days from the browser login) is checked before any refresh call.
 *
 * The locks are in memory: the broker service runs as ONE process (docs/real-backend.md, section 1).
 * Two instances could refresh one rotating token twice and lose the connection.
 */

/**
 * @typedef {{
 *   brokerId: string,
 *   name: string,
 *   authorizeUrl: string,
 *   tokenUrl: string,
 *   refreshUrl?: string,
 *   clientAuth: "basic" | "body" | "json",
 *   sendRedirectUri?: boolean,
 *   scope?: string | null,
 *   extraAuthorizeParams?: Record<string, string>,
 *   pkce?: boolean,
 *   platformClient?: { clientId: string, clientSecret: string } | null,
 *   tokenHeaders?: (req: { url: string, body: string, contentType: string }) => Record<string, string>,
 *   refresh: {
 *     kind: "none" | "fixed" | "rotating",
 *     hardExpiryMs?: number | null,
 *     rotatedHardExpiryMs?: number | null,
 *     accessFallbackMs: number,
 *     refreshBeforeMs?: number,
 *   },
 *   expiredDetail: string,
 *   tokenRatePerSec?: number,
 *   circuit?: { failures: number, windowMs: number, openMs: number },
 *   parseTokenError?: (status: number, json: any) => "invalid_grant" | "invalid_client" | "other",
 * }} OAuthProfile
 * - authorizeUrl / tokenUrl: full URLs for the connection's environment (the adapter applies
 *   BROKER_URL_OVERRIDES before building the profile). refreshUrl: where grant_type=refresh_token
 *   goes when the broker uses another endpoint for it (Tradier: /v1/oauth/refreshtoken); default
 *   tokenUrl.
 * - clientAuth: how the client authenticates at the token endpoint: HTTP Basic (Schwab, Tradier),
 *   form fields (TradeStation) or a JSON body (tastytrade).
 * - sendRedirectUri: false for Tradier, which takes no redirect_uri.
 * - platformClient: Nasscord's own client from the service env; the user's own app comes from the
 *   connection's secret instead.
 * - tokenHeaders: extra headers per token request (Webull's signature).
 * - refresh.kind: none (no refresh token: the session ends with the access token, Tradier without
 *   refresh approval), fixed (the refresh token stays the same), rotating (each refresh returns a
 *   new one, saved before use). hardExpiryMs: the login's absolute life from the browser login.
 *   rotatedHardExpiryMs: when a "fixed" broker returns a new refresh token anyway, the login ends
 *   this long after the browser login (TradeStation's rotating keys: 24 h).
 * - expiredDetail: the sentence on the connection when the user has to log in again.
 * - circuit: default 3 failed token calls in 10 minutes stop token calls for 10 minutes (per broker
 *   and client, see the module comment).
 *
 * @typedef {{
 *   accessToken: string,
 *   accessExpiresAt: string,
 *   refreshToken: string | null,
 *   refreshExpiresAt: string | null,
 *   scope: string | null,
 *   idToken: string | null,
 *   raw?: Record<string, unknown>,
 * }} TokenSet
 * - refreshExpiresAt: from refresh_token_expires_in, refresh_expires_in or rt_expires_in (Webull),
 *   in seconds.
 * - raw: the broker's whole token answer, for identify() to read broker-specific fields (Webull's
 *   identity_id). Not enumerable, so it never ends up in JSON, a log line or the sealed secret.
 *
 * @typedef {{
 *   client: "user" | "platform",
 *   clientId?: string,
 *   clientSecret?: string,
 *   redirectUri: string,
 *   accessToken?: string,
 *   accessExpiresAt?: string,
 *   refreshToken?: string,
 *   refreshIssuedAt?: string,
 *   refreshExpiresAt?: string | null,
 *   scope?: string | null,
 *   pkceVerifier?: string,
 *   extra?: Record<string, unknown>,
 * }} OAuthSecret
 * The plaintext of an OAuth connection's broker_secrets row (contract: secret shapes).
 */

/** sha256 hex of a string (state, ticket and binding nonces are stored only as this). @param {string} s */
export const sha256Hex = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");

/** A random url-safe token (32 bytes = 43 characters). @param {number} [bytes] */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/**
 * Constant-time check that sha256(value) is `hashHex`.
 * @param {unknown} value
 * @param {string | null | undefined} hashHex
 */
export function hashMatches(value, hashHex) {
  if (typeof value !== "string" || !value || typeof hashHex !== "string" || !/^[0-9a-f]{64}$/.test(hashHex)) return false;
  const a = Buffer.from(sha256Hex(value), "hex");
  const b = Buffer.from(hashHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token endpoint said no. `kind` is what the engine acts on. */
export class OAuthTokenError extends HttpError {
  /**
   * @param {string} name broker name
   * @param {"invalid_grant" | "invalid_client" | "other"} kind
   * @param {number} brokerStatus
   */
  constructor(name, kind, brokerStatus) {
    super(502, `${name} did not accept the login (${kind === "other" ? brokerStatus : kind}).`, { code: `oauth_${kind}` });
    this.name = "OAuthTokenError";
    this.kind = kind;
    this.brokerStatus = brokerStatus;
  }
}

const SECRET_CACHE_MS = 10 * 60_000;
const DEFAULT_CIRCUIT = Object.freeze({ failures: 3, windowMs: 10 * 60_000, openMs: 10 * 60_000 });

/**
 * The authorize URL for one login.
 * @param {OAuthProfile} profile
 * @param {{ clientId: string, redirectUri: string, state: string, codeChallenge?: string | null }} p
 */
export function buildAuthorizeUrl(profile, p) {
  const u = new URL(profile.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  if (profile.sendRedirectUri !== false) u.searchParams.set("redirect_uri", p.redirectUri);
  if (profile.scope) u.searchParams.set("scope", profile.scope);
  u.searchParams.set("state", p.state);
  for (const [k, v] of Object.entries(profile.extraAuthorizeParams ?? {})) u.searchParams.set(k, v);
  if (p.codeChallenge) {
    u.searchParams.set("code_challenge", p.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  return u.toString();
}

/**
 * A token endpoint answer as a TokenSet, or null when it has no access token.
 * @param {any} json
 * @param {number} nowMs
 * @param {OAuthProfile} profile
 * @returns {TokenSet | null}
 */
export function parseTokenResponse(json, nowMs, profile) {
  if (!json || typeof json !== "object" || Array.isArray(json) || typeof json.access_token !== "string" || !json.access_token) return null;
  const expiresIn = Number(json.expires_in);
  const refreshIn = Number(json.refresh_token_expires_in ?? json.refresh_expires_in ?? json.rt_expires_in);
  const scope = Array.isArray(json.scope) ? json.scope.join(" ") : typeof json.scope === "string" ? json.scope : null;
  /** @type {TokenSet} */
  const tokens = {
    accessToken: json.access_token,
    accessExpiresAt: /** @type {string} */ (iso(nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : profile.refresh.accessFallbackMs))),
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token ? json.refresh_token : null,
    refreshExpiresAt: Number.isFinite(refreshIn) && refreshIn > 0 ? iso(nowMs + refreshIn * 1000) : null,
    scope: scope ? scope.slice(0, 200) : null,
    idToken: typeof json.id_token === "string" && json.id_token ? json.id_token : null,
  };
  Object.defineProperty(tokens, "raw", { value: json, enumerable: false });
  return tokens;
}

/**
 * The claims of a JWT (an id_token) WITHOUT checking its signature: for naming the login only
 * (external_ref), never for deciding access.
 * @param {string | null | undefined} jwt
 * @returns {Record<string, unknown> | null}
 */
export function decodeJwtClaims(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * The broker-side identity of an OAuth login, for external_ref (duplicate merge and the one-login
 * index): the id_token's `sub` when the broker sent one (decoded only, never trusted for access),
 * else sha256 of the client key plus the sorted member ids. Schwab without an id_token uses its App
 * Key and the sorted account hashes, so the same Schwab login is found again. Null when neither
 * exists; identify() must then name the login another way.
 * @param {{ idToken?: string | null, key?: string | null, members?: string[] }} p
 * @returns {string | null}
 */
export function loginRef(p) {
  const sub = decodeJwtClaims(p.idToken)?.sub;
  if (typeof sub === "string" && sub.trim() && sub.length <= 190) return `sub:${sub}`;
  const members = (p.members ?? []).filter((m) => typeof m === "string" && m).sort();
  if (!p.key || members.length === 0) return null;
  return `h:${sha256Hex([p.key, ...members].join("|"))}`;
}

/**
 * @param {{
 *   store: import("./db.mjs").Store,
 *   secretBox: import("./secrets.mjs").SecretBox,
 *   locks: import("./locks.mjs").Locks,
 *   cache: import("./cache.mjs").CoalescingCache,
 *   limiter?: import("./limits.mjs").Limiter | null,
 *   log: import("./log.mjs").Logger,
 *   now?: () => number,
 *   fetch?: typeof fetch,
 * }} deps
 */
export function createOAuth2(deps) {
  const { store, secretBox, locks, cache, log, limiter = null, now = Date.now } = deps;
  /** @type {Map<string, { value: any, at: number }>} */
  const secrets = new Map();
  /** @type {Map<string, { fails: number[], openUntil: number }>} */
  const breakers = new Map();

  // ── secrets (any adapter may use these for its own secret shape)

  /**
   * The decrypted secret of a connection, or null. `fresh` skips the in-memory copy.
   * @param {string} id
   * @param {{ fresh?: boolean }} [o]
   * @returns {Promise<any>}
   */
  async function loadSecret(id, o = {}) {
    const hit = secrets.get(id);
    if (!o.fresh && hit && now() - hit.at < SECRET_CACHE_MS) return hit.value;
    const row = await store.getSecret(id);
    const value = row ? secretBox.decrypt(id, row) : null;
    secrets.set(id, { value, at: now() });
    // A row sealed with an older key is re-sealed with the current one on first use.
    if (row && value && secretBox.needsRotation(row)) await saveSecret(id, value).catch(() => {});
    return value;
  }

  /**
   * Seals and stores a connection's secret; the in-memory copy changes only after the write.
   * @param {string} id
   * @param {unknown} value
   */
  async function saveSecret(id, value) {
    await store.putSecret({ connection_id: id, ...secretBox.encrypt(id, value) });
    secrets.set(id, { value, at: now() });
  }

  /** @param {string} id */
  function forget(id) {
    secrets.delete(id);
  }

  /**
   * Keeps what reconnecting needs (the user's own app, the redirect URI, adapter extras) and drops
   * every token.
   * @param {string} id
   */
  async function dropTokens(id) {
    const s = /** @type {OAuthSecret | null} */ (await loadSecret(id, { fresh: true }).catch(() => null));
    if (!s) return;
    /** @type {OAuthSecret} */
    const kept = { client: s.client, redirectUri: s.redirectUri };
    if (s.clientId) kept.clientId = s.clientId;
    if (s.clientSecret) kept.clientSecret = s.clientSecret;
    if (s.extra) kept.extra = s.extra;
    await saveSecret(id, kept);
  }

  /**
   * Expires a connection whose login is over: tokens dropped, status expired with `detail`.
   * @param {import("./db.mjs").ConnectionRow} conn
   * @param {string} detail
   */
  async function expire(conn, detail) {
    await dropTokens(conn.id).catch((e) => log.warn("oauth tokens not dropped", { connectionId: conn.id, error: e }));
    cache.invalidate(conn.id);
    return store.updateConnectionIf(conn.id, ["active", "pending"], { status: "expired", status_detail: detail });
  }

  // ── circuit breaker per broker and client

  /**
   * The breaker key of a token call: "<broker>:platform" for Nasscord's client, "<broker>:user:<h>"
   * for a user's own app (h = a short hash of its client id, never the id itself).
   * @param {OAuthProfile} profile
   * @param {{ id: string, kind: "user" | "platform" }} client
   */
  const breakerKey = (profile, client) => (client.kind === "user" ? `${profile.brokerId}:user:${sha256Hex(client.id).slice(0, 16)}` : `${profile.brokerId}:platform`);

  /** @param {string} key */
  function breaker(key) {
    let b = breakers.get(key);
    if (!b) {
      b = { fails: [], openUntil: 0 };
      breakers.set(key, b);
    }
    return b;
  }

  /** @param {OAuthProfile} profile @param {string} key */
  function checkCircuit(profile, key) {
    if (breaker(key).openUntil > now()) {
      throw unavailable(`Nasscord paused ${profile.name} sign-ins for a few minutes after repeated failures. Try again later.`, "circuit_open");
    }
  }

  /** @param {OAuthProfile} profile @param {string} key */
  function recordFailure(profile, key) {
    const c = profile.circuit ?? DEFAULT_CIRCUIT;
    const b = breaker(key);
    const t = now();
    b.fails = [...b.fails.filter((at) => t - at < c.windowMs), t];
    if (b.fails.length >= c.failures) {
      b.openUntil = t + c.openMs;
      b.fails = [];
      log.warn("oauth token calls paused after repeated failures", { broker: profile.brokerId, client: key.includes(":user:") ? "user" : "platform", minutes: Math.round(c.openMs / 60_000) });
    }
  }

  /** @param {string} key */
  function recordSuccess(key) {
    breaker(key).fails = [];
  }

  // ── the token endpoint

  /**
   * The client id and secret a token call authenticates with.
   * @param {OAuthProfile} profile
   * @param {OAuthSecret} secret
   */
  function clientOf(profile, secret) {
    if (secret.client === "user") {
      if (!secret.clientId || !secret.clientSecret) throw badRequest(`Connect ${profile.name} again with your app key and secret.`, "no_client");
      return { id: secret.clientId, secret: secret.clientSecret, kind: /** @type {const} */ ("user") };
    }
    if (!profile.platformClient) throw unavailable(`${profile.name} logins are not set up on this server yet.`, "not_configured");
    return { id: profile.platformClient.clientId, secret: profile.platformClient.clientSecret, kind: /** @type {const} */ ("platform") };
  }

  /**
   * One POST to the token endpoint (`url`: the profile's tokenUrl, or its refreshUrl for a refresh).
   * @param {OAuthProfile} profile
   * @param {{ id: string, secret: string, kind: "user" | "platform" }} client
   * @param {Record<string, string>} params grant_type and its fields
   * @param {string} [url]
   * @returns {Promise<TokenSet>}
   */
  async function tokenCall(profile, client, params, url = profile.tokenUrl) {
    const key = breakerKey(profile, client);
    checkCircuit(profile, key);
    const u = new URL(url);
    const escaped = u.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const http = createBrokerHttp({
      name: profile.name,
      base: u.origin,
      allow: [["POST", new RegExp(`^${escaped}$`)]],
      limiter,
      bucket: { key: `${profile.brokerId}:oauth:*`, ratePerSec: profile.tokenRatePerSec ?? 2 },
      timeoutMs: 10_000,
      fetch: deps.fetch,
      now,
    });
    /** @type {Record<string, string>} */
    const headers = {};
    /** @type {Record<string, string>} */
    const fields = { ...params };
    if (profile.clientAuth === "basic") {
      // The id and secret as issued (Schwab and Tradier expect them as-is, not form-encoded).
      headers.authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
    } else {
      fields.client_id = client.id;
      fields.client_secret = client.secret;
    }
    const json = profile.clientAuth === "json";
    const body = json ? JSON.stringify(fields) : new URLSearchParams(fields).toString();
    if (profile.tokenHeaders) {
      Object.assign(headers, profile.tokenHeaders({ url, body, contentType: json ? "application/json" : "application/x-www-form-urlencoded" }));
    }

    /** @type {import("./http.mjs").RawResponse} */
    let res;
    try {
      res = await http.request("POST", u.pathname, json ? { json: fields, headers, raw: true } : { form: fields, headers, raw: true });
    } catch (e) {
      // Network errors and timeouts count; a 429 is the broker pacing us, not a failed login.
      if (!(e instanceof HttpError && e.status === 429)) recordFailure(profile, key);
      throw e;
    }
    const ok = res.status >= 200 && res.status < 300;
    const tokens = ok ? parseTokenResponse(res.json, now(), profile) : null;
    if (tokens) {
      recordSuccess(key);
      return tokens;
    }
    const err = String(res.json?.error ?? "").toLowerCase();
    const kind =
      profile.parseTokenError?.(res.status, res.json) ??
      (err === "invalid_grant" ? "invalid_grant" : err === "invalid_client" || err === "unauthorized_client" || res.status === 401 ? "invalid_client" : "other");
    // Counted: the broker failing (5xx, a 2xx without a token) and a rejected client. Not counted: one
    // user's dead grant or a refused code (invalid_grant, other 4xx), which say nothing about the IP.
    if (ok || res.status >= 500 || kind === "invalid_client") recordFailure(profile, key);
    throw new OAuthTokenError(profile.name, kind, res.status);
  }

  /**
   * The authorize URL of one login, built at the canonical-host hop. With PKCE the verifier is
   * saved in the connection's secret before the URL goes out.
   * @param {string} connectionId
   * @param {OAuthProfile} profile
   * @param {OAuthSecret} secret
   * @param {string} state
   */
  async function authorizeUrl(connectionId, profile, secret, state) {
    const clientId = secret.client === "user" ? secret.clientId : profile.platformClient?.clientId;
    if (!clientId) throw unavailable(`${profile.name} logins are not set up on this server yet.`, "not_configured");
    let codeChallenge = null;
    if (profile.pkce) {
      const verifier = randomToken(48);
      codeChallenge = createHash("sha256").update(verifier).digest("base64url");
      await saveSecret(connectionId, { ...secret, pkceVerifier: verifier });
    }
    return buildAuthorizeUrl(profile, { clientId, redirectUri: secret.redirectUri, state, codeChallenge });
  }

  /**
   * Exchanges an authorization code and saves the tokens (before anything uses them).
   * @param {string} connectionId
   * @param {OAuthProfile} profile
   * @param {OAuthSecret} secret
   * @param {string} code
   * @returns {Promise<{ secret: OAuthSecret, tokens: TokenSet }>}
   */
  async function exchange(connectionId, profile, secret, code) {
    /** @type {Record<string, string>} */
    const params = { grant_type: "authorization_code", code };
    if (profile.sendRedirectUri !== false) params.redirect_uri = secret.redirectUri;
    if (profile.pkce && secret.pkceVerifier) params.code_verifier = secret.pkceVerifier;
    let tokens;
    try {
      tokens = await tokenCall(profile, clientOf(profile, secret), params);
    } catch (e) {
      if (e instanceof OAuthTokenError) {
        if (e.kind === "invalid_client") {
          throw badRequest(
            secret.client === "user"
              ? `${profile.name} did not accept the app key and secret. Check them, and that the app lists Nasscord's callback URL exactly, then start again.`
              : `${profile.name} did not accept Nasscord's app. Try again later.`,
            "oauth_client_rejected",
          );
        }
        throw badRequest(`${profile.name} did not accept the login code. Start again from Brokers.`, "oauth_code_rejected");
      }
      throw e;
    }
    const t = now();
    const hard = profile.refresh.hardExpiryMs ? iso(t + profile.refresh.hardExpiryMs) : null;
    /** @type {OAuthSecret} */
    const next = { ...secret, accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt };
    delete next.pkceVerifier;
    if (tokens.refreshToken) {
      next.refreshToken = tokens.refreshToken;
      next.refreshIssuedAt = /** @type {string} */ (iso(t));
      next.refreshExpiresAt = tokens.refreshExpiresAt ?? hard;
    } else {
      delete next.refreshToken;
      delete next.refreshIssuedAt;
      next.refreshExpiresAt = null;
    }
    if (tokens.scope) next.scope = tokens.scope;
    await saveSecret(connectionId, next);
    return { secret: next, tokens };
  }

  /**
   * When the login behind a secret ends: the refresh token's end, or the access token's when there
   * is no refresh. Null when it does not end on its own.
   * @param {OAuthProfile} profile
   * @param {OAuthSecret | null | undefined} secret
   * @returns {string | null}
   */
  function sessionExpiry(profile, secret) {
    if (!secret) return null;
    if (secret.refreshExpiresAt) return secret.refreshExpiresAt;
    if (profile.refresh.kind === "none" || !secret.refreshToken) return secret.accessExpiresAt ?? null;
    return null;
  }

  /**
   * A usable access token for an active connection, refreshed when needed (see the module comment).
   * Throws SessionExpiredError (reauth "redirect") after marking the connection expired.
   * @param {import("./db.mjs").ConnectionRow} conn
   * @param {OAuthProfile} profile
   * @returns {Promise<string>}
   */
  async function accessToken(conn, profile) {
    if (conn.status !== "active") throw new SessionExpiredError(conn.status_detail || profile.expiredDetail, { reauth: "redirect" });
    const before = profile.refresh.refreshBeforeMs ?? 2 * 60_000;
    /** @param {OAuthSecret | null} s */
    const fresh = (s) => !!s?.accessToken && (parseTime(s.accessExpiresAt) ?? 0) - now() > before;
    const cached = /** @type {OAuthSecret | null} */ (await loadSecret(conn.id));
    if (cached && fresh(cached)) return /** @type {string} */ (cached.accessToken);

    return locks.run(`token:${conn.id}`, async () => {
      // Read again under the lock: a refresh that just finished (the sweep, another read) wins.
      const s = /** @type {OAuthSecret | null} */ (await loadSecret(conn.id, { fresh: true }));
      if (s && fresh(s)) return /** @type {string} */ (s.accessToken);
      const ends = async () => {
        await expire(conn, profile.expiredDetail);
        return new SessionExpiredError(profile.expiredDetail, { reauth: "redirect" });
      };
      if (!s) throw await ends();
      const accessLeft = (parseTime(s.accessExpiresAt) ?? 0) - now();
      if (profile.refresh.kind === "none" || !s.refreshToken) {
        if (s.accessToken && accessLeft > 0) return s.accessToken;
        throw await ends();
      }
      const hard = parseTime(s.refreshExpiresAt);
      if (hard !== null && hard <= now()) throw await ends();

      let tokens;
      try {
        tokens = await tokenCall(profile, clientOf(profile, s), { grant_type: "refresh_token", refresh_token: s.refreshToken }, profile.refreshUrl ?? profile.tokenUrl);
      } catch (e) {
        if (e instanceof OAuthTokenError && (e.kind === "invalid_grant" || e.kind === "invalid_client")) {
          log.info("oauth refresh refused; login needed", { connectionId: conn.id, broker: profile.brokerId, kind: e.kind });
          throw await ends();
        }
        // A broker hiccup: the old token still works for a moment.
        if (s.accessToken && accessLeft > 0) return s.accessToken;
        throw e;
      }

      const rotated = !!tokens.refreshToken && tokens.refreshToken !== s.refreshToken;
      let refreshExpiresAt = s.refreshExpiresAt ?? null;
      if (profile.refresh.kind === "rotating" && tokens.refreshExpiresAt) refreshExpiresAt = tokens.refreshExpiresAt;
      if (rotated && profile.refresh.kind !== "rotating" && !refreshExpiresAt && profile.refresh.rotatedHardExpiryMs) {
        refreshExpiresAt = iso((parseTime(s.refreshIssuedAt) ?? now()) + profile.refresh.rotatedHardExpiryMs);
      }
      /** @type {OAuthSecret} */
      const next = {
        ...s,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshToken: tokens.refreshToken ?? s.refreshToken,
        refreshExpiresAt,
        scope: tokens.scope ?? s.scope ?? null,
      };
      // Saved before use. If this throws, the caller fails and the cache keeps the old copy.
      await saveSecret(conn.id, next);
      if ((refreshExpiresAt ?? null) !== (s.refreshExpiresAt ?? null)) {
        await store.updateConnectionIf(conn.id, ["active"], { session_expires_at: refreshExpiresAt }).catch((e) => {
          log.warn("session end not updated after a refresh", { connectionId: conn.id, error: e });
        });
      }
      return /** @type {string} */ (next.accessToken);
    });
  }

  return {
    loadSecret,
    saveSecret,
    dropTokens,
    expire,
    forget,
    authorizeUrl,
    exchange,
    accessToken,
    sessionExpiry,
    /**
     * For tests and health: are token calls of the broker paused, for any client (or for `client`:
     * "platform", or a user app's client id)?
     * @param {string} brokerId
     * @param {string} [client]
     */
    circuitOpen(brokerId, client) {
      const t = now();
      if (client) {
        const key = client === "platform" ? `${brokerId}:platform` : `${brokerId}:user:${sha256Hex(client).slice(0, 16)}`;
        return (breakers.get(key)?.openUntil ?? 0) > t;
      }
      for (const [key, b] of breakers) if (key.startsWith(`${brokerId}:`) && b.openUntil > t) return true;
      return false;
    },
  };
}

/** @typedef {ReturnType<typeof createOAuth2>} OAuth2Engine */
