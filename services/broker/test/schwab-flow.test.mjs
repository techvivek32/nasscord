import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed } from "../src/http.mjs";
import { loginRef } from "../src/oauth2.mjs";
import { createBrokerService } from "../src/server.mjs";
import { createSchwabClient, SCHWAB_READ_ALLOW } from "../src/schwab/client.mjs";
import { createAdapter, SCHWAB_DETAIL, schwabDeadline, schwabTokenError } from "../src/schwab/index.mjs";
import { testConfig } from "./helpers/common.mjs";
import { simulateBrowserApproval } from "./helpers/fake-oauth2.mjs";
import { defaultAccounts, startFakeSchwab } from "./helpers/fake-schwab.mjs";
import { createHarness, newBinding, runOAuthLogin } from "./helpers/harness.mjs";

const DAY = 24 * 3_600_000;
const APP = { key: "SchwabAppKeyQwErTyUiOpAsDfGhJkLz", secret: "SchwabSecret0123", callback: "http://localhost:3000/api/broker/callback/schwab" };
const START = { brokerId: "schwab", clientId: APP.key, clientSecret: APP.secret };
const MARGIN = "12345678";
const IRA = "87654321";

/**
 * The real Schwab adapter in the service, pointed at a fake Schwab that shares the harness clock.
 * @param {{ login?: Partial<import("./helpers/fake-schwab.mjs").FakeLogin>, env?: Record<string, string> }} [o]
 */
async function setup(o = {}) {
  /** @type {Awaited<ReturnType<typeof createHarness>> | null} */
  let harness = null;
  const fake = await startFakeSchwab({ now: () => (harness ? harness.now() : Date.now()), apps: [APP], login: o.login });
  const h = await createHarness({
    env: { BROKER_URL_OVERRIDES: JSON.stringify({ schwab: { api: fake.url } }), ...(o.env ?? {}) },
    adapters: [["schwab", createAdapter]],
  });
  harness = h;
  const owner = () => h.token({ role: "superadmin" });
  /** @param {{ connectionId?: string, skipClaim?: boolean }} [x] */
  const connect = (x = {}) => runOAuthLogin(h, { start: x.connectionId ? { brokerId: "schwab" } : START, token: owner(), ...x });
  /** @param {string} id */
  const row = (id) => h.rows("broker_connections").find((r) => r.id === id);
  /** @param {string} id */
  const sealed = (id) => {
    const s = h.rows("broker_secrets").find((x) => x.connection_id === id);
    return s ? h.svc.secretBox.decrypt(id, /** @type {any} */ (s)) : null;
  };
  /** @param {string} n account number -> broker_accounts.id */
  const accountId = (n) => /** @type {string} */ (h.rows("broker_accounts").find((a) => a.external_id === n)?.id);
  /** Service calls to the fake that are neither the token endpoint nor an allowed read. */
  const outsideAllowlist = () =>
    fake.serviceCalls().filter((c) => !(c.method === "POST" && c.path === "/v1/oauth/token") && !isAllowed([...SCHWAB_READ_ALLOW], c.method, c.path));
  return {
    h,
    fake,
    owner,
    connect,
    row,
    sealed,
    accountId,
    outsideAllowlist,
    close: async () => {
      await h.close();
      await fake.close();
    },
  };
}

test("options: the user's own Schwab app is the owner's alone; the Commercial client waits for its env keys", async () => {
  const s = await setup();
  try {
    /** @param {any} r @param {string} client */
    const pick = (r, client) => r.json.options.find((/** @type {any} */ x) => x.brokerId === "schwab" && x.method === "schwab_oauth" && x.client === client);
    const forTrader = await s.h.req("/v1/options");
    const user = pick(forTrader, "user");
    assert.equal(user.built, true);
    assert.equal(user.flow, "oauth2_user_app");
    assert.equal(user.reasonCode, "owner_only", "Schwab defines an Individual app as your own app for your own account");
    assert.deepEqual(user.environments, ["production"], "no sandbox or paper: only the user's own accounts");
    assert.equal(user.callbackUrl, APP.callback);
    const forOwner = await s.h.req("/v1/options", { token: s.owner() });
    assert.equal(pick(forOwner, "user").available, true);
    assert.equal(pick(forOwner, "platform").reasonCode, "not_configured", "SCHWAB_CLIENT_ID is not set");
    assert.match(pick(forOwner, "platform").reason, /SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are not set/);

    const b = newBinding();
    const refused = await s.h.req("/v1/oauth/start", { method: "POST", body: { ...START, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "owner_only");
    assert.equal(s.fake.state.calls.length, 0, "nothing reached Schwab");
  } finally {
    await s.close();
  }
});

test("connect: Schwab's authorize URL, the code exchanged at the callback, accounts from the claim", async () => {
  const s = await setup();
  try {
    const t0 = s.h.now();
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const u = new URL(String(run.hop?.json.redirectUrl));
    assert.equal(`${u.origin}${u.pathname}`, `${s.fake.url}/v1/oauth/authorize`);
    assert.equal(u.searchParams.get("client_id"), APP.key);
    assert.equal(u.searchParams.get("redirect_uri"), APP.callback, "exactly the callback registered on the app");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.ok(u.searchParams.get("state"));
    assert.equal(u.searchParams.get("scope"), null);
    assert.ok(String(run.approval?.code).endsWith("@"), "Schwab's code arrives URL-encoded and is exchanged decoded");
    // The callback must match the app's registration exactly; a trailing slash is Schwab's error page.
    const slash = new URL(u);
    slash.searchParams.set("redirect_uri", `${APP.callback}/`);
    const refused = await fetch(slash, { redirect: "manual" });
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /We are unable to complete your request/);
    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.grant, c.status]),
      [["authorization_code", 200]],
    );

    const c = /** @type {any} */ (run.connection);
    assert.equal(c.status, "active");
    assert.equal(c.method, "schwab_oauth");
    assert.equal(c.environment, "production");
    const end = Date.parse(c.sessionExpiresAt);
    assert.ok(Math.abs(end - (t0 + 7 * DAY)) < 60_000, "the session ends 7 days after the browser login");
    assert.deepEqual(
      c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
      [
        ["Trading", "123•••78", "margin", true],
        ["Roth Contributory IRA", "876•••21", "roth", true],
      ],
    );
    assert.equal(s.row(c.id)?.external_ref, "sub:schwab-login-1", "the id_token sub names the login (critique D2)");
    assert.equal(s.row(c.id)?.scope, "api");

    const secret = /** @type {any} */ (s.sealed(c.id));
    assert.equal(secret.client, "user");
    assert.equal(secret.clientId, APP.key);
    assert.equal(secret.clientSecret, APP.secret);
    assert.equal(secret.redirectUri, APP.callback);
    assert.deepEqual(secret.extra.hashes, { [MARGIN]: s.fake.hashOf(MARGIN), [IRA]: s.fake.hashOf(IRA) }, "the hash map lives in the sealed secret");
    const raw = JSON.stringify(s.h.rows("broker_secrets"));
    for (const v of [APP.secret, secret.accessToken, secret.refreshToken, s.fake.hashOf(MARGIN)]) assert.ok(!raw.includes(v), "sealed, never plain");
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("reads: balances, positions, orders (both time bounds, hashes only) and executions with commissions", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const margin = s.accountId(MARGIN);
    const ira = s.accountId(IRA);

    const p = await s.h.req("/v1/portfolio", { token: s.owner() });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.errors, []);
    assert.deepEqual(
      p.json.accounts.find((/** @type {any} */ a) => a.accountId === margin),
      { accountId: margin, netLiq: 25_340.5, buyingPower: 40_000, cash: 10_000.25, dayPnl: -7.5, currency: "USD" },
    );
    assert.deepEqual(
      p.json.accounts.find((/** @type {any} */ a) => a.accountId === ira),
      { accountId: ira, netLiq: 5_000, buyingPower: 4_900, cash: 5_000, currency: "USD" },
      "a cash account's buying power is cashAvailableForTrading; no positions, so no day P&L is reported",
    );
    assert.equal(p.json.positions.length, 2, "a zero position is left out");
    const aapl = p.json.positions.find((/** @type {any} */ x) => x.symbol === "AAPL");
    assert.deepEqual(
      { qty: aapl.qty, avgCost: aapl.avgCost, last: aapl.last, marketValue: aapl.marketValue, unrealizedPnl: aapl.unrealizedPnl, dayPnl: aapl.dayPnl, secType: aapl.secType, brokerId: aapl.brokerId },
      { qty: 10, avgCost: 150.25, last: 151.5, marketValue: 1_515, unrealizedPnl: 12.5, dayPnl: 12.5, secType: "STK", brokerId: "schwab" },
    );
    const spy = p.json.positions.find((/** @type {any} */ x) => x.secType === "OPT");
    assert.deepEqual({ symbol: spy.symbol, qty: spy.qty, last: spy.last, marketValue: spy.marketValue, unrealizedPnl: spy.unrealizedPnl }, {
      symbol: "SPY 261218C00600000",
      qty: -2,
      last: 3.5,
      marketValue: -700,
      unrealizedPnl: -80,
    });

    const o = await s.h.req("/v1/orders", { token: s.owner() });
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    /** @param {string} id */
    const order = (id) => o.json.orders.find((/** @type {any} */ x) => x.brokerRef === id);
    assert.equal(order("999"), undefined, "an order outside the 60-day window is not asked for");
    assert.deepEqual(
      (({ type, side, qty, price, tif, status, filledQty, avgFill, outsideRth }) => ({ type, side, qty, price, tif, status, filledQty, avgFill, outsideRth }))(order("1000001")),
      { type: "LMT", side: "BUY", qty: 10, price: 150, tif: "DAY", status: "filled", filledQty: 10, avgFill: 149.96, outsideRth: false },
    );
    assert.deepEqual(
      (({ type, side, price, tif, status, outsideRth }) => ({ type, side, price, tif, status, outsideRth }))(order("1000002")),
      { type: "STP", side: "SELL", price: 140, tif: "GTC", status: "working", outsideRth: true },
    );
    assert.equal(order("1000003").type, "TRAIL");
    assert.equal(order("1000003").trailPct, 2.5);
    assert.equal(order("1000003").parentId, order("1000002").id, "a child order points at its parent");
    assert.equal(order("1000004").side, "SELL");
    assert.equal(order("1000004").accountId, margin);

    const ordersCalls = s.fake.state.calls.filter((c) => c.path.endsWith("/orders"));
    assert.ok(ordersCalls.length >= 2);
    for (const c of ordersCalls) {
      assert.ok(c.path === `/trader/v1/accounts/${s.fake.hashOf(MARGIN)}/orders` || c.path === `/trader/v1/accounts/${s.fake.hashOf(IRA)}/orders`, "hash, never the account number");
      const from = Date.parse(c.query.fromEnteredTime);
      const to = Date.parse(c.query.toEnteredTime);
      assert.ok(Number.isFinite(from) && Number.isFinite(to), "both time bounds are always sent");
      assert.ok(Math.abs(to - from - 60 * DAY) < 1_000);
    }

    const before = s.fake.state.calls.filter((c) => c.path.endsWith("/orders")).length;
    const e = await s.h.req("/v1/executions", { token: s.owner() });
    assert.equal(e.status, 200, e.text);
    assert.equal(s.fake.state.calls.filter((c) => c.path.endsWith("/orders")).length, before, "executions reuse the orders just read");
    const fills = e.json.executions;
    assert.equal(fills.length, 3);
    const buy4 = fills.find((/** @type {any} */ f) => f.qty === 4);
    assert.deepEqual({ side: buy4.side, price: buy4.price, commission: buy4.commission, net: buy4.net, provisional: buy4.provisional }, {
      side: "BUY",
      price: 149.9,
      commission: 0.26,
      net: -599.86,
      provisional: undefined,
    });
    assert.equal(fills.find((/** @type {any} */ f) => f.qty === 6).commission, 0.39, "the order's fees spread over its fills by quantity");
    const opt = fills.find((/** @type {any} */ f) => f.symbol.startsWith("SPY"));
    assert.deepEqual({ side: opt.side, qty: opt.qty, net: opt.net, commission: opt.commission, provisional: opt.provisional }, {
      side: "SELL",
      qty: 2,
      net: 700,
      commission: 0,
      provisional: true,
    });
    const tx = s.fake.state.calls.filter((c) => c.path.endsWith("/transactions"));
    assert.ok(tx.length >= 1);
    for (const c of tx) assert.ok(c.query.types === "TRADE" && c.query.startDate && c.query.endDate);

    // The user unticked the IRA at Schwab: the portfolio says so; orders skip it, the margin account still reads.
    s.fake.state.login.accounts.splice(1);
    s.h.advance(61_000);
    const p2 = await s.h.req("/v1/portfolio", { token: s.owner() });
    assert.deepEqual(p2.json.errors, [{ connectionId: run.connectionId, message: SCHWAB_DETAIL.missingAccount("876•••21") }]);
    const o2 = await s.h.req("/v1/orders", { token: s.owner() });
    assert.deepEqual(o2.json.errors, []);
    assert.ok(o2.json.orders.length > 0 && o2.json.orders.every((/** @type {any} */ x) => x.accountId === margin));

    assert.deepEqual(s.outsideAllowlist(), [], "zero calls outside the read allowlist and the token endpoint");
  } finally {
    await s.close();
  }
});

test("refresh: lazily after 25 minutes; a refused token gets one refresh; a dead grant ends the login", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const refreshes = () => s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token").length;

    s.h.advance(24 * 60_000);
    assert.equal((await s.h.req("/v1/portfolio", { token: s.owner() })).status, 200);
    assert.equal(refreshes(), 0, "no refresh while more than 5 minutes are left");
    s.h.advance(2 * 60_000);
    assert.deepEqual((await s.h.req("/v1/portfolio", { token: s.owner() })).json.errors, []);
    assert.equal(refreshes(), 1, "one refresh with Basic auth once under 5 minutes are left");

    // Schwab invalidated the access token early: one refresh, the read goes on.
    s.fake.revokeAccess();
    s.h.advance(11_000);
    const again = await s.h.req("/v1/portfolio", { token: s.owner() });
    assert.deepEqual(again.json.errors, []);
    assert.equal(refreshes(), 2);
    assert.equal(s.row(id)?.status, "active");

    // Schwab refuses the refresh (refresh_token_authentication_error): the login ends.
    s.fake.revokeAccess();
    s.fake.state.failRefreshWith = "refresh_token_authentication_error";
    s.h.advance(11_000);
    const dead = await s.h.req("/v1/portfolio", { token: s.owner() });
    assert.equal(dead.json.errors[0]?.message, SCHWAB_DETAIL.ended);
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, SCHWAB_DETAIL.ended);
    const kept = /** @type {any} */ (s.sealed(id));
    assert.equal(kept.accessToken, undefined, "tokens are dropped");
    assert.equal(kept.clientId, APP.key, "the App Key and Secret stay for Reconnect");
    assert.equal(s.h.svc.oauth2.circuitOpen("schwab"), false, "one user's ended login pauses nobody");
  } finally {
    await s.close();
  }
});

test("concurrent refresh: reads and the sweep at the same moment refresh once; a restarted service reads from the database", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const refreshes = () => s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token").length;
    s.h.advance(26 * 60_000);
    const [, p, o] = await Promise.all([s.h.svc.scheduler.tick(), s.h.req("/v1/portfolio", { token: s.owner() }), s.h.req("/v1/orders", { token: s.owner() })]);
    assert.deepEqual(p.json.errors, []);
    assert.deepEqual(o.json.errors, []);
    assert.equal(refreshes(), 1, "one refresh under the token lock, shared by everyone waiting");

    // A new process: no in-memory token, secret or hash map; everything comes back from the sealed row.
    const again = createBrokerService(
      testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist", BROKER_URL_OVERRIDES: JSON.stringify({ schwab: { api: s.fake.url } }) }),
      { db: s.h.db, now: s.h.now, packages: [], adapters: [["schwab", createAdapter]] },
    );
    const claims = /** @type {any} */ ({ sub: s.h.user, wid: s.h.wid, role: "superadmin" });
    const numbers = s.fake.state.calls.filter((c) => c.path === "/trader/v1/accounts/accountNumbers").length;
    const out = await again.service.orders(claims);
    assert.deepEqual(out.errors, []);
    assert.ok(out.orders.some((x) => x.brokerRef === "1000001"));
    assert.equal(s.fake.state.calls.filter((c) => c.path === "/trader/v1/accounts/accountNumbers").length, numbers, "the hashes came from the sealed secret");
    assert.equal(refreshes(), 1, "the access token saved by the first process is still good");
    const mine = new Set(s.h.rows("broker_accounts").filter((a) => a.connection_id === run.connectionId).map((a) => a.id));
    assert.ok(out.orders.every((x) => mine.has(x.accountId)));
  } finally {
    await s.close();
  }
});

test("the weekly login: expiring by day 5, expired at day 7, Reconnect reuses the stored app", async () => {
  const s = await setup();
  try {
    const t0 = s.h.now();
    const run = await s.connect();
    const id = String(run.connectionId);
    const end = Date.parse(String(s.row(id)?.session_expires_at));

    s.h.advance(5 * DAY + 60_000);
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "active", "inside the last 48 hours the app shows 'Session ending soon'");
    assert.equal(Date.parse(String(s.row(id)?.session_expires_at)), end, "refreshing never moves Schwab's 7-day end");
    assert.ok(s.fake.state.tokenCalls.some((c) => c.grant === "refresh_token" && c.status === 200), "the sweep kept the access token fresh");

    s.h.advance(t0 + 7 * DAY + 60_000 - s.h.now());
    const calls = s.fake.state.tokenCalls.length;
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, SCHWAB_DETAIL.weekly);
    assert.equal(s.fake.state.tokenCalls.length, calls, "past the deadline no refresh is even tried");
    assert.ok(s.h.rows("audit_events").some((a) => a.action === "broker.session.expired" && String(a.target).includes(id)));
    const reads = await s.h.req("/v1/portfolio", { token: s.owner() });
    assert.deepEqual(reads.json.accounts, [], "an expired connection is not read");

    // Reconnect: a new browser login through the hop, with the App Key and Secret already stored.
    const t1 = s.h.now();
    const again = await s.connect({ connectionId: id });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
    assert.equal(new URL(String(again.hop?.json.redirectUrl)).searchParams.get("client_id"), APP.key);
    const c = /** @type {any} */ (again.connection);
    assert.equal(c.id, id);
    assert.equal(c.status, "active");
    assert.ok(Math.abs(Date.parse(c.sessionExpiresAt) - (t1 + 7 * DAY)) < 60_000, "a new 7-day end");
    assert.equal(c.accounts.length, 2, "the accounts and their switches stay");
  } finally {
    await s.close();
  }
});

test("a Reconnect pressed inside the last 48 hours keeps reading and moves the end", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    s.h.advance(6 * DAY);
    const t1 = s.h.now();
    const renewed = await s.connect({ connectionId: id });
    assert.equal(renewed.failedAt, undefined, JSON.stringify(renewed.res?.json));
    assert.ok(Math.abs(Date.parse(/** @type {any} */ (renewed.connection).sessionExpiresAt) - (t1 + 7 * DAY)) < 60_000);
    s.h.advance(2 * DAY);
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "active", "the old 7-day mark has passed; the new login holds");
    assert.deepEqual((await s.h.req("/v1/portfolio", { token: s.owner() })).json.errors, []);
  } finally {
    await s.close();
  }
});

test("external_ref without an id_token: the App Key and account numbers; the same login twice merges", async () => {
  const s = await setup({ login: { sub: null } });
  try {
    const first = await s.connect();
    assert.equal(first.failedAt, undefined, JSON.stringify(first.res?.json));
    const id = String(first.connectionId);
    assert.equal(s.row(id)?.external_ref, loginRef({ key: APP.key, members: [IRA, MARGIN] }));
    assert.match(String(s.row(id)?.external_ref), /^h:[0-9a-f]{64}$/, "neither the App Key nor an account number appears");

    // The same login connected again in the same workspace: merged into the first connection.
    const acct = s.h.rows("broker_accounts").find((a) => a.connection_id === id && a.external_id === IRA);
    if (acct) acct.included = false;
    const second = await s.connect();
    assert.equal(second.failedAt, undefined, JSON.stringify(second.res?.json));
    assert.equal(/** @type {any} */ (second.connection).id, id);
    assert.equal(s.h.rows("broker_connections").filter((r) => r.broker_id === "schwab" && r.status !== "disconnected").length, 1);
    assert.equal(s.h.rows("broker_accounts").find((a) => a.connection_id === id && a.external_id === IRA)?.included, false, "switches survive");
    assert.deepEqual((await s.h.req("/v1/portfolio", { token: s.owner() })).json.errors, [], "the merged connection reads with the new tokens");
  } finally {
    await s.close();
  }
});

test("Reconnect: another Schwab login is refused; the same accounts with a changed sub stay this login", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const original = s.fake.state.login;

    // A login that shares no account with this connection: refused, and the working session stays.
    s.fake.state.login = { sub: "someone-else", accounts: defaultAccounts().map((a, i) => ({ ...a, number: `5555000${i}` })) };
    const refused = await s.connect({ connectionId: id });
    assert.equal(refused.failedAt, "complete");
    assert.equal(refused.res?.status, 409);
    assert.equal(refused.res?.json.code, "other_account");
    assert.equal(s.row(id)?.status, "active");
    s.h.advance(11_000);
    assert.deepEqual((await s.h.req("/v1/portfolio", { token: s.owner() })).json.errors, [], "the previous tokens were put back");

    // Schwab's id_token is not documented as stable: the same accounts through the same app with
    // another sub keep the connection's login rather than refusing the weekly login.
    s.fake.state.login = { ...original, sub: "rotated-sub" };
    const again = await s.connect({ connectionId: id });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
    assert.equal(s.row(id)?.external_ref, "sub:schwab-login-1");
  } finally {
    await s.close();
  }
});

test("Reconnect with another sub: kept only when the login cannot be someone else's", async () => {
  const [margin, ira] = defaultAccounts();
  const A = { ...margin, number: "11111111" };
  const B = { ...ira, number: "22222222" };
  const C = { ...ira, number: "33333333" };
  const s = await setup({ login: { sub: "login-A", accounts: [A] } });
  try {
    const first = await s.connect();
    assert.equal(first.failedAt, undefined, JSON.stringify(first.res?.json));
    const c1 = String(first.connectionId);
    s.fake.state.login = { sub: "login-B", accounts: [B] };
    const second = await s.connect();
    assert.equal(second.failedAt, undefined, JSON.stringify(second.res?.json));
    const c2 = String(second.connectionId);
    assert.notEqual(c1, c2);
    /** @param {{ connectionId: string }} x */
    const refused = async (x) => {
      const run = await s.connect(x);
      assert.equal(run.failedAt, "complete");
      assert.equal(run.res?.status, 409);
      assert.equal(run.res?.json.code, "other_account");
      assert.equal(s.row(c1)?.external_ref, "sub:login-A");
      assert.equal(s.row(c1)?.status, "active", "the working session stays");
    };

    // Login B now also sees A's account; C1 is Reconnected signed in as B, the login C2 holds.
    s.fake.state.login = { sub: "login-B", accounts: [A, B] };
    await refused({ connectionId: c1 });
    // A login never connected here that shares A's account and sees one more (a joint holder's login).
    s.fake.state.login = { sub: "login-C", accounts: [A, C] };
    await refused({ connectionId: c1 });

    // Another live connection already holds A's account too: the new sub could be that login.
    const rowA = /** @type {any} */ (s.h.rows("broker_accounts").find((a) => a.connection_id === c1 && a.external_id === A.number));
    const copy = { ...rowA, id: "99999999-0000-4000-8000-000000000001", connection_id: c2 };
    s.h.rows("broker_accounts").push(copy);
    s.fake.state.login = { sub: "login-A-rotated", accounts: [A] };
    await refused({ connectionId: c1 });
    s.h.rows("broker_accounts").splice(s.h.rows("broker_accounts").indexOf(copy), 1);

    // The same account, nobody else holds it or the new name: the weekly login with a rotated sub.
    const kept = await s.connect({ connectionId: c1 });
    assert.equal(kept.failedAt, undefined, JSON.stringify(kept.res?.json));
    assert.equal(s.row(c1)?.external_ref, "sub:login-A");

    const pairs = s.h
      .rows("broker_accounts")
      .map((a) => `${a.connection_id === c1 ? "C1" : a.connection_id === c2 ? "C2" : "?"}:${a.external_id}`)
      .sort();
    assert.deepEqual(pairs, [`C1:${A.number}`, `C2:${B.number}`], "no account sits in two connections");
    s.h.advance(61_000);
    const p = await s.h.req("/v1/portfolio", { token: s.owner() });
    assert.deepEqual(p.json.errors, []);
    assert.equal(p.json.accounts.length, 2, "each account counted once");
  } finally {
    await s.close();
  }
});

test("refused logins: wrong binding, a replayed state, a code older than 30 s, no shared account", async () => {
  const s = await setup();
  try {
    // The canonical callback without the starter's cookie: 403 and Schwab is never asked for a token.
    const b = newBinding();
    const start = await s.h.req("/v1/oauth/start", { method: "POST", token: s.owner(), body: { ...START, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    const id = start.json.connectionId;
    const hop = await s.h.req("/v1/connect/hop", { method: "POST", token: s.h.flowToken(), body: { connectionId: id, binding: b.nonce } });
    const approval = await simulateBrowserApproval(hop.json.redirectUrl);
    const wrong = await s.h.req("/v1/oauth/complete", {
      method: "POST",
      token: s.h.flowToken(),
      body: { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [id]: newBinding().nonce } },
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.code, "binding");
    assert.equal(s.fake.state.tokenCalls.length, 0, "no token call");
    const replay = await s.h.req("/v1/oauth/complete", {
      method: "POST",
      token: s.h.flowToken(),
      body: { brokerId: "schwab", state: approval.state, code: approval.code, bindings: { [id]: b.nonce } },
    });
    assert.equal(replay.status, 410, "the state is single use");

    // Schwab's code lives about 30 seconds.
    const b2 = newBinding();
    const start2 = await s.h.req("/v1/oauth/start", { method: "POST", token: s.owner(), body: { ...START, returnOrigin: "http://localhost:3000", bindingHash: b2.hash } });
    const id2 = start2.json.connectionId;
    const hop2 = await s.h.req("/v1/connect/hop", { method: "POST", token: s.h.flowToken(), body: { connectionId: id2, binding: b2.nonce } });
    const approval2 = await simulateBrowserApproval(hop2.json.redirectUrl);
    s.h.advance(31_000);
    const late = await s.h.req("/v1/oauth/complete", {
      method: "POST",
      token: s.h.flowToken(),
      body: { brokerId: "schwab", state: approval2.state, code: approval2.code, bindings: { [id2]: b2.nonce } },
    });
    assert.equal(late.status, 400);
    assert.equal(late.json.code, "oauth_code_rejected");
    assert.equal(s.row(id2), undefined, "the attempt is removed");

    // The user ticked no account on Schwab's page.
    s.fake.state.login = { sub: "empty-login", accounts: [] };
    const empty = await s.connect();
    assert.equal(empty.failedAt, "complete");
    assert.equal(empty.res?.status, 400);
    assert.equal(empty.res?.json.code, "schwab_no_accounts");
    assert.equal(empty.res?.json.error, SCHWAB_DETAIL.noAccounts);
    assert.equal(s.h.rows("broker_connections").filter((r) => r.broker_id === "schwab").length, 0);
  } finally {
    await s.close();
  }
});

test("account hashes: re-read when Schwab refuses one, and after a day", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const numbersCalls = () => s.fake.state.calls.filter((c) => c.path === "/trader/v1/accounts/accountNumbers").length;
    const before = numbersCalls();
    s.fake.state.hashSalt = "v2"; // Schwab re-keyed the hashes
    s.h.advance(61_000);
    const o = await s.h.req("/v1/orders", { token: s.owner() });
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    assert.ok(o.json.orders.some((/** @type {any} */ x) => x.brokerRef === "1000001"));
    assert.equal(numbersCalls(), before + 1, "one fresh read of the hashes for both accounts");
    assert.equal(/** @type {any} */ (s.sealed(id)).extra.hashes[MARGIN], s.fake.hashOf(MARGIN), "the new map is saved, sealed");

    s.h.advance(DAY);
    await s.h.req("/v1/orders", { token: s.owner() });
    assert.equal(numbersCalls(), before + 2, "read again after 24 hours");
  } finally {
    await s.close();
  }
});

test("read only: the allowlist holds five GETs; order calls are refused before the network", async () => {
  const allow = [...SCHWAB_READ_ALLOW];
  const hash = "E1B5C7D9A0B2C4D6E8F0A1B3C5D7E9F1A2B4C6D8E0F1A3B5C7D9E1F3A5B7C9D1";
  for (const path of [
    "/trader/v1/accounts/accountNumbers",
    "/trader/v1/accounts",
    `/trader/v1/accounts/${hash}/orders`,
    `/trader/v1/accounts/${hash}/transactions`,
    "/trader/v1/userPreference",
  ]) {
    assert.equal(isAllowed(allow, "GET", path), true, path);
  }
  for (const [method, path] of [
    ["POST", `/trader/v1/accounts/${hash}/orders`],
    ["POST", `/trader/v1/accounts/${hash}/previewOrder`],
    ["PUT", `/trader/v1/accounts/${hash}/orders/123`],
    ["DELETE", `/trader/v1/accounts/${hash}/orders/123`],
    ["GET", `/trader/v1/accounts/${hash}/orders/123`],
    ["GET", "/trader/v1/orders"],
    ["GET", `/trader/v1/accounts/${hash}`],
    ["GET", `/trader/v1/accounts/${hash}/../orders`],
    ["GET", `/trader/v1/accounts/${hash}%2forders`],
    ["GET", "/marketdata/v1/quotes"],
    ["POST", "/v1/oauth/token"],
    ["POST", "/trader/v1/accounts"],
  ]) {
    assert.equal(isAllowed(allow, method, path), false, `${method} ${path}`);
  }

  let fetched = 0;
  /** @type {typeof fetch} */
  const countingFetch = async () => {
    fetched += 1;
    return new Response("{}", { status: 200 });
  };
  const client = createSchwabClient({ http: (o) => createBrokerHttp({ ...o, fetch: countingFetch }), base: "https://api.schwabapi.com" });
  const http = client.httpFor("schwab:app:test");
  await assert.rejects(http.request("POST", `/trader/v1/accounts/${hash}/orders`, { json: { orderType: "MARKET" } }), ReadOnlyViolation);
  await assert.rejects(http.request("DELETE", `/trader/v1/accounts/${hash}/orders/1`), ReadOnlyViolation);
  await assert.rejects(http.request("POST", `/trader/v1/accounts/${hash}/previewOrder`), ReadOnlyViolation);
  assert.equal(fetched, 0, "nothing reached the network");
  await http.get("/trader/v1/accounts");
  assert.equal(fetched, 1);
  assert.throws(() => client.orders({ token: "t", bucket: "b" }, "../orders", 0, 1), /letters and digits/);
});

test("no secret in logs, audit rows, connection rows or answers; Disconnect calls nobody", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const answers = [JSON.stringify(run.claim?.json), JSON.stringify(run.complete?.json), JSON.stringify(run.hop?.json)];
    for (const path of ["/v1/portfolio", "/v1/orders", "/v1/executions", `/v1/connections/${id}`]) answers.push((await s.h.req(path, { token: s.owner() })).text);
    s.fake.revokeAccess();
    s.h.advance(31 * 60_000);
    answers.push((await s.h.req("/v1/portfolio", { token: s.owner() })).text);
    await s.h.svc.scheduler.tick();

    const secret = /** @type {any} */ (s.sealed(id));
    const needles = [APP.secret, ...s.fake.state.issued, s.fake.hashOf(MARGIN), s.fake.hashOf(IRA), "customer-id-not-for-storage", secret.refreshToken];
    const haystacks = {
      logs: s.h.logLines.join("\n"),
      audit: JSON.stringify(s.h.rows("audit_events")),
      connections: JSON.stringify(s.h.rows("broker_connections")),
      accounts: JSON.stringify(s.h.rows("broker_accounts")),
      answers: answers.join("\n"),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const n of needles) assert.ok(!text.includes(n), `${where} holds a secret value`);
    }
    for (const n of [MARGIN, IRA]) {
      assert.ok(!haystacks.logs.includes(n), "no account number in the logs");
      const at = haystacks.answers.indexOf(n);
      assert.ok(at === -1, `account numbers are only shown masked: ${haystacks.answers.slice(Math.max(0, at - 120), at + 40)}`);
    }

    const calls = s.fake.state.calls.length;
    const del = await s.h.req(`/v1/connections/${id}`, { method: "DELETE", token: s.owner() });
    assert.equal(del.status, 200);
    assert.equal(s.fake.state.calls.length, calls, "Schwab has no revoke for these apps; nothing is called");
    assert.equal(s.sealed(id), null, "the App Secret and tokens are deleted");
    assert.equal(s.row(id)?.status, "disconnected");
  } finally {
    await s.close();
  }
});

test("helpers: Schwab's token errors and the 7-day deadline", () => {
  assert.equal(schwabTokenError(400, { error: "invalid_client" }), "invalid_client");
  assert.equal(schwabTokenError(400, { error: "refresh_token_authentication_error" }), "invalid_grant");
  assert.equal(schwabTokenError(400, { error: "invalid_grant" }), "invalid_grant");
  assert.equal(schwabTokenError(401, {}), "invalid_client");
  assert.equal(schwabTokenError(500, { error: "server_error" }), "other");

  const issued = Date.parse("2026-11-01T10:00:00Z");
  assert.equal(schwabDeadline({ client: "user", redirectUri: "x", refreshIssuedAt: new Date(issued).toISOString() }), issued + 7 * DAY);
  assert.equal(
    schwabDeadline({ client: "user", redirectUri: "x", refreshIssuedAt: new Date(issued).toISOString(), refreshExpiresAt: new Date(issued + 90 * DAY).toISOString() }),
    issued + 7 * DAY,
    "never later than 7 days after the login, whatever the token answer said",
  );
  assert.equal(schwabDeadline({ client: "user", redirectUri: "x" }), null);
});
