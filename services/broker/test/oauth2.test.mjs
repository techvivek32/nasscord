import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { createCoalescingCache } from "../src/cache.mjs";
import { createStore } from "../src/db.mjs";
import { HttpError, SessionExpiredError } from "../src/errors.mjs";
import { createLimiter } from "../src/limits.mjs";
import { createLocks } from "../src/locks.mjs";
import { silentLogger } from "../src/log.mjs";
import { buildAuthorizeUrl, createOAuth2, decodeJwtClaims, hashMatches, loginRef, parseTokenResponse, sha256Hex } from "../src/oauth2.mjs";
import { createSecretBox } from "../src/secrets.mjs";
import { simulateBrowserApproval, startFakeOAuth2 } from "./helpers/fake-oauth2.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

const REDIRECT = "http://localhost:3000/api/broker/callback/schwab";
const DAY = 24 * 3_600_000;
/** @type {Array<{ close: () => Promise<void> }>} */
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
});

/** @param {Parameters<typeof startFakeOAuth2>[0]} [serverOpts] */
async function setup(serverOpts = {}) {
  const server = await startFakeOAuth2(serverOpts);
  servers.push(server);
  let offset = 0;
  const now = () => Date.now() + offset;
  const db = createMemoryDb({ now });
  const store = createStore(db);
  const secretBox = createSecretBox({ key: randomBytes(32), keyVersion: 1 });
  const locks = createLocks();
  const cache = createCoalescingCache({ now });
  const deps = { store, secretBox, locks, cache, limiter: createLimiter({ now }), log: silentLogger, now };
  const oauth2 = createOAuth2(deps);
  const id = randomUUID();
  await store.insertConnection({ id, workspace_id: randomUUID(), user_id: randomUUID(), broker_id: "schwab", method: "schwab_oauth", environment: "production", status: "active" });
  /** @param {Partial<import("../src/oauth2.mjs").OAuthProfile>} [p] @returns {import("../src/oauth2.mjs").OAuthProfile} */
  const profile = (p = {}) => ({
    brokerId: "schwab",
    name: "Schwab",
    authorizeUrl: server.urls.authorize,
    tokenUrl: server.urls.token,
    clientAuth: server.cfg.clientAuth,
    scope: "readonly",
    refresh: { kind: "fixed", hardExpiryMs: 7 * DAY, accessFallbackMs: 30 * 60_000 },
    expiredDetail: "Schwab requires a new login every 7 days. Reconnect to continue.",
    ...p,
  });
  /** @type {import("../src/oauth2.mjs").OAuthSecret} */
  const userSecret = { client: "user", clientId: server.cfg.clientId, clientSecret: server.cfg.clientSecret, redirectUri: REDIRECT };
  const conn = async () => /** @type {import("../src/db.mjs").ConnectionRow} */ (await store.getConnection(id));
  /** Logs in through the fake broker and stores the tokens. @param {import("../src/oauth2.mjs").OAuthProfile} [p] */
  async function login(p = profile()) {
    await oauth2.saveSecret(id, userSecret);
    const url = await oauth2.authorizeUrl(id, p, userSecret, "state-123");
    const back = await simulateBrowserApproval(url);
    return oauth2.exchange(id, p, /** @type {any} */ (await oauth2.loadSecret(id, { fresh: true })), /** @type {string} */ (back.code));
  }
  const stored = async () => secretBox.decrypt(id, /** @type {any} */ (await store.getSecret(id)));
  return { server, db, store, secretBox, oauth2, deps, id, profile, userSecret, conn, login, stored, now, advance: (/** @type {number} */ ms) => (offset += ms) };
}

test("authorize URL: response_type, client, redirect, scope, state and extra parameters; PKCE S256", async () => {
  const p = /** @type {import("../src/oauth2.mjs").OAuthProfile} */ ({
    brokerId: "tradestation",
    name: "TradeStation",
    authorizeUrl: "https://signin.example.test/authorize?prompt=login",
    tokenUrl: "https://signin.example.test/oauth/token",
    clientAuth: "body",
    scope: "openid offline_access ReadAccount",
    extraAuthorizeParams: { audience: "https://api.example.test" },
    refresh: { kind: "fixed", accessFallbackMs: 1 },
    expiredDetail: "x",
  });
  const u = new URL(buildAuthorizeUrl(p, { clientId: "cid", redirectUri: REDIRECT, state: "st", codeChallenge: "ch" }));
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    prompt: "login",
    response_type: "code",
    client_id: "cid",
    redirect_uri: REDIRECT,
    scope: "openid offline_access ReadAccount",
    state: "st",
    audience: "https://api.example.test",
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
  const tradier = new URL(buildAuthorizeUrl({ ...p, sendRedirectUri: false, scope: null, extraAuthorizeParams: undefined }, { clientId: "c", redirectUri: REDIRECT, state: "s" }));
  assert.equal(tradier.searchParams.has("redirect_uri"), false, "Tradier takes no redirect_uri");
  assert.equal(tradier.searchParams.has("scope"), false);

  const s = await setup({ pkce: true });
  const { tokens } = await s.login(s.profile({ pkce: true }));
  assert.ok(tokens.accessToken, "the verifier saved with the secret matched the challenge");
  assert.equal((await s.stored()).pkceVerifier, undefined, "the verifier is dropped after the exchange");
});

for (const clientAuth of /** @type {const} */ (["basic", "body", "json"])) {
  test(`code exchange with ${clientAuth} client auth: tokens sealed, hard expiry from the login`, async () => {
    const s = await setup({ clientAuth });
    const t0 = s.now();
    const { secret, tokens } = await s.login();
    assert.equal(s.server.state.tokenCalls, 1);
    assert.ok(tokens.refreshToken && tokens.accessToken);
    const raw = JSON.stringify(s.db.tables.get("broker_secrets"));
    assert.ok(!raw.includes(tokens.accessToken) && !raw.includes(/** @type {string} */ (tokens.refreshToken)), "nothing stored in the clear");
    const plain = await s.stored();
    assert.equal(plain.accessToken, tokens.accessToken);
    assert.equal(plain.clientSecret, s.server.cfg.clientSecret, "the user's own app is kept for reconnecting");
    const hard = Date.parse(plain.refreshExpiresAt) - t0;
    assert.ok(hard > 7 * DAY - 5_000 && hard <= 7 * DAY + 5_000, "Schwab's 7 days from the browser login");
    assert.equal(s.oauth2.sessionExpiry(s.profile(), secret), plain.refreshExpiresAt);
  });
}

test("a used or wrong code, and a wrong client, are plain 400s", async () => {
  const s = await setup();
  await s.oauth2.saveSecret(s.id, s.userSecret);
  const back = await simulateBrowserApproval(await s.oauth2.authorizeUrl(s.id, s.profile(), s.userSecret, "st"));
  await s.oauth2.exchange(s.id, s.profile(), s.userSecret, /** @type {string} */ (back.code));
  await assert.rejects(s.oauth2.exchange(s.id, s.profile(), s.userSecret, /** @type {string} */ (back.code)), (e) => e instanceof HttpError && e.code === "oauth_code_rejected");
  await assert.rejects(
    s.oauth2.exchange(s.id, s.profile(), { ...s.userSecret, clientSecret: "wrong" }, "x"),
    (e) => e instanceof HttpError && e.code === "oauth_client_rejected" && /callback URL exactly/.test(e.message),
  );
});

test("accessToken: no call while fresh; one refresh under the lock when near expiry, saved before use", async () => {
  const s = await setup({ accessTtlSec: 1800 });
  const { tokens } = await s.login();
  const conn = await s.conn();
  assert.equal(await s.oauth2.accessToken(conn, s.profile()), tokens.accessToken);
  assert.equal(s.server.state.tokenCalls, 1, "fresh: no refresh");

  s.advance(29 * 60_000); // under 2 minutes left
  s.server.state.tokenDelayMs = 50;
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => s.oauth2.accessToken(conn, s.profile())));
  assert.equal(s.server.state.tokenCalls, 2, "five reads at once: one refresh (a read and the sweep never refresh twice)");
  assert.equal(new Set(all).size, 1);
  assert.notEqual(all[0], tokens.accessToken);
  assert.equal((await s.stored()).accessToken, all[0], "the new token is in the database");
  assert.equal((await s.stored()).refreshToken, tokens.refreshToken, "a fixed refresh token stays");
});

test("rotation: the new refresh token is saved before the new access token is used", async () => {
  const s = await setup({ rotate: true, accessTtlSec: 60 });
  const { tokens } = await s.login(s.profile({ refresh: { kind: "rotating", accessFallbackMs: 60_000 } }));
  const p = s.profile({ refresh: { kind: "rotating", accessFallbackMs: 60_000 } });
  s.advance(61_000);
  const token = await s.oauth2.accessToken(await s.conn(), p);
  const saved = await s.stored();
  assert.equal(saved.accessToken, token);
  assert.notEqual(saved.refreshToken, tokens.refreshToken, "the rotated refresh token is stored");
  assert.equal(s.server.state.refresh.has(/** @type {string} */ (tokens.refreshToken)), false, "the broker killed the old one");
});

test("a crash between the token answer and the database write: the new token is never used", async () => {
  const s = await setup({ rotate: true, accessTtlSec: 60 });
  const p = s.profile({ refresh: { kind: "rotating", accessFallbackMs: 60_000 } });
  const { tokens } = await s.login(p);
  s.advance(61_000);
  s.db.failNext.set("broker_secrets", new Error("database unavailable"));
  await assert.rejects(s.oauth2.accessToken(await s.conn(), p), /database unavailable/);
  assert.equal((await s.oauth2.loadSecret(s.id)).accessToken, tokens.accessToken, "the cache did not take the unsaved pair");
  assert.equal((await s.stored()).refreshToken, tokens.refreshToken);
  // The broker already rotated: the stored refresh token is dead, so the login has to be done again.
  await assert.rejects(s.oauth2.accessToken(await s.conn(), p), (e) => e instanceof SessionExpiredError && e.reauth === "redirect");
  const row = await s.conn();
  assert.equal(row.status, "expired");
  assert.equal(row.status_detail, "Schwab requires a new login every 7 days. Reconnect to continue.");
  const left = await s.stored();
  assert.equal(left.accessToken, undefined);
  assert.equal(left.refreshToken, undefined);
  assert.equal(left.clientId, s.server.cfg.clientId, "the user's app stays for Reconnect");
});

test("a service restart: a new engine reads the tokens from the database", async () => {
  const s = await setup({ accessTtlSec: 1800 });
  const { tokens } = await s.login();
  const fresh = createOAuth2(s.deps);
  assert.equal(await fresh.accessToken(await s.conn(), s.profile()), tokens.accessToken);
  s.advance(29 * 60_000);
  const refreshed = await fresh.accessToken(await s.conn(), s.profile());
  assert.notEqual(refreshed, tokens.accessToken);
  assert.equal(s.server.state.tokenCalls, 2);
});

test("hard expiry: past Schwab's 7 days the connection expires without a token call", async () => {
  const s = await setup({ accessTtlSec: 1800 });
  await s.login();
  s.advance(7 * DAY + 60_000);
  const calls = s.server.state.tokenCalls;
  await assert.rejects(s.oauth2.accessToken(await s.conn(), s.profile()), SessionExpiredError);
  assert.equal(s.server.state.tokenCalls, calls);
  assert.equal((await s.conn()).status, "expired");
});

test("a refresh refused with invalid_grant (grant deleted) expires the connection", async () => {
  const s = await setup({ accessTtlSec: 60 });
  await s.login();
  s.server.revokeRefresh();
  s.advance(61_000);
  await assert.rejects(s.oauth2.accessToken(await s.conn(), s.profile()), SessionExpiredError);
  assert.equal((await s.conn()).status, "expired");
});

test("a fixed refresh token that rotates anyway ends 24 h after the login (TradeStation)", async () => {
  const s = await setup({ rotate: true, accessTtlSec: 60 });
  const p = s.profile({ refresh: { kind: "fixed", hardExpiryMs: null, rotatedHardExpiryMs: DAY, accessFallbackMs: 60_000 } });
  const t0 = s.now();
  await s.login(p);
  assert.equal((await s.stored()).refreshExpiresAt, null, "no end until a rotation shows up");
  s.advance(61_000);
  await s.oauth2.accessToken(await s.conn(), p);
  const end = Date.parse((await s.stored()).refreshExpiresAt);
  assert.ok(Math.abs(end - (t0 + DAY)) < 5_000);
  assert.equal(Date.parse(/** @type {string} */ ((await s.conn()).session_expires_at)), end, "the card shows Reconnect by");
});

test("no refresh token (Tradier without refresh approval): the session ends with the access token", async () => {
  const s = await setup({ accessTtlSec: 3_600 });
  const p = s.profile({ refresh: { kind: "none", accessFallbackMs: DAY } });
  const { secret } = await s.login(p);
  assert.equal(s.oauth2.sessionExpiry(p, { ...secret, refreshToken: undefined, refreshExpiresAt: null }), secret.accessExpiresAt);
  s.advance(59 * 60_000);
  assert.ok(await s.oauth2.accessToken(await s.conn(), p), "still valid inside the last 2 minutes");
  s.advance(2 * 60_000);
  await assert.rejects(s.oauth2.accessToken(await s.conn(), p), SessionExpiredError);
});

test("circuit breaker: 3 failed token calls in 10 minutes stop token calls for 10 minutes", async () => {
  const s = await setup({ accessTtlSec: 60 });
  await s.login();
  for (let i = 0; i < 3; i++) {
    s.server.state.failNext = { status: 500, body: { error: "server_error" } };
    await assert.rejects(s.oauth2.exchange(s.id, s.profile(), s.userSecret, `code-${i}`));
  }
  const calls = s.server.state.tokenCalls;
  await assert.rejects(s.oauth2.exchange(s.id, s.profile(), s.userSecret, "code-4"), (e) => e instanceof HttpError && e.code === "circuit_open" && e.status === 503);
  assert.equal(s.server.state.tokenCalls, calls, "nothing reached the broker while paused");
  assert.equal(s.oauth2.circuitOpen("schwab"), true);
  s.advance(10 * 60_000 + 1);
  assert.equal(s.oauth2.circuitOpen("schwab"), false);
  await assert.rejects(s.oauth2.exchange(s.id, s.profile(), s.userSecret, "code-5"), (e) => e instanceof HttpError && e.code === "oauth_code_rejected");
});

test("circuit breaker: a user's dead grant never pauses anyone; a rejected app pauses only itself", async () => {
  const s = await setup({ accessTtlSec: 60 });
  await s.login();
  for (let i = 0; i < 4; i++) {
    await assert.rejects(s.oauth2.exchange(s.id, s.profile(), s.userSecret, `bogus-code-${i}`), (e) => e instanceof HttpError && e.code === "oauth_code_rejected");
  }
  assert.equal(s.oauth2.circuitOpen("schwab"), false, "invalid_grant (a refused code, a revoked grant) is not counted");

  const wrong = { ...s.userSecret, clientSecret: "wrong-secret" };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(s.oauth2.exchange(s.id, s.profile(), wrong, `code-${i}`), (e) => e instanceof HttpError && e.code === "oauth_client_rejected");
  }
  assert.equal(s.oauth2.circuitOpen("schwab", s.server.cfg.clientId), true, "this app is paused");
  await assert.rejects(s.oauth2.exchange(s.id, s.profile(), wrong, "code-x"), (e) => e instanceof HttpError && e.code === "circuit_open");
  assert.equal(s.oauth2.circuitOpen("schwab", "platform"), false, "Nasscord's own client is not");
  const calls = s.server.state.tokenCalls;
  const other = { client: /** @type {const} */ ("user"), clientId: "another-users-app", clientSecret: "their-secret", redirectUri: REDIRECT };
  await assert.rejects(s.oauth2.exchange(s.id, s.profile(), other, "code-y"), (e) => e instanceof HttpError && e.code === "oauth_client_rejected");
  assert.equal(s.server.state.tokenCalls, calls + 1, "another user's app still reaches the broker");
});

test("refreshUrl: a broker with its own refresh endpoint (Tradier) gets the refresh there", async () => {
  const s = await setup({ accessTtlSec: 60 });
  const login = s.profile({ refresh: { kind: "fixed", accessFallbackMs: 60_000 } });
  await s.login(login);
  s.advance(61_000);
  const split = s.profile({ tokenUrl: `${s.server.url}/exchange-only`, refreshUrl: s.server.urls.token, refresh: { kind: "fixed", accessFallbackMs: 60_000 } });
  const before = s.server.state.calls.length;
  assert.ok(await s.oauth2.accessToken(await s.conn(), split));
  assert.deepEqual(
    s.server.state.calls.slice(before).map((c) => `${c.method} ${c.path}`),
    ["POST /token"],
    "the refresh went to refreshUrl, not tokenUrl",
  );
});

test("token answers: rt_expires_in (Webull) sets the refresh end; raw is for identify() and never serialised", () => {
  const p = /** @type {any} */ ({ refresh: { accessFallbackMs: 1000 } });
  const t = parseTokenResponse({ access_token: "a", expires_in: 1800, refresh_token: "r", rt_expires_in: 15 * 86_400, identity_id: "wb-123" }, 0, p);
  assert.equal(t?.refreshExpiresAt, new Date(15 * DAY).toISOString());
  assert.equal(t?.raw?.identity_id, "wb-123");
  assert.ok(!JSON.stringify(t).includes("wb-123"), "raw is not enumerable");
  assert.ok(!Object.keys(/** @type {object} */ (t)).includes("raw"));
});

test("helpers: token answers, id_token claims (decode only), hashes", () => {
  const p = /** @type {any} */ ({ refresh: { accessFallbackMs: 1000 } });
  const t = parseTokenResponse({ access_token: "a", expires_in: 60, refresh_token: "r", refresh_token_expires_in: 120, scope: ["read", "market"] }, 0, p);
  assert.deepEqual(t, { accessToken: "a", accessExpiresAt: new Date(60_000).toISOString(), refreshToken: "r", refreshExpiresAt: new Date(120_000).toISOString(), scope: "read market", idToken: null });
  assert.equal(parseTokenResponse({ error: "x" }, 0, p), null);
  assert.equal(parseTokenResponse({ access_token: "a" }, 0, p)?.accessExpiresAt, new Date(1000).toISOString(), "fallback lifetime");
  assert.deepEqual(decodeJwtClaims(`e30.${Buffer.from('{"sub":"abc"}').toString("base64url")}.sig`), { sub: "abc" });
  assert.equal(decodeJwtClaims("not-a-jwt"), null);
  assert.equal(hashMatches("nonce-value", sha256Hex("nonce-value")), true);
  assert.equal(hashMatches("other", sha256Hex("nonce-value")), false);
  assert.equal(hashMatches("nonce-value", "not-a-hash"), false);
});

test("loginRef: the id_token sub, else the App Key plus the sorted account hashes (Schwab)", () => {
  const idToken = `e30.${Buffer.from('{"sub":"schwab-123"}').toString("base64url")}.sig`;
  assert.equal(loginRef({ idToken, key: "app", members: ["b", "a"] }), "sub:schwab-123", "the sub wins");
  const a = loginRef({ key: "app-key", members: ["hashB", "hashA"] });
  assert.equal(a, loginRef({ key: "app-key", members: ["hashA", "hashB"] }), "order does not matter");
  assert.match(String(a), /^h:[0-9a-f]{64}$/);
  assert.notEqual(a, loginRef({ key: "other-key", members: ["hashA", "hashB"] }));
  assert.ok(!String(a).includes("app-key"), "the key itself is never stored");
  assert.equal(loginRef({ key: "app-key", members: [] }), null);
  assert.equal(loginRef({ idToken: "garbage" }), null);
});
