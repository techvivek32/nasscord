import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed } from "../src/http.mjs";
import { createWindowCounter } from "../src/limits.mjs";
import { createLogger } from "../src/log.mjs";
import { createBrokerService } from "../src/server.mjs";
import { createWebullClient, splitByYear, WEBULL_HOSTS, WEBULL_RATES, WEBULL_READ_ALLOW, WEBULL_USER_BUDGET } from "../src/webull/client.mjs";
import { createAdapter, createWebullAdapter, WEBULL_DETAIL, webullDeadline, webullTokenError } from "../src/webull/index.mjs";
import { mergeOrderGroups, occSymbol, webullAccountType, webullExecutions, webullOrderStatus, webullOrderType } from "../src/webull/mapping.mjs";
import { testConfig } from "./helpers/common.mjs";
import { simulateBrowserApproval } from "./helpers/fake-oauth2.mjs";
import { defaultLogin, startFakeWebull } from "./helpers/fake-webull.mjs";
import { createHarness, newBinding, runOAuthLogin } from "./helpers/harness.mjs";

/**
 * The Webull Connect adapter end to end: the service (memory database, real registry, flows, OAuth
 * engine and scheduler) against a fake Webull that checks Webull's HMAC signature on every token
 * call, rotates refresh tokens, expires codes after 60 seconds, answers 429 past 2 calls per 2
 * seconds per endpoint (600 a minute for cash activities) and refuses only with the three errors
 * Webull documents for its token endpoint (401 UNAUTHORIZED, 417 INVALID_PARAMETER, 500).
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CALLBACK = "http://localhost:3000/api/broker/callback/webull";
const IDENTITY = "a0920c03dcba35a56a33a7f4a0df6275";

/** One margin account with one position and no orders: the quick login for session tests. */
function oneAccount() {
  const d = defaultLogin();
  return {
    ...d,
    accounts: [d.accounts[0]],
    positions: { MARGINACCT01: [d.positions.MARGINACCT01[0]] },
    openOrders: {},
    history: {},
    activities: {},
  };
}

/**
 * `n` margin accounts like the default one (the same positions, orders and activities each).
 * @param {number} n
 * @returns {import("./helpers/fake-webull.mjs").FakeLogin}
 */
function manyAccounts(n) {
  const d = defaultLogin();
  /** @type {import("./helpers/fake-webull.mjs").FakeLogin} */
  const login = { identityId: d.identityId, accounts: [], balances: {}, positions: {}, openOrders: {}, history: {}, activities: {} };
  for (let i = 0; i < n; i++) {
    const id = `ACCT${String(i).padStart(4, "0")}`;
    login.accounts.push({ ...d.accounts[0], account_id: id, account_number: `5MW${i}0000`, account_label: `Account ${i}` });
    login.balances[id] = d.balances.MARGINACCT01;
    login.positions[id] = d.positions.MARGINACCT01;
    login.openOrders[id] = d.openOrders.MARGINACCT01;
    login.history[id] = d.history.MARGINACCT01;
    login.activities[id] = (now) => d.activities.MARGINACCT01(now).map((a) => ({ ...a, account_id: id }));
  }
  return login;
}

/** @param {number} ms */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The real Webull adapter in the service, against a fake Webull on the harness clock.
 * @param {{
 *   login?: Partial<import("./helpers/fake-webull.mjs").FakeLogin>,
 *   env?: Record<string, string>,
 *   credentials?: boolean,
 *   factory?: import("../src/adapter-types.mjs").AdapterFactory,
 *   fakeMode?: "fixed" | "sliding",
 *   at?: number,
 *   pageSize?: number,
 * }} [o]
 *   at: move the clock to this instant before anything happens. pageSize: order groups and
 *   activities per page of the fake (default 2).
 */
async function setup(o = {}) {
  /** @type {Awaited<ReturnType<typeof createHarness>> | null} */
  let harness = null;
  const fake = await startFakeWebull({ now: () => (harness ? harness.now() : Date.now()), login: o.login, refreshMode: o.fakeMode, pageSize: o.pageSize });
  /** @type {Record<string, string>} */
  const creds =
    o.credentials === false
      ? {}
      : { WEBULL_CLIENT_ID: fake.app.clientId, WEBULL_CLIENT_SECRET: fake.app.clientSecret, WEBULL_APP_KEY: fake.app.appKey, WEBULL_APP_SECRET: fake.app.appSecret };
  const env = { BROKER_URL_OVERRIDES: JSON.stringify({ webull: { api: fake.url } }), ...creds, ...(o.env ?? {}) };
  const h = await createHarness({ env, adapters: [["webull", o.factory ?? createAdapter]] });
  harness = h;
  if (o.at) h.advance(o.at - h.now());
  /** Every reply body (none may hold a token, code or secret). @type {string[]} */
  const replies = [];
  const owner = () => h.token({ role: "superadmin" });
  /** @param {string} path @param {{ method?: string, body?: unknown, token?: string }} [x] */
  const req = async (path, x = {}) => {
    const r = await h.req(path, { token: owner(), ...x });
    replies.push(r.text);
    return r;
  };
  /** @param {{ connectionId?: string, start?: Record<string, unknown> }} [x] */
  const collecting = {
    ...h,
    req: async (/** @type {string} */ p, /** @type {any} */ y) => {
      const res = await h.req(p, y);
      replies.push(res.text);
      return res;
    },
  };
  const connect = async (x = {}) => /** @type {any} */ (await runOAuthLogin(collecting, { token: owner(), ...x, start: { brokerId: "webull", ...(x.start ?? {}) } }));
  /** @param {string} id */
  const row = (id) => h.rows("broker_connections").find((r) => r.id === id);
  /** @param {string} id */
  const sealed = (id) => /** @type {any} */ (h.svc.oauth2.loadSecret(id, { fresh: true }));
  /** @param {string} external */
  const accountId = (external) => /** @type {string} */ (h.rows("broker_accounts").find((a) => a.external_id === external)?.id);
  /** Service calls that are neither the token endpoint nor an allowed read. */
  const outsideAllowlist = () => fake.serviceCalls().filter((c) => !(c.method === "POST" && c.path === "/oauth2/tokens/create") && !isAllowed([...WEBULL_READ_ALLOW], c.method, c.path));
  return {
    h,
    fake,
    owner,
    req,
    replies,
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

/** @param {any} r */
const webullOption = (r) => r.json.options.find((/** @type {any} */ x) => x.brokerId === "webull" && x.method === "webull_oauth");

test("options: off until Webull's credentials exist, then the owner's alone; one Webull service per server", async () => {
  const bare = await setup({ credentials: false });
  try {
    const forOwner = webullOption(await bare.req("/v1/options"));
    assert.equal(forOwner.built, true);
    assert.equal(forOwner.flow, "oauth2_platform");
    assert.equal(forOwner.reasonCode, "not_configured");
    assert.match(forOwner.reason, /WEBULL_CLIENT_ID, WEBULL_CLIENT_SECRET, WEBULL_APP_KEY and WEBULL_APP_SECRET are not set/);
    const forTrader = webullOption(await bare.h.req("/v1/options"));
    assert.equal(forTrader.available, false);
    assert.doesNotMatch(forTrader.reason, /WEBULL_/, "a trader is not told the server's variable names");
  } finally {
    await bare.close();
  }

  const s = await setup();
  try {
    const forTrader = webullOption(await s.h.req("/v1/options"));
    assert.equal(forTrader.reasonCode, "owner_only", "the Connect client stays with the owner until Webull approves Nasscord");
    const forOwner = webullOption(await s.req("/v1/options"));
    assert.equal(forOwner.available, true);
    assert.deepEqual(forOwner.environments, ["production"], "live only: the sandbox is not offered next to it");
    assert.equal(forOwner.callbackUrl, CALLBACK);
    assert.equal(forOwner.client, "platform");

    const b = newBinding();
    const refused = await s.h.req("/v1/oauth/start", { method: "POST", body: { brokerId: "webull", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "owner_only");
    const userApp = await s.req("/v1/oauth/start", { method: "POST", body: { brokerId: "webull", clientId: "my-own-app", clientSecret: "my-own-secret", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(userApp.status, 400, "no bring-your-own Webull app");
    assert.equal(s.fake.state.calls.length, 0, "nothing reached Webull");
  } finally {
    await s.close();
  }

  const dev = await setup({ env: { WEBULL_ENV: "sandbox" } });
  try {
    assert.deepEqual(webullOption(await dev.req("/v1/options")).environments, ["sandbox"], "a developer server set to Webull's sandbox offers only that");
  } finally {
    await dev.close();
  }
});

test("connect: Webull's authorize URL, a signed code exchange that never sends the app secret, identity_id names the login", async () => {
  const s = await setup();
  try {
    const t0 = s.h.now();
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const u = new URL(String(run.hop.json.redirectUrl));
    assert.equal(`${u.origin}${u.pathname}`, `${s.fake.url}/oauth2/auth-codes/get`);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("client_id"), s.fake.app.clientId);
    assert.equal(u.searchParams.get("redirect_uri"), CALLBACK);
    assert.equal(u.searchParams.get("scope"), "user:trade:wr");
    assert.ok(u.searchParams.get("state"));
    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.grant, c.status]),
      [["authorization_code", 200]],
      "the fake checked the HMAC signature, timestamp and nonce",
    );

    const c = run.connection;
    assert.equal(c.status, "active");
    assert.equal(c.method, "webull_oauth");
    assert.equal(c.environment, "production");
    assert.ok(Math.abs(Date.parse(c.sessionExpiresAt) - (t0 + 15 * DAY)) < MIN, "Reconnect by: 15 days after the approval");
    assert.deepEqual(
      c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
      [
        ["Individual Margin", "5MW•••45", "margin", true],
        ["Roth IRA", "5MW•••90", "roth", true],
        ["Events Cash", "5MW•••80", "individual", true],
      ],
    );
    const r = s.row(c.id);
    assert.equal(r?.external_ref, IDENTITY);
    assert.equal(r?.scope, "user:trade:wr");

    const secret = await s.sealed(c.id);
    assert.equal(secret.client, "platform");
    assert.equal(secret.clientId, undefined, "Nasscord's client stays in the service env");
    assert.equal(secret.clientSecret, undefined);
    assert.equal(secret.redirectUri, CALLBACK);
    assert.ok(secret.refreshToken && secret.accessToken);
    const raw = JSON.stringify(s.h.rows("broker_secrets"));
    for (const v of [secret.accessToken, secret.refreshToken, s.fake.app.clientSecret, s.fake.app.appSecret]) assert.ok(!raw.includes(v), "sealed, never plain");

    assert.ok(s.fake.state.calls.every((x) => !x.appSecretHeader), "never an x-app-secret header");
    assert.ok(s.fake.state.calls.filter((x) => x.path === "/oauth2/tokens/create").every((x) => x.signed));
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("a code older than 60 seconds is refused and the attempt is removed", async () => {
  const s = await setup();
  try {
    const b = newBinding();
    const start = await s.req("/v1/oauth/start", { method: "POST", body: { brokerId: "webull", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(start.status, 200, start.text);
    const id = start.json.connectionId;
    const hop = await s.h.req("/v1/connect/hop", { method: "POST", token: s.h.flowToken(), body: { connectionId: id, binding: b.nonce } });
    assert.equal(hop.status, 200, hop.text);
    const approval = await simulateBrowserApproval(hop.json.redirectUrl);
    s.h.advance(61_000);
    const complete = await s.h.req("/v1/oauth/complete", {
      method: "POST",
      token: s.h.flowToken(),
      body: { brokerId: "webull", state: approval.state, code: approval.code, bindings: { [id]: b.nonce } },
    });
    s.replies.push(complete.text);
    assert.equal(complete.status, 400);
    assert.equal(complete.json.code, "oauth_code_rejected");
    assert.match(complete.json.error, /Webull did not accept the login code/);
    assert.equal(s.row(id), undefined, "a login that never connected leaves nothing behind");
    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.status, c.code, c.why]),
      [[417, "INVALID_PARAMETER", "CODE_EXPIRED"]],
      "Webull's documented refusal of a parameter: the code",
    );
    assert.equal(s.h.svc.oauth2.circuitOpen("webull"), false, "one user's late code never pauses Webull logins");
  } finally {
    await s.close();
  }
});

test("reads: balances, positions, orders (groups flattened, open and history merged) and executions, without one 429", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const margin = s.accountId("MARGINACCT01");
    const roth = s.accountId("ROTHACCT0002");
    const events = s.accountId("EVENTSACCT03");

    const p = await s.req("/v1/portfolio");
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.errors, []);
    /** @param {string} id */
    const acct = (id) => p.json.accounts.find((/** @type {any} */ a) => a.accountId === id);
    assert.deepEqual(acct(margin), { accountId: margin, netLiq: 25_340.5, buyingPower: 40_000, cash: 10_000.25, dayPnl: -7.5, currency: "USD" });
    assert.deepEqual(acct(roth), { accountId: roth, netLiq: 5_000, buyingPower: 4_900, cash: 5_000, dayPnl: 0, currency: "USD" });
    assert.deepEqual(acct(events), { accountId: events, buyingPower: 50, dayPnl: 1.25, currency: "USD" }, "Webull's empty cash and net value are not reported, never 0");
    /** @param {string} sym */
    const pos = (sym) => p.json.positions.find((/** @type {any} */ x) => x.symbol === sym);
    assert.equal(p.json.positions.length, 4, "a zero position is left out");
    assert.deepEqual(
      (({ qty, avgCost, last, marketValue, unrealizedPnl, secType, brokerId, accountId }) => ({ qty, avgCost, last, marketValue, unrealizedPnl, secType, brokerId, accountId }))(pos("AAPL")),
      { qty: 10, avgCost: 150.25, last: 151.5, marketValue: 1_515, unrealizedPnl: 12.5, secType: "STK", brokerId: "webull", accountId: margin },
    );
    assert.deepEqual((({ qty, marketValue, secType }) => ({ qty, marketValue, secType }))(pos("SPY 261218C00600000")), { qty: -2, marketValue: -700, secType: "OPT" });
    assert.equal(pos("TSLA Vertical").marketValue, undefined, "a spread's market value is not made up from its legs");
    assert.equal(pos("FEDRATE Yes").secType, "EVENT");

    const o = await s.req("/v1/orders");
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    /** @param {string} ref */
    const order = (ref) => o.json.orders.filter((/** @type {any} */ x) => x.brokerRef === ref);
    assert.equal(order("ORD-MASTER").length, 1, "an order in both lists appears once");
    assert.deepEqual(
      (({ type, side, qty, price, tif, status, filledQty, avgFill, outsideRth }) => ({ type, side, qty, price, tif, status, filledQty, avgFill, outsideRth }))(order("ORD-MASTER")[0]),
      { type: "LMT", side: "BUY", qty: 5, price: 150, tif: "DAY", status: "filled", filledQty: 5, avgFill: 149.9, outsideRth: false },
    );
    assert.equal(order("ORD-TP")[0].parentId, order("ORD-MASTER")[0].id, "the take-profit points at its master");
    assert.equal(order("ORD-TP")[0].outsideRth, true);
    assert.equal(order("ORD-TP")[0].tif, "GTC");
    assert.deepEqual((({ type, price, parentId }) => ({ type, price, parentId }))(order("ORD-SL")[0]), { type: "STP", price: 140, parentId: order("ORD-MASTER")[0].id });
    assert.deepEqual((({ type, trailPct, status }) => ({ type, trailPct, status }))(order("ORD-TRAIL")[0]), { type: "TRAIL", trailPct: 2.5, status: "submitted" });
    assert.deepEqual((({ symbol, side }) => ({ symbol, side }))(order("ORD-OPT")[0]), { symbol: "SPY 261218C00600000", side: "SELL" });
    assert.equal(order("ORD-CANCELLED")[0].status, "cancelled");
    assert.equal(order("ORD-OLD").length, 0, "only 30 days of history are asked for");
    const history = s.fake.state.calls.filter((c) => c.path === "/trading/orders/historical-orders/list" && c.query.account_id === "MARGINACCT01");
    assert.ok(history.length >= 2, "history is read page by page");
    for (const c of history) assert.equal(Date.parse(c.query.end_time) - Date.parse(c.query.start_time), 30 * DAY);

    const e = await s.req("/v1/executions");
    assert.equal(e.status, 200, e.text);
    assert.deepEqual(e.json.errors, []);
    /** @param {string} sym */
    const fill = (sym) => e.json.executions.find((/** @type {any} */ x) => x.symbol === sym);
    assert.deepEqual(
      (({ side, qty, price, commission, net, provisional }) => ({ side, qty, price, commission, net, provisional }))(fill("AAPL")),
      { side: "BUY", qty: 5, price: 149.9, commission: 0.05, net: -749.55, provisional: undefined },
      "the commission comes from the matching TRADE cash activity",
    );
    assert.deepEqual(
      (({ side, qty, commission, net, provisional }) => ({ side, qty, commission, net, provisional }))(fill("SPY 261218C00600000")),
      { side: "SELL", qty: 2, commission: 0, net: 700, provisional: true },
      "no matching activity: the fill is shown, provisional",
    );
    assert.equal(e.json.executions.length, 2, "only filled orders are fills");
    const cash = s.fake.state.calls.filter((c) => c.path === "/trading/activities/cash-activities/list");
    assert.ok(cash.length > 0 && cash.every((c) => c.query.activity_types === "TRADE"));

    assert.deepEqual(s.fake.state.limited, [], "one account after another on each endpoint: Webull never had to say 429");
    assert.deepEqual(s.outsideAllowlist(), []);
    assert.ok(s.fake.serviceCalls().filter((c) => c.path.startsWith("/trading/")).every((c) => c.method === "GET" && !c.signed && c.bearer));
  } finally {
    await s.close();
  }
});

test("rotation: Webull's new refresh token is saved before use, the old one is dead, a restarted service carries on, and the 15-day end stays put", async () => {
  const s = await setup({ login: oneAccount() });
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const before = await s.sealed(id);
    const end0 = s.row(id)?.session_expires_at;

    s.h.advance(29 * MIN);
    const p = await s.req("/v1/portfolio");
    assert.deepEqual(p.json.errors, []);
    const after = await s.sealed(id);
    assert.notEqual(after.refreshToken, before.refreshToken, "Webull issued a new refresh token");
    assert.equal(s.fake.state.refresh.has(before.refreshToken), false, "the old refresh token died with the answer");
    assert.equal(s.fake.state.refresh.has(after.refreshToken), true, "the stored one is the live one");
    const lastRead = s.fake.state.calls.filter((c) => c.path.startsWith("/trading/")).at(-1);
    assert.equal(lastRead?.bearer, after.accessToken, "reads use the access token that was saved");
    assert.equal(s.row(id)?.session_expires_at, end0, "Reconnect by does not move with a refresh (15 days from the approval)");
    assert.equal(after.refreshExpiresAt, before.refreshExpiresAt);

    // A new process: no in-memory token or secret; everything comes back from the sealed row.
    const again = createBrokerService(
      testConfig({
        IBKR_GATEWAY_BUNDLE: "does-not-exist",
        BROKER_URL_OVERRIDES: JSON.stringify({ webull: { api: s.fake.url } }),
        WEBULL_CLIENT_ID: s.fake.app.clientId,
        WEBULL_CLIENT_SECRET: s.fake.app.clientSecret,
        WEBULL_APP_KEY: s.fake.app.appKey,
        WEBULL_APP_SECRET: s.fake.app.appSecret,
      }),
      { db: s.h.db, now: s.h.now, packages: [], adapters: [["webull", createAdapter]], log: createLogger({ level: "debug", write: (line) => s.h.logLines.push(line) }) },
    );
    s.h.advance(29 * MIN);
    const claims = /** @type {any} */ ({ sub: s.h.user, wid: s.h.wid, role: "superadmin" });
    const out = await again.service.portfolio(claims);
    assert.deepEqual(out.errors, []);
    assert.equal(out.positions.length, 1);
    const third = await s.sealed(id);
    assert.notEqual(third.refreshToken, after.refreshToken, "the restarted service refreshed with the token the first one saved");
    assert.equal(s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token" && c.status === 200).length, 2);
  } finally {
    await s.close();
  }
});

test("a refreshed pair that cannot be saved is never used; the next refresh finds the old token dead and asks for a new approval", async () => {
  const s = await setup({ login: oneAccount() });
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const issuedBefore = s.fake.state.issued.length;
    s.h.advance(29 * MIN);
    s.h.db.failNext.set("broker_secrets", new Error("database unavailable"));
    const p = await s.req("/v1/portfolio");
    assert.equal(p.json.errors.length, 1, "the read fails instead of using an unsaved token");
    const unsaved = s.fake.state.issued.slice(issuedBefore).filter((t) => t.startsWith("WBAT."));
    assert.equal(unsaved.length, 1);
    assert.ok(!s.fake.state.calls.some((c) => c.bearer === unsaved[0]), "the access token of the unsaved pair never reached Webull");

    const next = await s.req("/v1/portfolio");
    assert.equal(next.json.errors.length, 1);
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, WEBULL_DETAIL.ended);
    assert.deepEqual(
      [s.fake.state.tokenCalls.at(-1)?.status, s.fake.state.tokenCalls.at(-1)?.code, s.fake.state.tokenCalls.at(-1)?.why],
      [417, "INVALID_PARAMETER", "REFRESH_TOKEN_DEAD"],
      "a 417 on a refresh is the refresh token refused: that login ends",
    );
  } finally {
    await s.close();
  }
});

test("the 15-day mark: Reconnect by holds, the sweep expires the login on time, Reconnect approves again on the same connection", async () => {
  const s = await setup({ login: oneAccount() });
  try {
    const t0 = s.h.now();
    const run = await s.connect();
    const id = String(run.connectionId);
    const end = Date.parse(String(s.row(id)?.session_expires_at));
    assert.ok(Math.abs(end - (t0 + 15 * DAY)) < MIN);
    // The user switched the account off in Nasscord (the app writes this column).
    const accountRow = /** @type {any} */ (s.h.rows("broker_accounts").find((x) => x.external_id === "MARGINACCT01"));
    accountRow.included = false;

    s.h.advance(14 * DAY);
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "active", "fixed mode: the sweep leaves a live login alone");
    const g = await s.req(`/v1/connections/${id}`);
    assert.equal(g.status, 200);
    assert.equal(await s.h.svc.registry.get("webull_oauth")?.refresh?.(/** @type {any} */ (s.row(id))), "skipped");
    const token = await s.h.svc.oauth2.accessToken(/** @type {any} */ (s.row(id)), /** @type {any} */ (s.h.svc.registry.get("webull_oauth")?.oauthProfile?.("production", "platform")));
    assert.ok(token, "a refresh on day 14 still works");
    assert.equal(Date.parse(String(s.row(id)?.session_expires_at)), end, "refreshing on day 14 keeps the date");

    s.h.advance(DAY + MIN);
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, WEBULL_DETAIL.period);
    const dropped = await s.sealed(id);
    assert.equal(dropped.refreshToken, undefined, "the tokens are dropped at the mark");
    assert.equal(dropped.accessToken, undefined);

    const again = await s.connect({ connectionId: id });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
    assert.equal(again.connection.id, id, "the same connection");
    assert.equal(again.connection.status, "active");
    assert.ok(Math.abs(Date.parse(again.connection.sessionExpiresAt) - (s.h.now() + 15 * DAY)) < MIN, "a new approval, a new 15 days");
    assert.equal(s.h.rows("broker_connections").filter((r) => r.broker_id === "webull").length, 1);
    assert.equal(s.h.rows("broker_accounts").find((x) => x.external_id === "MARGINACCT01")?.included, false, "the Included switch survives the new approval");
  } finally {
    await s.close();
  }
});

test("sliding mode (if Webull confirms the 15 days restart): each refresh moves the end, and the sweep refreshes with under 5 days left", async () => {
  const s = await setup({ login: oneAccount(), fakeMode: "sliding", factory: (deps) => createWebullAdapter(deps, { refreshMode: "sliding" }) });
  try {
    const t0 = s.h.now();
    const run = await s.connect();
    const id = String(run.connectionId);
    s.h.advance(9 * DAY);
    await s.h.svc.scheduler.tick();
    assert.equal(Date.parse(String(s.row(id)?.session_expires_at)) - (t0 + 15 * DAY) < MIN, true, "6 days left: nothing to do yet");
    assert.equal(s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token").length, 0);

    s.h.advance(2 * DAY);
    await s.h.svc.scheduler.tick();
    assert.equal(s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token" && c.status === 200).length, 1, "4 days left: refreshed");
    const moved = Date.parse(String(s.row(id)?.session_expires_at));
    assert.ok(Math.abs(moved - (s.h.now() + 15 * DAY)) < MIN, "the end moved to 15 days from the refresh");
    assert.equal(webullDeadline(await s.sealed(id)), moved);

    // Concurrent refreshes of a rotating token (a read and the sweep at once, critique F4): they run
    // one after the other under the token lock, each with the refresh token the one before saved.
    s.h.advance(DAY);
    await Promise.all([s.h.svc.scheduler.tick(), s.req("/v1/portfolio"), s.req("/v1/orders")]);
    const refreshes = s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token");
    assert.ok(refreshes.length >= 2);
    assert.ok(refreshes.every((c) => c.status === 200), "no refresh ever used a token another one had already rotated away");
    assert.equal(s.row(id)?.status, "active");
    assert.equal(s.fake.state.refresh.has((await s.sealed(id)).refreshToken), true, "the stored refresh token is the live one");
  } finally {
    await s.close();
  }
});

test("a 401 on a read gets one refresh; refused again, the login is over", async () => {
  const s = await setup({ login: oneAccount() });
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    s.fake.revokeAccess();
    const p = await s.req("/v1/portfolio");
    assert.deepEqual(p.json.errors, [], "Webull ended the access token early: one refresh and the read goes on");
    assert.equal(s.row(id)?.status, "active");

    s.h.advance(31_000);
    s.fake.revokeAll();
    const q = await s.req("/v1/portfolio");
    assert.equal(q.json.errors.length, 1);
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, WEBULL_DETAIL.ended);
    const renew = await s.req(`/v1/connections/${id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: newBinding().hash } });
    assert.equal(renew.status, 200, renew.text);
    assert.deepEqual(renew.json.next, { kind: "redirect" });
  } finally {
    await s.close();
  }
});

test("a 401 at the token endpoint is Nasscord's request, never the user's: the login stays, that connection waits 5 minutes, and one connection never pauses everyone", async () => {
  const s = await setup({ login: oneAccount() });
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const unauthorized = { status: 401, body: { error_code: "UNAUTHORIZED", message: "Insufficient permission" } };
    s.h.advance(29 * MIN);
    s.fake.state.failNextToken = unauthorized;
    const p = await s.req("/v1/portfolio");
    assert.deepEqual(p.json.errors, [], "the access token still had a minute: the read went on with it");
    assert.equal(s.row(id)?.status, "active", "the refresh token was not used up, so the login stands");
    assert.equal(s.h.svc.oauth2.circuitOpen("webull"), false);

    // The access token is dead now, and the connection is still waiting: no token call, a sentence
    // that says what happens, and the login stays.
    s.h.advance(2 * MIN);
    const waiting = await s.req("/v1/portfolio");
    assert.deepEqual(
      waiting.json.errors.map((/** @type {any} */ e) => e.message),
      [WEBULL_DETAIL.tokenRefused],
    );
    assert.equal(s.fake.state.tokenCalls.length, 2, "no token call while the connection waits");
    assert.equal(s.row(id)?.status, "active");

    // Refused once more after the wait: still only this connection's problem (2 in 10 minutes).
    s.h.advance(4 * MIN);
    s.fake.state.failNextToken = unauthorized;
    const again = await s.req("/v1/portfolio");
    assert.deepEqual(
      again.json.errors.map((/** @type {any} */ e) => e.message),
      [WEBULL_DETAIL.tokenRefused],
    );
    s.h.advance(6 * MIN);
    const q = await s.req("/v1/portfolio");
    assert.deepEqual(q.json.errors, [], "Webull's token calls were never paused for everyone");
    assert.equal(s.row(id)?.status, "active");
    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.grant, c.status, c.code ?? null]),
      [
        ["authorization_code", 200, null],
        ["refresh_token", 401, "UNAUTHORIZED"],
        ["refresh_token", 401, "UNAUTHORIZED"],
        ["refresh_token", 200, null],
      ],
    );
    const logs = s.h.logLines.join("\n");
    assert.match(logs, /webull token call refused/);
    assert.match(logs, /"errorCode":"UNAUTHORIZED"/, "the error_code is logged until the sandbox confirms the codes");
    assert.ok(!logs.includes("Insufficient permission"), "never Webull's message");
  } finally {
    await s.close();
  }
});

test("401s at the token endpoint from several logins pause every Webull token call", () => {
  let t = Date.UTC(2026, 10, 16, 15, 0, 0);
  /** @type {string[]} */
  const warned = [];
  const deps = /** @type {any} */ ({
    config: { production: false, brokers: { webull: { clientId: "id", clientSecret: "secret", appKey: "776da210ab4a452795d74e726ebd74b6", appSecret: "0f50a2e853334a9aae1a783bee120c1f", env: "production" } } },
    store: {},
    oauth2: {},
    locks: {},
    cache: {},
    log: { info() {}, warn: (/** @type {string} */ m) => warned.push(m) },
    now: () => t,
    urls: {},
    http: () => ({}),
  });
  const adapter = createWebullAdapter(deps);
  const exchange = /** @type {any} */ (adapter.oauthProfile?.("production", "platform"));
  const unauthorized = { error_code: "UNAUTHORIZED", message: "Insufficient permission" };
  const call = { url: "https://us-oauth-open-api.webull.com/oauth2/tokens/create", body: "grant_type=authorization_code", contentType: "application/x-www-form-urlencoded" };
  assert.equal(exchange.parseTokenError(401, unauthorized), "invalid_client", "an exchange's 401: Webull did not accept Nasscord's app");
  assert.equal(exchange.parseTokenError(417, { error_code: "INVALID_PARAMETER", message: "Parameter error" }), "invalid_grant", "an exchange's 417: the code");
  assert.ok(exchange.tokenHeaders(call)["x-signature"], "one refusal pauses nothing");
  t += MIN;
  exchange.parseTokenError(401, unauthorized);
  t += MIN;
  exchange.parseTokenError(401, unauthorized);
  assert.throws(
    () => exchange.tokenHeaders(call),
    (e) => /** @type {any} */ (e).code === "circuit_open" && /** @type {any} */ (e).message === WEBULL_DETAIL.paused,
  );
  assert.deepEqual(warned, ["webull token calls paused after repeated 401s"]);
  t += 10 * MIN;
  assert.ok(exchange.tokenHeaders(call)["x-signature"], "the pause lasts 10 minutes");
});

test("signed reads (if Webull says resource calls must be signed): every read carries a valid signature", async () => {
  const s = await setup({ login: oneAccount(), factory: (deps) => createWebullAdapter(deps, { signReads: true }) });
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const p = await s.req("/v1/portfolio");
    assert.deepEqual(p.json.errors, []);
    const reads = s.fake.state.calls.filter((c) => c.path.startsWith("/trading/"));
    assert.ok(reads.length > 0 && reads.every((c) => c.signed && !c.appSecretHeader), "the fake verified each one");
  } finally {
    await s.close();
  }
});

test("five accounts: executions, orders and the portfolio each answer in full well within the app's 8 seconds", async () => {
  const s = await setup({ login: manyAccounts(5), pageSize: 10 });
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    assert.equal(run.connection.accounts.length, 5);

    /** @param {string} path */
    const timed = async (path) => {
      const t = Date.now();
      const r = await s.req(path);
      return { r, ms: Date.now() - t };
    };
    // Cold: the open orders, the history and the cash activities are all read now, at once.
    const e = await timed("/v1/executions");
    assert.equal(e.r.status, 200, e.r.text);
    assert.deepEqual(e.r.json.errors, []);
    assert.ok(e.ms < 8_000, `executions took ${e.ms} ms`);
    assert.equal(e.r.json.executions.length, 10, "two fills in each of the five accounts");
    assert.equal(e.r.json.executions.filter((/** @type {any} */ x) => x.symbol === "AAPL" && x.commission === 0.05).length, 5, "every account's commission came");

    s.h.advance(31_000);
    const o = await timed("/v1/orders");
    assert.deepEqual(o.r.json.errors, []);
    assert.ok(o.ms < 8_000, `orders took ${o.ms} ms`);
    assert.equal(o.r.json.orders.length, 30, "six orders in each of the five accounts");

    const p = await timed("/v1/portfolio");
    assert.deepEqual(p.r.json.errors, []);
    assert.ok(p.ms < 8_000, `the portfolio took ${p.ms} ms`);
    assert.equal(p.r.json.accounts.length, 5);
    assert.deepEqual(s.fake.state.limited, [], "and Webull never had to say 429");
  } finally {
    await s.close();
  }
});

test("a slow Webull: the read answers 'taking longer' in time, goes on, and the next call has it all", async () => {
  const d = defaultLogin();
  const s = await setup({
    login: { ...oneAccount(), openOrders: d.openOrders, history: d.history },
    pageSize: 10,
    factory: (deps) => createWebullAdapter(deps, { readBudgetMs: 1_000 }),
  });
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    s.fake.state.readDelayMs["/trading/orders/historical-orders/list"] = 2_000;
    const t = Date.now();
    const late = await s.req("/v1/orders");
    const ms = Date.now() - t;
    assert.equal(late.status, 200);
    assert.deepEqual(
      late.json.errors.map((/** @type {any} */ e) => e.message),
      [WEBULL_DETAIL.slow("orders")],
    );
    assert.ok(ms >= 900 && ms < 1_900, `answered after ${ms} ms, at the budget and before Webull did`);

    await pause(1_800);
    const t2 = Date.now();
    const next = await s.req("/v1/orders");
    assert.deepEqual(next.json.errors, []);
    assert.ok(Date.now() - t2 < 500, "the read that went on is in the cache");
    assert.ok(next.json.orders.some((/** @type {any} */ x) => x.brokerRef === "ORD-MASTER"));
    assert.equal(s.fake.state.calls.filter((c) => c.path === "/trading/orders/historical-orders/list").length, 1, "Webull was asked once");
  } finally {
    await s.close();
  }
});

test("one account refused (401 or 403) while the others read: an entry for it, no refresh, and the login stands", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const events = /** @type {any} */ (s.h.rows("broker_accounts").find((x) => x.external_id === "EVENTSACCT03"));
    const roth = /** @type {any} */ (s.h.rows("broker_accounts").find((x) => x.external_id === "ROTHACCT0002"));
    // Webull applies the Connect app's permissions per product account.
    s.fake.state.refuseReads.push({ account: "EVENTSACCT03", status: 401 }, { path: "/trading/assets/positions/list", account: "ROTHACCT0002", status: 403 });
    const tokenCalls = s.fake.state.tokenCalls.length;

    const p = await s.req("/v1/portfolio");
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(
      p.json.errors.map((/** @type {any} */ e) => e.message),
      [WEBULL_DETAIL.accountRefused("balances", events), WEBULL_DETAIL.accountRefused("positions", roth), WEBULL_DETAIL.accountRefused("positions", events)],
    );
    assert.deepEqual(p.json.accounts.map((/** @type {any} */ a) => a.accountId).sort(), [s.accountId("MARGINACCT01"), roth.id].sort());
    assert.equal(s.fake.state.tokenCalls.length, tokenCalls, "the accounts that read fine proved the token: no refresh");
    assert.equal(s.row(id)?.status, "active");

    // Orders have no per-account error channel: the login says which account is missing.
    const o = await s.req("/v1/orders");
    assert.deepEqual(
      o.json.errors.map((/** @type {any} */ e) => e.message),
      [WEBULL_DETAIL.ordersRefused(events)],
    );
    assert.deepEqual(o.json.orders, []);
    assert.equal(s.row(id)?.status, "active");

    events.included = false;
    const kept = await s.req("/v1/orders");
    assert.deepEqual(kept.json.errors, [], "with that account excluded the others' orders show");
    assert.ok(kept.json.orders.some((/** @type {any} */ x) => x.brokerRef === "ORD-MASTER"));
    assert.equal(s.row(id)?.status, "active");
  } finally {
    await s.close();
  }
});

test("a read refused with a fresh token is that read refused; the login ends only when the account list is refused too", async () => {
  const s = await setup({ login: oneAccount() });
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    s.fake.state.refuseReads.push({ path: "/trading/assets/balances/get", status: 401 }, { path: "/trading/assets/positions/list", status: 401 });
    const p = await s.req("/v1/portfolio");
    assert.deepEqual(
      p.json.errors.map((/** @type {any} */ e) => e.message),
      ["Webull refused to send the balances and positions of this login (401)."],
    );
    assert.equal(s.row(id)?.status, "active", "Webull still answers the account list with the new token");
    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.grant, c.status]),
      [
        ["authorization_code", 200],
        ["refresh_token", 200],
      ],
      "one refresh first",
    );

    s.h.advance(31_000);
    s.fake.state.refuseReads = [{ status: 401 }];
    const q = await s.req("/v1/portfolio");
    assert.equal(q.json.errors.length, 1);
    assert.equal(s.row(id)?.status, "expired", "everything refused, the account list too: the login is over");
    assert.equal(s.row(id)?.status_detail, WEBULL_DETAIL.ended);
  } finally {
    await s.close();
  }
});

test("one account's order history answers 500: orders and fills say so instead of leaving the account out", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const roth = /** @type {any} */ (s.h.rows("broker_accounts").find((x) => x.external_id === "ROTHACCT0002"));
    s.fake.state.refuseReads.push({ path: "/trading/orders/historical-orders/list", account: "ROTHACCT0002", status: 500 });

    const o = await s.req("/v1/orders");
    assert.deepEqual(
      o.json.errors.map((/** @type {any} */ e) => e.message),
      [WEBULL_DETAIL.ordersMissing(roth)],
    );
    assert.deepEqual(o.json.orders, [], "not a list that silently lacks the Roth IRA");
    const e = await s.req("/v1/executions");
    assert.deepEqual(
      e.json.errors.map((/** @type {any} */ x) => x.message),
      [WEBULL_DETAIL.ordersMissing(roth)],
    );
    assert.equal(s.row(id)?.status, "active");

    s.fake.state.refuseReads = [];
    const again = await s.req("/v1/orders");
    assert.deepEqual(again.json.errors, [], "a failure is not cached: the next call reads again");
    assert.ok(again.json.orders.some((/** @type {any} */ x) => x.brokerRef === "ORD-MASTER"));
  } finally {
    await s.close();
  }
});

test("buckets: cash activities have their own at Webull's 600 a minute; the sandbox's 30 a minute everywhere", async () => {
  for (const environment of /** @type {const} */ (["production", "sandbox"])) {
    /** @type {Array<[number, string]>} */
    const calls = [];
    /** @type {Array<[string, number]>} */
    const buckets = [];
    const client = createWebullClient({
      http: /** @type {any} */ (
        (/** @type {any} */ o) => {
          buckets.push([typeof o.bucket.key === "function" ? o.bucket.key("/<path>") : o.bucket.key, o.bucket.ratePerSec]);
          return { get: async (/** @type {string} */ path) => (calls.push([o.bucket.ratePerSec, path]), { data: [] }) };
        }
      ),
      base: "https://us-oauth-open-api.webull.com",
      token: "t",
      connectionId: "c1",
      budget: createWindowCounter({ now: () => 0 }),
      now: () => 0,
      environment,
    });
    const r = WEBULL_RATES[environment];
    assert.deepEqual(buckets, [
      ["webull:c1:/<path>", r.endpoint],
      ["webull:c1:accounts", r.accounts],
      ["webull:c1:/trading/activities/cash-activities/list", r.cash],
    ]);
    await client.tradeActivities("A1", Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
    await client.balances("A1");
    await client.accounts();
    assert.deepEqual(calls, [
      [r.cash, "/trading/activities/cash-activities/list"],
      [r.endpoint, "/trading/assets/balances/get"],
      [r.accounts, "/trading/accounts/list"],
    ]);
  }
  // Under Webull's limits: 2 per 2 s and 600 per 60 s in production, 30 per 60 s in the sandbox.
  assert.ok(WEBULL_RATES.production.endpoint * 2 < 2 && WEBULL_RATES.production.cash * 60 < 600 && WEBULL_RATES.production.accounts * 30 < 10);
  for (const v of Object.values(WEBULL_RATES.sandbox)) assert.ok(v * 60 < 30);
});

test("the year split: cash activities never cross a calendar year", async () => {
  assert.deepEqual(splitByYear(Date.UTC(2026, 11, 20), Date.UTC(2027, 0, 9)), [
    [Date.UTC(2026, 11, 20), Date.UTC(2027, 0, 1) - 1],
    [Date.UTC(2027, 0, 1), Date.UTC(2027, 0, 9)],
  ]);
  assert.deepEqual(splitByYear(Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 1)), [[Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 1)]]);

  const s = await setup({ at: Date.UTC(2027, 0, 9, 15, 0, 0) });
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const e = await s.req("/v1/executions");
    assert.deepEqual(e.json.errors, []);
    const cash = s.fake.state.calls.filter((c) => c.path === "/trading/activities/cash-activities/list" && c.query.account_id === "MARGINACCT01");
    assert.deepEqual(
      cash.map((c) => [c.query.start_time.slice(0, 4), c.query.end_time.slice(0, 4)]),
      [
        ["2026", "2026"],
        ["2027", "2027"],
      ],
    );
    assert.equal(cash[0].query.end_time, "2026-12-31T23:59:59.999Z");
    assert.equal(cash[1].query.start_time, "2027-01-01T00:00:00.000Z");
    const aapl = e.json.executions.find((/** @type {any} */ x) => x.symbol === "AAPL");
    assert.equal(aapl.commission, 0.05);
  } finally {
    await s.close();
  }
});

test("sample data stays out of production: no sandbox, overrides ignored, a sandbox profile refused", () => {
  const stubDeps = (/** @type {any} */ config) =>
    /** @type {any} */ ({ config, store: {}, oauth2: {}, locks: {}, cache: {}, log: { info() {}, warn() {} }, now: Date.now, urls: { api: "http://127.0.0.1:9" }, http: () => ({}) });
  const webull = { clientId: "id", clientSecret: "secret", appKey: "key", appSecret: "appsecret" };
  const prod = createWebullAdapter(stubDeps({ production: true, brokers: { webull: { ...webull, env: "production" } } }));
  assert.deepEqual(prod.environmentsFor?.(/** @type {any} */ ({})), ["production"]);
  const live = /** @type {NonNullable<typeof prod.oauthProfile>} */ (prod.oauthProfile)("production", "platform");
  assert.equal(live.tokenUrl, `${WEBULL_HOSTS.production}/oauth2/tokens/create`, "BROKER_URL_OVERRIDES never apply in production");
  assert.equal(live.authorizeUrl, `${WEBULL_HOSTS.production}/oauth2/auth-codes/get`);
  assert.throws(() => prod.oauthProfile?.("sandbox", "platform"), (e) => /** @type {any} */ (e).code === "sandbox_refused");
  // Even a server whose WEBULL_ENV slipped through as "sandbox" serves live only in production.
  const slipped = createWebullAdapter(stubDeps({ production: true, brokers: { webull: { ...webull, env: "sandbox" } } }));
  assert.deepEqual(slipped.environmentsFor?.(/** @type {any} */ ({})), ["production"]);

  const dev = createWebullAdapter(stubDeps({ production: false, brokers: { webull: { ...webull, env: "sandbox" } } }));
  assert.deepEqual(dev.environmentsFor?.(/** @type {any} */ ({})), ["sandbox"]);
  assert.throws(() => dev.oauthProfile?.("production", "platform"), (e) => /** @type {any} */ (e).code === "other_service", "a sandbox server holds no live credentials");
  assert.throws(() => dev.oauthProfile?.("sandbox", "user"), (e) => /** @type {any} */ (e).code === "unknown_method");
  assert.equal(dev.oauthProfile?.("sandbox", "platform").tokenUrl, "http://127.0.0.1:9/oauth2/tokens/create");
});

test("the read-only allowlist: six GET endpoints, and order placement never leaves Nasscord", async () => {
  let fetched = 0;
  const http = createBrokerHttp({
    name: "Webull",
    base: "https://us-oauth-open-api.webull.com",
    allow: [...WEBULL_READ_ALLOW],
    fetch: /** @type {any} */ (async () => {
      fetched += 1;
      return new Response("{}", { status: 200 });
    }),
  });
  for (const path of [
    "/trading/accounts/list",
    "/trading/assets/balances/get",
    "/trading/assets/positions/list",
    "/trading/orders/open-orders/list",
    "/trading/orders/historical-orders/list",
    "/trading/activities/cash-activities/list",
  ]) {
    assert.equal(http.allows("GET", path), true, path);
    assert.equal(http.allows("POST", path), false, path);
  }
  for (const [method, path] of [
    ["POST", "/trading/orders/place"],
    ["POST", "/trading/orders/preview"],
    ["POST", "/trading/orders/replace"],
    ["POST", "/trading/orders/cancel"],
    ["POST", "/trading/orders/batch-place"],
    ["GET", "/trading/orders/get"],
    ["POST", "/oauth2/tokens/create"],
    ["GET", "/trading/accounts/list/../../orders/place"],
    ["GET", "/trading/accounts/list%2F..%2Forders"],
    ["DELETE", "/trading/accounts/list"],
  ]) {
    await assert.rejects(http.request(method, path, { json: {} }), ReadOnlyViolation, `${method} ${path}`);
  }
  assert.equal(fetched, 0, "nothing reached the network");
});

test("Nasscord's own budget: a connection stops at 80 calls a minute, before Webull's 90", async () => {
  let t = 0;
  const budget = createWindowCounter({ now: () => t });
  const client = createWebullClient({
    http: /** @type {any} */ (() => ({ get: async () => [] })),
    base: "https://us-oauth-open-api.webull.com",
    token: "t",
    connectionId: "c1",
    budget,
    now: () => t,
  });
  for (let i = 0; i < WEBULL_USER_BUDGET; i++) await client.accounts();
  await assert.rejects(client.accounts(), (e) => /** @type {any} */ (e).status === 429);
  t += 60_000;
  await client.accounts();
  await assert.rejects(client.balances("../orders"), /not letters and digits/);
});

test("token errors, by Webull's documented status and code, never its message", () => {
  // Webull documents 401 UNAUTHORIZED, 417 INVALID_PARAMETER and 500 SYSTEM_ERROR for the token endpoint.
  assert.equal(webullTokenError(417, { error_code: "INVALID_PARAMETER", message: "Parameter error" }), "invalid_grant", "a refused parameter on a refresh: the refresh token");
  assert.equal(webullTokenError(401, { error_code: "UNAUTHORIZED", message: "Insufficient permission" }), "other", "the request's signature, app key or client: no login ends");
  assert.equal(webullTokenError(401, { error_code: "UNAUTHORIZED", message: "The refresh token expired" }), "other", "the message is never read");
  assert.equal(webullTokenError(401, { error_code: "INVALID_TOKEN", message: "Invalid token" }), "other", "Webull's INVALID_TOKEN is usually a signature mismatch");
  assert.equal(webullTokenError(500, { error_code: "SYSTEM_ERROR", message: "Internal Server Error" }), "other");
  assert.equal(webullTokenError(502, null), "other");
  // Codes Webull does not document yet: what they name decides.
  assert.equal(webullTokenError(401, { error_code: "REFRESH_TOKEN_EXPIRED" }), "invalid_grant");
  assert.equal(webullTokenError(400, { error: "invalid_grant" }), "invalid_grant");
  assert.equal(webullTokenError(417, { error_code: "INVALID_SIGNATURE" }), "other");
  assert.equal(webullTokenError(401, { error_code: "INVALID_CLIENT" }), "other");
  assert.equal(webullTokenError(401, { error_code: "DUPLICATE_NONCE" }), "other");
});

test("nothing secret in the log or in any reply", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    s.h.advance(29 * MIN);
    await s.req("/v1/portfolio");
    await s.req(`/v1/connections/${run.connectionId}`);
    const logs = s.h.logLines.join("\n");
    const said = s.replies.join("\n");
    const secrets = [...s.fake.state.issued, s.fake.app.clientSecret, s.fake.app.appSecret, "5MW12345"];
    assert.ok(s.fake.state.issued.length >= 5);
    for (const v of secrets) {
      assert.ok(!logs.includes(v), "a token, code, secret or account number reached the log");
      assert.ok(!said.includes(v), "a token, code, secret or account number reached a reply");
    }
    assert.ok(!logs.includes("state="), "no query string in the log");
  } finally {
    await s.close();
  }
});

test("mapping details: account types, order types and states, option symbols, ambiguous fills", () => {
  assert.equal(webullAccountType({ account_class: "MANAGED_ROTH_IRA" }), "roth");
  assert.equal(webullAccountType({ account_class: "ROLLOVER_IRA" }), "ira");
  assert.equal(webullAccountType({ account_class: "INDIVIDUAL_CASH", account_type: "CASH" }), "individual");
  assert.equal(webullAccountType({ account_class: "FUTURES", account_type: "MARGIN" }), "margin");
  assert.equal(webullAccountType({ account_class: "CRYPTO" }), "individual");
  assert.deepEqual(
    ["PENDING", "SUBMITTED", "PARTIAL_FILLED", "FILLED", "CANCELLED", "FAILED"].map(webullOrderStatus),
    ["submitted", "working", "working", "filled", "cancelled", "rejected"],
  );
  assert.deepEqual(
    ["MARKET", "LIMIT", "STOP_LOSS", "STOP_LOSS_LIMIT", "TRAILING_STOP_LOSS", "MARKET_ON_CLOSE", "LIMIT_ON_OPEN"].map((t) => webullOrderType(t, false)),
    ["MKT", "LMT", "STP", "STP", "TRAIL", "MKT", "LMT"],
  );
  assert.equal(occSymbol("aapl", { option_type: "PUT", option_expire_date: "2025-11-21", strike_price: "187.5" }), "AAPL 251121P00187500");
  assert.equal(occSymbol("AAPL", { option_type: "PUT", option_expire_date: "11/21/2025", strike_price: "1" }), "");

  const account = { id: "acc-1", external_id: "A1" };
  const at = Date.UTC(2026, 10, 10, 15, 0, 0);
  const order = (/** @type {string} */ id, /** @type {string} */ price) => ({ order_id: id, symbol: "AAPL", side: "BUY", instrument_type: "EQUITY", filled_quantity: "10", filled_price: price, filled_time_at: new Date(at).toISOString() });
  const entries = mergeOrderGroups([{ orders: [order("O1", "100"), order("O2", "101")] }], []);
  const acts = [
    { activity_type: "TRADE", activity_sub_type: "BUY", symbol: "AAPL", trade_date: "2026-11-10", net_amount: "-1010.02" },
    { activity_type: "TRADE", activity_sub_type: "BUY", symbol: "AAPL", trade_date: "2026-11-10", net_amount: "-1000.01" },
  ];
  const fills = webullExecutions(entries, acts, account, at);
  /** @param {string} id */
  const f = (id) => fills.find((x) => x.id === `webull:acc-1:${id}`);
  assert.deepEqual([f("O1")?.commission, f("O1")?.net, f("O1")?.provisional], [0.01, -1000.01, undefined], "each fill takes the activity its amount fits");
  assert.deepEqual([f("O2")?.commission, f("O2")?.net, f("O2")?.provisional], [0.02, -1010.02, undefined]);
  const none = webullExecutions(entries, null, account, at);
  assert.ok(none.every((x) => x.provisional && x.commission === 0), "without activities every fill is provisional");
  const wrongDay = webullExecutions(entries, [{ ...acts[0], trade_date: "2026-11-09" }], account, at);
  assert.ok(wrongDay.every((x) => x.provisional));
});
