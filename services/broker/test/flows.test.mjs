import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { sha256Hex } from "../src/oauth2.mjs";
import { simulateBrowserApproval, startFakeOAuth2 } from "./helpers/fake-oauth2.mjs";
import { createHarness, fakeAggregatorAdapter, fakeKeyAdapter, fakeOAuthAdapter, newBinding, runOAuthLogin } from "./helpers/harness.mjs";

const KEY_LIVE = "live-secret-key-0001";
const KEY_PAPER = "paper-secret-key-0002";
const KEY_OTHER = "other-secret-key-0003";
const keys = new Map(
  /** @type {Array<[string, { account: string, environment: "production" | "paper", accounts?: string[] }]>} */ ([
    [KEY_LIVE, { account: "alpaca-acct-live", environment: "production" }],
    [KEY_PAPER, { account: "alpaca-acct-paper", environment: "paper", accounts: ["PA1", "PA2"] }],
    [KEY_OTHER, { account: "alpaca-acct-other", environment: "production" }],
  ]),
);

/** @type {Awaited<ReturnType<typeof startFakeOAuth2>>} */
let schwab;
/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** @type {Array<{ body: string }>} */
const webhookCalls = [];

before(async () => {
  schwab = await startFakeOAuth2({ clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456", sub: "schwab-user-1" });
  h = await createHarness({
    env: { BROKER_AUDIENCE: "schwab_oauth=all" },
    adapters: [
      ["alpaca", fakeKeyAdapter({ keys })],
      ["schwab", fakeOAuthAdapter({ server: schwab })],
      ["snaptrade", fakeAggregatorAdapter({ webhookCalls })],
    ],
  });
});
after(async () => {
  await h?.close();
  await schwab?.close();
});

const schwabStart = { brokerId: "schwab", clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456" };

test("options: one entry per broker, method and client, with the callback URL", async () => {
  const r = await h.req("/v1/options");
  assert.equal(r.status, 200);
  assert.equal(r.json.callbackBase, "http://localhost:3000");
  /** @param {string} b @param {string} m @param {string | null} [c] */
  const pick = (b, m, c = null) => r.json.options.find((/** @type {any} */ o) => o.brokerId === b && o.method === m && o.client === c);
  assert.equal(pick("alpaca", "alpaca_key").available, true);
  assert.equal(pick("schwab", "schwab_oauth", "user").available, true, "opened with BROKER_AUDIENCE for this test");
  assert.equal(pick("schwab", "schwab_oauth", "user").callbackUrl, "http://localhost:3000/api/broker/callback/schwab");
  assert.equal(pick("schwab", "schwab_oauth", "platform").reasonCode, "not_configured", "no SCHWAB_CLIENT_ID");
  assert.equal(pick("tradier", "tradier_token").reasonCode, "not_built");
  assert.equal(pick("ibkr", "ibkr_gateway").reasonCode, "not_configured", "no gateway bundle in tests");
  assert.equal(pick("etrade", "etrade_oauth1").available, true);
  assert.deepEqual(pick("etrade", "etrade_oauth1").environments, ["production", "sandbox"], "sandbox only outside production");
  assert.equal(pick("fidelity", "snaptrade").reasonCode, "not_configured", "no SnapTrade keys");
});

test("api_key: a key connects, the same login again reuses the connection and keeps the Included switches", async () => {
  const first = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: "AKID0001", secret: KEY_PAPER } });
  assert.equal(first.status, 200, first.text);
  const c = first.json.connection;
  assert.equal(c.environment, "paper");
  assert.equal(c.status, "active");
  assert.equal(c.accounts.length, 2);
  const row = h.rows("broker_connections").find((x) => x.id === c.id);
  assert.equal(row?.external_ref, "alpaca-acct-paper");
  assert.ok(!JSON.stringify(h.rows("broker_secrets")).includes(KEY_PAPER), "the key is sealed");
  assert.equal(h.svc.secretBox.decrypt(c.id, /** @type {any} */ (h.rows("broker_secrets").find((s) => s.connection_id === c.id))).secretKey, KEY_PAPER);

  const acct = h.rows("broker_accounts").find((a) => a.connection_id === c.id && a.external_id === "PA2");
  if (acct) acct.included = false;
  const again = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: "AKID0001", secret: KEY_PAPER } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.connection.id, c.id, "the same Alpaca account reuses its connection");
  assert.equal(again.json.connection.accounts.find((/** @type {any} */ a) => a.displayNumber.endsWith("A2"))?.included, false);
  assert.equal(h.rows("broker_connections").filter((x) => x.broker_id === "alpaca" && x.status !== "disconnected").length, 1);
  assert.ok(h.rows("audit_events").some((a) => a.action === "broker.alpaca.connect" && a.result === "ok"));
});

test("api_key: replace-key mode refuses another account; a bad key is a 400; renew answers next api_key", async () => {
  const live = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", secret: KEY_LIVE } });
  assert.equal(live.status, 200, live.text);
  const id = live.json.connection.id;
  const other = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", secret: KEY_OTHER, connectionId: id } });
  assert.equal(other.status, 409);
  assert.equal(other.json.code, "other_account");
  const bad = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", secret: "not-a-real-key-000" } });
  assert.equal(bad.status, 400);
  const short = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", secret: "x" } });
  assert.equal(short.status, 400);

  keys.delete(KEY_LIVE); // the user regenerated the key in Alpaca
  const renew = await h.req(`/v1/connections/${id}/renew`, { method: "POST" });
  assert.equal(renew.status, 200, renew.text);
  assert.deepEqual(renew.json.next, { kind: "api_key" });
  assert.equal(renew.json.connection.status, "expired");
  keys.set(KEY_LIVE, { account: "alpaca-acct-live", environment: "production" });
  const replaced = await h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", secret: KEY_LIVE, connectionId: id } });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.json.connection.id, id);
  assert.equal(replaced.json.connection.status, "active");
});

test("audience gate per method: a trader cannot use an owner-only method", async () => {
  const g = await createHarness({ adapters: [["schwab", fakeOAuthAdapter({ server: schwab })]] });
  try {
    const b = newBinding();
    const r = await g.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "owner_only");
    const owner = await g.req("/v1/oauth/start", {
      method: "POST",
      token: g.token({ role: "superadmin" }),
      body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: b.hash },
    });
    assert.equal(owner.status, 200, "the platform owner tests with their own Schwab app");
  } finally {
    await g.close();
  }
});

test("OAuth: start -> canonical hop -> approval -> canonical exchange -> claim on the user's host", async () => {
  const run = await runOAuthLogin(h, { start: schwabStart });
  assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
  const c = /** @type {any} */ (run.connection);
  assert.equal(c.status, "active");
  assert.equal(c.brokerId, "schwab");
  assert.equal(c.accounts.length, 2);
  assert.ok(c.sessionExpiresAt, "Schwab's 7-day end is on the connection");
  assert.equal(c.externalRef, undefined, "external_ref is never sent");
  const row = h.rows("broker_connections").find((x) => x.id === c.id);
  assert.equal(row?.external_ref, "sub:schwab-user-1");
  assert.equal(h.rows("broker_oauth_pending").length, 0, "the hand-off row is gone after the claim");

  // The hop names the workspace and who asked, for the confirmation page.
  assert.equal(run.hop?.json.workspaceName, "Desk One");
  assert.equal(run.hop?.json.requestedBy, "tr•••@example.com");
  const auth = new URL(run.hop?.json.redirectUrl);
  assert.equal(auth.searchParams.get("redirect_uri"), "http://localhost:3000/api/broker/callback/schwab");
  assert.equal(auth.searchParams.get("client_id"), "schwab-app-key-123");
  // Only the opaque ticket travels on to the user's host.
  assert.deepEqual(Object.keys(run.complete?.json).sort(), ["connectionId", "returnOrigin", "ticket"]);
  assert.equal(run.complete?.json.returnOrigin, "http://localhost:3000");
});

test("OAuth: the state is single use; a second callback with it is refused", async () => {
  const b = newBinding();
  const start = await h.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  const id = start.json.connectionId;
  const hop = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce } });
  const again = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce } });
  assert.equal(again.status, 409, "a second hop without the canonical cookie is refused");
  const approval = await simulateBrowserApproval(hop.json.redirectUrl);
  const body = { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [id]: b.nonce } };
  const first = await h.req("/v1/oauth/complete", { method: "POST", token: h.flowToken(), body });
  assert.equal(first.status, 200);
  const second = await h.req("/v1/oauth/complete", { method: "POST", token: h.flowToken(), body });
  assert.equal(second.status, 410);
  const claim = await h.req("/v1/connect/claim", { method: "POST", body: { connectionId: id, ticket: first.json.ticket, binding: b.nonce } });
  assert.equal(claim.status, 200);
  const replay = await h.req("/v1/connect/claim", { method: "POST", body: { connectionId: id, ticket: first.json.ticket, binding: b.nonce } });
  // Single use: this login merged into the earlier connection of the same Schwab user, so the row
  // the ticket named is gone (404); without a merge the ticket itself is unknown (410).
  assert.ok(replay.status === 404 || replay.status === 410, `the ticket is single use too (${replay.status})`);
});

test("OAuth takeover attempt: a victim approves an attacker's login without the canonical cookie", async () => {
  // The attacker starts in their own workspace and sends the broker's authorize link to a victim.
  const attacker = newBinding();
  const start = await h.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: attacker.hash } });
  const id = start.json.connectionId;
  const hop = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: attacker.nonce } });
  const approval = await simulateBrowserApproval(hop.json.redirectUrl);
  // The victim's browser reaches the canonical callback with no ns_oauth_<id> cookie (or another one).
  const r = await h.req("/v1/oauth/complete", {
    method: "POST",
    token: h.flowToken(),
    body: { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [id]: newBinding().nonce } },
  });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "binding");
  assert.equal(h.rows("broker_connections").find((x) => x.id === id), undefined, "the attacker's attempt is removed");
  assert.equal(h.rows("broker_secrets").find((x) => x.connection_id === id), undefined, "no token was exchanged or kept");
  // And the code can no longer be used by anyone.
  const late = await h.req("/v1/oauth/complete", {
    method: "POST",
    token: h.flowToken(),
    body: { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [id]: attacker.nonce } },
  });
  assert.equal(late.status, 410);
});

test("OAuth: the hop needs the binding; the claim needs the same workspace, user and binding", async () => {
  const b = newBinding();
  const start = await h.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  const id = start.json.connectionId;
  const wrongHop = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: newBinding().nonce } });
  assert.equal(wrongHop.status, 403, "a forwarded link opened in another browser");
  const preview = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce, preview: true } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json, { brokerId: "schwab", workspaceName: "Desk One", requestedBy: "tr•••@example.com" }, "names only, for the confirmation page");
  assert.equal(h.rows("broker_oauth_pending").find((p) => p.connection_id === id)?.stage, "start", "a preview uses nothing up");
  const run = await runOAuthLogin(h, { start: schwabStart, skipClaim: true });
  const cid = String(run.connectionId);
  const ticket = run.complete?.json.ticket;

  const otherWorkspace = await h.req("/v1/connect/claim", { method: "POST", token: h.token({ wid: randomUUID() }), body: { connectionId: cid, ticket, binding: run.binding.nonce } });
  assert.equal(otherWorkspace.status, 404);
  const otherUser = await h.req("/v1/connect/claim", { method: "POST", token: h.token({ sub: randomUUID() }), body: { connectionId: cid, ticket, binding: run.binding.nonce } });
  assert.equal(otherUser.status, 403);
  const badTicket = await h.req("/v1/connect/claim", { method: "POST", body: { connectionId: cid, ticket: newBinding().nonce, binding: run.binding.nonce } });
  assert.equal(badTicket.status, 410);
  const badBinding = await h.req("/v1/connect/claim", { method: "POST", body: { connectionId: cid, ticket, binding: newBinding().nonce } });
  assert.equal(badBinding.status, 403);
  assert.equal(h.rows("broker_connections").find((x) => x.id === cid), undefined, "a failed claim drops the new connection and its tokens");
});

test("OAuth: expired logins and refused approvals", async () => {
  const b = newBinding();
  const start = await h.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  const id = start.json.connectionId;
  const hop = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce } });
  const approval = await simulateBrowserApproval(hop.json.redirectUrl);
  h.advance(11 * 60_000);
  const late = await h.req("/v1/oauth/complete", { method: "POST", token: h.flowToken(), body: { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [id]: b.nonce } } });
  assert.equal(late.status, 410);
  assert.equal(h.rows("broker_connections").find((x) => x.id === id), undefined);

  schwab.state.deny = true;
  try {
    const denied = await runOAuthLogin(h, { start: schwabStart });
    assert.equal(denied.failedAt, "complete");
    assert.equal(denied.res?.status, 400);
    assert.equal(denied.res?.json.code, "oauth_denied");
  } finally {
    schwab.state.deny = false;
  }

  const bad = await h.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "javascript:alert(1)", bindingHash: b.hash } });
  assert.equal(bad.status, 400);
  const noBinding = await h.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000" } });
  assert.equal(noBinding.status, 400);
});

test("duplicate login: a second connect of the same broker login merges into the first", async () => {
  const g = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server: schwab })]] });
  try {
    const one = await runOAuthLogin(g, { start: schwabStart });
    const firstId = /** @type {any} */ (one.connection).id;
    const acct = g.rows("broker_accounts").find((a) => a.connection_id === firstId && a.external_id === "ACC-2");
    if (acct) acct.included = false;
    const two = await runOAuthLogin(g, { start: schwabStart });
    assert.equal(two.failedAt, undefined, JSON.stringify(two.res?.json));
    const merged = /** @type {any} */ (two.connection);
    assert.equal(merged.id, firstId, "the claim answers the existing connection");
    assert.equal(merged.accounts.find((/** @type {any} */ a) => a.label === "Roth IRA")?.included, false, "Included switches survive");
    assert.equal(g.rows("broker_connections").filter((x) => x.broker_id === "schwab").length, 1, "the new row is deleted");
    const secretRow = g.rows("broker_secrets").find((x) => x.connection_id === firstId);
    assert.ok(g.svc.secretBox.decrypt(firstId, /** @type {any} */ (secretRow)).accessToken, "the new tokens are sealed under the kept row");
  } finally {
    await g.close();
  }
});

test("OAuth renew: refresh first; when the login is gone, a new login on the same connection", async () => {
  const g = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server: schwab })]] });
  try {
    const run = await runOAuthLogin(g, { start: schwabStart });
    const id = /** @type {any} */ (run.connection).id;
    const ok = await g.req(`/v1/connections/${id}/renew`, { method: "POST" });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.next, undefined, "still logged in: nothing to do");

    g.advance(7 * 24 * 3_600_000 + 60_000); // past Schwab's 7 days
    const portfolio = await g.req("/v1/portfolio");
    assert.equal(portfolio.json.errors.length, 1, "the read reports the ended login");
    assert.equal(g.rows("broker_connections").find((x) => x.id === id)?.status, "expired");
    const noBody = await g.req(`/v1/connections/${id}/renew`, { method: "POST" });
    assert.equal(noBody.status, 400);
    assert.equal(noBody.json.code, "needs_login");

    const again = await runOAuthLogin(g, { connectionId: id, start: { brokerId: "schwab" } });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
    assert.equal(/** @type {any} */ (again.connection).id, id, "the same connection, with its accounts");
    assert.equal(/** @type {any} */ (again.connection).status, "active");
    const secret = g.svc.secretBox.decrypt(id, /** @type {any} */ (g.rows("broker_secrets").find((x) => x.connection_id === id)));
    assert.equal(secret.clientId, "schwab-app-key-123", "Reconnect reused the stored App Key");
  } finally {
    await g.close();
  }
});

test("aggregator: portal through the canonical callback, SUCCESS claimed, ABANDONED removed", async () => {
  const g = await createHarness({ env: { SNAPTRADE_CLIENT_ID: "snap-id", SNAPTRADE_CONSUMER_KEY: "snap-key" }, adapters: [["snaptrade", fakeAggregatorAdapter()]] });
  try {
    const b = newBinding();
    const start = await g.req("/v1/aggregator/start", { method: "POST", body: { brokerId: "fidelity", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(start.status, 200, start.text);
    const id = start.json.connectionId;
    const hop = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: id, binding: b.nonce } });
    assert.equal(hop.status, 200, hop.text);
    const portal = new URL(hop.json.redirectUrl);
    assert.equal(portal.searchParams.get("broker"), "FIDELITY", "the portal always names the broker");
    assert.equal(portal.searchParams.get("customRedirect"), `http://localhost:3000/api/broker/callback/snaptrade?cid=${id}`, "back to the canonical host");
    const done = await g.req("/v1/aggregator/complete", { method: "POST", token: g.flowToken(), body: { connectionId: id, status: "SUCCESS", authorizationId: "auth-123", binding: b.nonce } });
    assert.equal(done.status, 200, done.text);
    const claim = await g.req("/v1/connect/claim", { method: "POST", body: { connectionId: id, ticket: done.json.ticket, binding: b.nonce } });
    assert.equal(claim.status, 200, claim.text);
    assert.equal(claim.json.connection.status, "active");
    assert.ok(claim.json.connection.dataAsOf, "data_as_of from the aggregator");
    assert.equal(claim.json.connection.accounts.length, 1);
    assert.equal(g.rows("broker_connections").find((x) => x.id === id)?.external_ref, "auth-123");

    const b2 = newBinding();
    const s2 = await g.req("/v1/aggregator/start", { method: "POST", body: { brokerId: "robinhood", returnOrigin: "http://localhost:3000", bindingHash: b2.hash } });
    await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: s2.json.connectionId, binding: b2.nonce } });
    const abandoned = await g.req("/v1/aggregator/complete", { method: "POST", token: g.flowToken(), body: { connectionId: s2.json.connectionId, status: "ABANDONED", binding: b2.nonce } });
    assert.equal(abandoned.status, 400);
    assert.match(abandoned.json.error, /closed before it finished/);
    assert.equal(g.rows("broker_connections").find((x) => x.id === s2.json.connectionId), undefined);

    const vanguard = await g.req("/v1/aggregator/start", { method: "POST", body: { brokerId: "vanguard", returnOrigin: "http://localhost:3000", bindingHash: b2.hash } });
    assert.equal(vanguard.status, 400, "not a broker Nasscord connects");
  } finally {
    await g.close();
  }
});

test("POST /hooks/<name>: no service JWT, raw body to the adapter, its answer decides", async () => {
  const ok = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "x-test-signature": "ok", "content-type": "application/json" }, body: '{"event":"X"}' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { received: true });
  assert.equal(webhookCalls.at(-1)?.body, '{"event":"X"}');
  const bad = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", body: "{}" });
  assert.equal(bad.status, 401);
  const none = await fetch(`${h.api.url}/hooks/alpaca`, { method: "POST", body: "{}" });
  assert.equal(none.status, 404);
  const big = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "x-test-signature": "ok" }, body: "x".repeat(70_000) });
  assert.equal(big.status, 413);
});

test("no secret in logs, audit rows or answers (keys, client secrets, codes, tokens, nonces)", async () => {
  const run = await runOAuthLogin(h, { start: schwabStart });
  assert.equal(run.failedAt, undefined);
  const secrets = [
    KEY_LIVE,
    KEY_PAPER,
    "schwab-app-secret-456",
    String(run.approval?.code),
    String(run.approval?.state),
    String(run.complete?.json.ticket),
    run.binding.nonce,
    ...[...schwab.state.access.keys()],
    ...[...schwab.state.refresh.keys()],
  ];
  const logs = h.logLines.join("\n");
  const audit = JSON.stringify(h.rows("audit_events"));
  // The hop answers the broker URL with its state on purpose; everything else must not carry one.
  const answers = JSON.stringify([run.claim?.json, (await h.req("/v1/options")).json]);
  for (const s of secrets) {
    assert.ok(!logs.includes(s), "not in the log");
    assert.ok(!audit.includes(s), "not in audit_events");
    assert.ok(!answers.includes(s), "not in an answer");
  }
  const pending = JSON.stringify(h.rows("broker_oauth_pending"));
  assert.ok(!pending.includes(run.binding.nonce), "only hashes are stored");
  assert.ok(logs.includes('"msg":"api"'), "the log did capture the requests");
});

test("health counts every broker id and lists the built adapters", async () => {
  const r = await h.req("/v1/health", { token: h.token({ role: "superadmin", wid: null }) });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.connections).sort(), ["alpaca", "etrade", "fidelity", "ibkr", "moomoo", "public", "robinhood", "schwab", "tastytrade", "tradestation", "tradier", "webull"]);
  assert.ok(r.json.connections.schwab.active >= 1);
  assert.deepEqual(r.json.adapters.sort(), ["alpaca_key", "etrade_oauth1", "ibkr_gateway", "schwab_oauth", "snaptrade"]);
  assert.equal(sha256Hex("x").length, 64);
});

// ───────────────────────────────────────────── merges, Reconnect, gates, hop

/**
 * The steps after start or renew: hop, approval, canonical complete, and (unless skipped) claim.
 * @param {Awaited<ReturnType<typeof createHarness>>} g
 * @param {string} id
 * @param {{ nonce: string }} b
 */
async function finishLogin(g, id, b, brokerId = "schwab", claim = true) {
  const hop = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: id, binding: b.nonce } });
  assert.equal(hop.status, 200, hop.text);
  const approval = await simulateBrowserApproval(hop.json.redirectUrl);
  const complete = await g.req("/v1/oauth/complete", { method: "POST", token: g.flowToken(), body: { brokerId, state: approval.state, code: approval.code, bindings: { [id]: b.nonce } } });
  if (!claim || complete.status !== 200) return { complete };
  const done = await g.req("/v1/connect/claim", { method: "POST", body: { connectionId: id, ticket: complete.json.ticket, binding: b.nonce } });
  return { complete, claim: done };
}

/** A connection row written straight into the memory database. @param {Awaited<ReturnType<typeof createHarness>>} g @param {Record<string, unknown>} r */
function putRow(g, r) {
  const ts = new Date(g.now()).toISOString();
  const row = {
    id: randomUUID(),
    workspace_id: g.wid,
    user_id: g.user,
    status_detail: null,
    session_expires_at: null,
    last_ok_at: null,
    external_ref: null,
    data_as_of: null,
    scope: null,
    created_at: ts,
    updated_at: ts,
    ...r,
  };
  g.db.tables.set("broker_connections", [...g.rows("broker_connections"), row]);
  return row;
}

test("two methods of one broker: the newest login moves the connection to its method and replaces its secret whole", async () => {
  const alpaca = await startFakeOAuth2({ clientId: "alp-client", clientSecret: "alp-secret-xyz", sub: "alpaca-acct-x", accounts: [{ id: "alpaca-acct-x", name: "Individual", type: "individual" }] });
  const keysX = new Map([["live-secret-key-x001", /** @type {const} */ ({ account: "alpaca-acct-x", environment: "production" })]]);
  const g = await createHarness({
    env: { BROKER_AUDIENCE: "alpaca_oauth=all", ALPACA_CLIENT_ID: "alp-client", ALPACA_CLIENT_SECRET: "alp-secret-xyz" },
    adapters: [
      [
        "alpaca",
        (deps) => [
          /** @type {any} */ (fakeKeyAdapter({ keys: keysX })(deps)),
          /** @type {any} */ (fakeOAuthAdapter({ server: alpaca, method: "alpaca_oauth", brokerId: "alpaca", ref: (sub) => sub })(deps)),
        ],
      ],
    ],
  });
  try {
    const sealed = (/** @type {string} */ id) => g.svc.secretBox.decrypt(id, /** @type {any} */ (g.rows("broker_secrets").find((s) => s.connection_id === id)));
    const key = await g.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: "AKIDX001", secret: "live-secret-key-x001" } });
    assert.equal(key.status, 200, key.text);
    const id = key.json.connection.id;
    const acct = g.rows("broker_accounts").find((a) => a.connection_id === id);
    if (acct) acct.included = false;

    const oauth = await runOAuthLogin(g, { start: { brokerId: "alpaca", method: "alpaca_oauth", client: "platform" } });
    assert.equal(oauth.failedAt, undefined, JSON.stringify(oauth.res?.json));
    assert.equal(/** @type {any} */ (oauth.connection).id, id, "the claim answers the connection the login merged into");
    const rows = g.rows("broker_connections").filter((r) => r.broker_id === "alpaca");
    assert.equal(rows.length, 1, "one connection per broker login");
    assert.equal(rows[0].method, "alpaca_oauth", "the row moved to the method of the newest login");
    const afterOAuth = sealed(id);
    assert.ok(afterOAuth.accessToken, "the OAuth tokens are sealed under the kept row");
    assert.equal(afterOAuth.secretKey, undefined, "no key of the other method is left");
    assert.equal(afterOAuth.keyId, undefined);
    assert.equal(g.rows("broker_accounts").find((a) => a.connection_id === id)?.included, false, "Included switches survive");
    g.rows("broker_accounts").forEach((a) => (a.included = true));
    const read = await g.req("/v1/portfolio");
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.errors, [], "the moved row reads through its new adapter");
    assert.equal(read.json.accounts.length, 1);

    const back = await g.req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: "AKIDX001", secret: "live-secret-key-x001" } });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.connection.id, id);
    assert.equal(back.json.connection.method, "alpaca_key", "a key moves it back");
    const afterKey = sealed(id);
    assert.equal(afterKey.secretKey, "live-secret-key-x001");
    assert.equal(afterKey.accessToken, undefined, "no token of the other method is left");
  } finally {
    await g.close();
    await alpaca.close();
  }
});

test("a login merged into a connection mid-Reconnect clears that Reconnect's hand-off row; the sweep leaves it active", async () => {
  const server = await startFakeOAuth2({ clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456", sub: "schwab-merge-user" });
  const g = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server })]] });
  try {
    const a = await runOAuthLogin(g, { start: schwabStart });
    const idA = /** @type {any} */ (a.connection).id;
    g.advance(7 * 24 * 3_600_000 + 60_000);
    await g.req("/v1/portfolio");
    assert.equal(g.rows("broker_connections").find((x) => x.id === idA)?.status, "expired");
    // Reconnect pressed in one tab and left there, then a fresh Connect of the same login in another.
    const b = newBinding();
    const renew = await g.req(`/v1/connections/${idA}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.deepEqual(renew.json.next, { kind: "redirect" });
    const fresh = await runOAuthLogin(g, { start: schwabStart });
    assert.equal(fresh.failedAt, undefined, JSON.stringify(fresh.res?.json));
    assert.equal(/** @type {any} */ (fresh.connection).id, idA, "merged into A");
    assert.equal(g.rows("broker_oauth_pending").filter((p) => p.connection_id === idA).length, 0, "A's open Reconnect is gone");
    g.advance(11 * 60_000);
    await g.svc.scheduler.tick();
    const rowA = g.rows("broker_connections").find((x) => x.id === idA);
    assert.equal(rowA?.status, "active", "the sweep does not expire the login just merged");
    assert.equal(rowA?.status_detail, null);
    const left = await g.req(`/v1/connect/hop`, { method: "POST", token: g.flowToken(), body: { connectionId: idA, binding: b.nonce } });
    assert.equal(left.status, 410, "the abandoned tab's login link is dead");
  } finally {
    await g.close();
    await server.close();
  }
});

test("Reconnect inside the last 48 hours: a new login while the connection keeps working; unfinished, it stays as it was", async () => {
  const server = await startFakeOAuth2({ clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456", sub: "schwab-warn-user" });
  const g = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server })]] });
  try {
    const run = await runOAuthLogin(g, { start: schwabStart });
    const id = /** @type {any} */ (run.connection).id;
    const firstEnd = Date.parse(/** @type {any} */ (run.connection).sessionExpiresAt);
    g.advance(6 * 24 * 3_600_000); // 24 h left: the card says "Session ending soon"

    const b = newBinding();
    const renew = await g.req(`/v1/connections/${id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(renew.status, 200, renew.text);
    assert.deepEqual(renew.json.next, { kind: "redirect" }, "a new login, although the refresh still works");
    assert.equal(renew.json.connection.status, "active", "the connection stays active during the login");
    assert.equal(g.rows("broker_oauth_pending").find((p) => p.connection_id === id)?.stage, "start");
    const during = await g.req("/v1/portfolio");
    assert.deepEqual(during.json.errors, [], "reads go on while the user logs in again");

    const done = await finishLogin(g, id, b);
    assert.equal(done.claim?.status, 200, done.claim?.text);
    assert.equal(done.claim?.json.connection.id, id);
    const newEnd = Date.parse(done.claim?.json.connection.sessionExpiresAt);
    assert.ok(newEnd - firstEnd > 5.9 * 24 * 3_600_000, "the 7 days start again from this login");

    // The same again, left unfinished after the exchange: the connection keeps its (same-login) session.
    g.advance(6 * 24 * 3_600_000);
    const b2 = newBinding();
    await g.req(`/v1/connections/${id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b2.hash } });
    const half = await finishLogin(g, id, b2, "schwab", false);
    assert.equal(half.complete.status, 200);
    g.advance(6 * 60_000);
    await g.svc.scheduler.tick();
    const row = g.rows("broker_connections").find((x) => x.id === id);
    assert.equal(row?.status, "active", "an unclaimed Reconnect of a working session leaves it working");
    assert.equal(row?.status_detail, null);
    assert.ok(Date.parse(String(row?.session_expires_at)) - g.now() > 6.9 * 24 * 3_600_000, "the row's end follows the tokens it reads with");
    assert.equal(g.rows("broker_oauth_pending").length, 0);
    const after = await g.req("/v1/portfolio");
    assert.deepEqual(after.json.errors, []);
    assert.ok(!g.rows("audit_events").some((x) => x.action === "broker.session.expired" && String(x.target).includes(id)), "nothing expired");
  } finally {
    await g.close();
    await server.close();
  }
});

test("Reconnect with a different broker login is refused: a working session keeps its tokens, an ended one stays expired", async () => {
  const server = await startFakeOAuth2({ clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456", sub: "schwab-login-a" });
  const g = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server })]] });
  try {
    const run = await runOAuthLogin(g, { start: schwabStart });
    const id = /** @type {any} */ (run.connection).id;
    const sealed = () => g.svc.secretBox.decrypt(id, /** @type {any} */ (g.rows("broker_secrets").find((x) => x.connection_id === id)));
    const tokenBefore = sealed().accessToken;

    server.state.sub = "schwab-login-b"; // the user logs in with another Schwab login
    const b = newBinding();
    await g.req(`/v1/connections/${id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    const live = await finishLogin(g, id, b);
    assert.equal(live.complete.status, 409);
    assert.equal(live.complete.json.code, "other_account");
    let row = g.rows("broker_connections").find((x) => x.id === id);
    assert.equal(row?.status, "active");
    assert.equal(row?.external_ref, "sub:schwab-login-a", "the identity did not change");
    assert.equal(sealed().accessToken, tokenBefore, "the previous tokens are back");
    assert.deepEqual((await g.req("/v1/portfolio")).json.errors, [], "and still read login A");

    g.advance(7 * 24 * 3_600_000 + 60_000);
    await g.req("/v1/portfolio");
    const b2 = newBinding();
    await g.req(`/v1/connections/${id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b2.hash } });
    const ended = await finishLogin(g, id, b2);
    assert.equal(ended.complete.status, 409);
    row = g.rows("broker_connections").find((x) => x.id === id);
    assert.equal(row?.status, "expired");
    assert.match(String(row?.status_detail), /different Schwab login/);
    assert.equal(sealed().accessToken, undefined, "login B's tokens are dropped");
    assert.ok(g.rows("broker_accounts").some((a) => a.connection_id === id), "the accounts and switches stay");
  } finally {
    await g.close();
    await server.close();
  }
});

test("Reconnect passes the audience gate again: a trader cannot log in to an owner-only method; a refresh stays open", async () => {
  const g = await createHarness({ env: { BROKER_AUDIENCE: "etrade_oauth1=off" }, adapters: [["schwab", fakeOAuthAdapter({ server: schwab })]] });
  try {
    const owner = g.token({ role: "superadmin" });
    const run = await runOAuthLogin(g, { start: schwabStart, token: owner });
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = /** @type {any} */ (run.connection).id;
    const refresh = await g.req(`/v1/connections/${id}/renew`, { method: "POST" });
    assert.equal(refresh.status, 200, "a trader's refresh of the session is not a new login");
    const b = newBinding();
    const login = await g.req(`/v1/connections/${id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(login.status, 403);
    assert.equal(login.json.code, "owner_only");
    assert.equal(g.rows("broker_oauth_pending").length, 0, "no login was started");

    // IBKR and E*TRADE renew through their own adapters: gated before anything starts.
    const etrade = putRow(g, { broker_id: "etrade", method: "etrade_oauth1", environment: "production", status: "expired" });
    const r = await g.req(`/v1/connections/${etrade.id}/renew`, { method: "POST" });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "off");
  } finally {
    await g.close();
  }
});

test("hop: a failed broker link puts the hand-off back; a second hop needs repeat and makes the old state useless", async () => {
  const failPortal = { count: 1 };
  const g = await createHarness({
    env: { SNAPTRADE_CLIENT_ID: "snap-id", SNAPTRADE_CONSUMER_KEY: "snap-key", BROKER_AUDIENCE: "schwab_oauth=all" },
    adapters: [
      ["snaptrade", fakeAggregatorAdapter({ failPortal })],
      ["schwab", fakeOAuthAdapter({ server: schwab, pkce: true })],
    ],
  });
  try {
    const b = newBinding();
    const start = await g.req("/v1/aggregator/start", { method: "POST", body: { brokerId: "fidelity", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    const id = start.json.connectionId;
    const failed = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: id, binding: b.nonce } });
    assert.equal(failed.status, 502);
    assert.equal(g.rows("broker_oauth_pending").find((p) => p.connection_id === id)?.stage, "start", "put back");
    const retry = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: id, binding: b.nonce } });
    assert.equal(retry.status, 200, retry.text);

    // OAuth: the PKCE verifier cannot be saved (a database hiccup) -> put back, then it works.
    const o = newBinding();
    const os = await g.req("/v1/oauth/start", { method: "POST", body: { ...schwabStart, returnOrigin: "http://localhost:3000", bindingHash: o.hash } });
    const oid = os.json.connectionId;
    g.db.failNext.set("broker_secrets", new Error("database unavailable"));
    const down = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: oid, binding: o.nonce } });
    assert.equal(down.status, 500);
    const row = g.rows("broker_oauth_pending").find((p) => p.connection_id === oid);
    assert.equal(row?.stage, "start");
    assert.equal(row?.state_hash, null);
    const first = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: oid, binding: o.nonce } });
    assert.equal(first.status, 200, first.text);
    const again = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: oid, binding: o.nonce } });
    assert.equal(again.status, 409, "without the canonical cookie a second hop is refused");
    const repeat = await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: oid, binding: o.nonce, repeat: true } });
    assert.equal(repeat.status, 200, "Open login again on the canonical host");
    const oldState = new URL(first.json.redirectUrl).searchParams.get("state");
    assert.notEqual(new URL(repeat.json.redirectUrl).searchParams.get("state"), oldState);
    const stale = await g.req("/v1/oauth/complete", { method: "POST", token: g.flowToken(), body: { brokerId: "schwab", state: oldState, code: "x", bindings: { [oid]: o.nonce } } });
    assert.equal(stale.status, 410, "the earlier state is dead");
    const approval = await simulateBrowserApproval(repeat.json.redirectUrl);
    const ok = await g.req("/v1/oauth/complete", { method: "POST", token: g.flowToken(), body: { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [oid]: o.nonce } } });
    assert.equal(ok.status, 200, ok.text);
  } finally {
    await g.close();
  }
});

test("aggregator: a completion that names no login is refused and the attempt removed", async () => {
  const g = await createHarness({
    env: { SNAPTRADE_CLIENT_ID: "snap-id", SNAPTRADE_CONSUMER_KEY: "snap-key" },
    adapters: [["snaptrade", (deps) => ({ .../** @type {any} */ (fakeAggregatorAdapter()(deps)), aggregatorComplete: async () => ({ externalRef: "  " }) })]],
  });
  try {
    const b = newBinding();
    const start = await g.req("/v1/aggregator/start", { method: "POST", body: { brokerId: "robinhood", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    const id = start.json.connectionId;
    await g.req("/v1/connect/hop", { method: "POST", token: g.flowToken(), body: { connectionId: id, binding: b.nonce } });
    const done = await g.req("/v1/aggregator/complete", { method: "POST", token: g.flowToken(), body: { connectionId: id, status: "SUCCESS", authorizationId: "auth-9", binding: b.nonce } });
    assert.equal(done.status, 500);
    assert.equal(g.rows("broker_connections").find((x) => x.id === id), undefined);
    assert.equal(g.rows("broker_oauth_pending").length, 0);
  } finally {
    await g.close();
  }
});

test("an account list that failed right after connecting loads on the next read, also for adapters that are not lazy", async () => {
  const server = await startFakeOAuth2({ clientId: "schwab-app-key-123", clientSecret: "schwab-app-secret-456", sub: "schwab-late-accounts" });
  const g = await createHarness({ env: { BROKER_AUDIENCE: "schwab_oauth=all" }, adapters: [["schwab", fakeOAuthAdapter({ server, lazyAccounts: false })]] });
  try {
    server.state.failAccounts = 1;
    const run = await runOAuthLogin(g, { start: schwabStart });
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const c = /** @type {any} */ (run.connection);
    assert.equal(c.status, "active");
    assert.equal(c.accounts.length, 0);
    assert.match(String(c.statusDetail), /has not sent the account list yet/);
    const read = await g.req("/v1/portfolio");
    assert.deepEqual(read.json.errors, []);
    assert.equal(read.json.accounts.length, 2, "loaded on this read");
    assert.equal(g.rows("broker_connections").find((x) => x.id === c.id)?.status_detail, null, "the note is gone");
  } finally {
    await g.close();
    await server.close();
  }
});

test("production: a sandbox connection left from before is neither read nor renewed", async () => {
  const g = await createHarness({
    env: { NODE_ENV: "production", PUBLIC_LOGIN_URL: "https://login.example.com", OAUTH_CALLBACK_BASE: "https://nasscord.example.com", SUPABASE_URL: "https://x.supabase.co" },
  });
  try {
    const row = putRow(g, { broker_id: "etrade", method: "etrade_oauth1", environment: "sandbox", status: "active" });
    const ts = new Date(g.now()).toISOString();
    g.db.tables.set("broker_accounts", [
      { id: randomUUID(), connection_id: row.id, workspace_id: g.wid, broker_id: "etrade", external_id: "SB1", display_number: "•••1", label: "Sandbox", type: "individual", included: true, created_at: ts },
    ]);
    const read = await g.req("/v1/portfolio");
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.accounts, []);
    assert.equal(read.json.errors.length, 1);
    assert.match(read.json.errors[0].message, /sandbox connection with sample data/);
    const renew = await g.req(`/v1/connections/${row.id}/renew`, { method: "POST" });
    assert.equal(renew.status, 400);
    assert.equal(renew.json.code, "sandbox_refused");
  } finally {
    await g.close();
  }
});
