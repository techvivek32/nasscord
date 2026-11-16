import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.mjs";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed } from "../src/http.mjs";
import { createRegistry } from "../src/registry.mjs";
import { createBrokerService } from "../src/server.mjs";
import { createTastytradeClient, TASTYTRADE_READ_ALLOW, TASTYTRADE_TOKEN_ALLOW, tastytradeHosts } from "../src/tastytrade/client.mjs";
import { createAdapter, TASTYTRADE_DETAIL } from "../src/tastytrade/index.mjs";
import { TEST_SECRET, TEST_TOKEN_KEY, testConfig } from "./helpers/common.mjs";
import { CALLBACK, CLIENT, CUSTOMER_REF, startFakeTastytrade } from "./helpers/fake-tastytrade.mjs";
import { createHarness, newBinding, runOAuthLogin } from "./helpers/harness.mjs";

/**
 * The tastytrade adapter end to end: the service (memory database, real flows, registry and
 * scheduler) against a fake tastytrade that shares the harness clock.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MARGIN = "5WT00001";
const ROTH = "5WT00002";
/** Personal data the fake's /customers/me answers, which must never be stored, logged or answered. */
const PII = ["Patricia", "Quillfeather", "patricia.quillfeather@example.com", "1980-04-02", "*****6789", "+15555550123"];

/**
 * @param {{ platform?: boolean, env?: Record<string, string>, fake?: Parameters<typeof startFakeTastytrade>[0] }} [o]
 * - platform: TASTYTRADE_CLIENT_ID and TASTYTRADE_CLIENT_SECRET are set (default true).
 */
async function setup(o = {}) {
  /** @type {Awaited<ReturnType<typeof createHarness>> | null} */
  let harness = null;
  const fake = await startFakeTastytrade({ now: () => (harness ? harness.now() : Date.now()), ...(o.fake ?? {}) });
  const env = {
    BROKER_URL_OVERRIDES: JSON.stringify({ tastytrade: fake.urls }),
    ...(o.platform === false ? {} : { TASTYTRADE_CLIENT_ID: CLIENT.id, TASTYTRADE_CLIENT_SECRET: CLIENT.secret }),
    ...(o.env ?? {}),
  };
  const h = await createHarness({ env, adapters: [["tastytrade", createAdapter]] });
  harness = h;
  /** Every reply body the test received (for leak checks). @type {string[]} */
  const replies = [];
  const owner = () => h.token({ role: "superadmin" });
  /** @param {string} path @param {{ method?: string, body?: unknown, token?: string }} [x] */
  const req = async (path, x = {}) => {
    const r = await h.req(path, { token: owner(), ...x });
    replies.push(r.text);
    return r;
  };
  /** @param {{ connectionId?: string, skipClaim?: boolean, token?: string }} [x] */
  const connect = async (x = {}) => {
    const run = await runOAuthLogin(h, { start: { brokerId: "tastytrade" }, token: owner(), ...x });
    for (const r of [run.hop, run.complete, run.claim, run.res]) if (r) replies.push(r.text);
    return run;
  };
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
  const outsideAllowlist = () => fake.serviceCalls().filter((c) => !isAllowed([...TASTYTRADE_TOKEN_ALLOW], c.method, c.path) && !isAllowed([...TASTYTRADE_READ_ALLOW], c.method, c.path));
  /** Past every read cache (executions: 60 seconds). */
  const later = () => h.advance(61_000);
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
    later,
    close: async () => {
      await h.close();
      await fake.close();
    },
  };
}

/** @param {any} r */
const tastyOption = (r) => r.json.options.find((/** @type {any} */ x) => x.brokerId === "tastytrade" && x.method === "tastytrade_oauth");

test("options: the owner's personal app until tastytrade verifies Nasscord; not set up without the client; BROKER_AUDIENCE opens or closes it", async () => {
  const bare = await setup({ platform: false });
  try {
    const opt = tastyOption(await bare.req("/v1/options"));
    assert.equal(opt.built, true);
    assert.equal(opt.reasonCode, "not_configured", "the platform client stays off until its env credentials exist");
    assert.match(opt.reason, /TASTYTRADE_CLIENT_ID and TASTYTRADE_CLIENT_SECRET are not set/, "the owner sees what to set");
  } finally {
    await bare.close();
  }

  const s = await setup();
  try {
    const trader = tastyOption(await s.h.req("/v1/options"));
    assert.equal(trader.flow, "oauth2_platform");
    assert.equal(trader.client, "platform");
    assert.equal(trader.audience, "superadmin");
    assert.equal(trader.reasonCode, "owner_only");
    assert.equal(trader.reason, "Not available yet: Nasscord is waiting for tastytrade's approval before everyone can connect this way.");
    assert.deepEqual(trader.environments, ["production"], "no cert sandbox and no paper: the user's own accounts only");
    assert.equal(trader.callbackUrl, CALLBACK);
    const own = tastyOption(await s.req("/v1/options"));
    assert.equal(own.available, true);

    const b = newBinding();
    const refused = await s.h.req("/v1/oauth/start", { method: "POST", body: { brokerId: "tastytrade", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "owner_only");
    assert.equal(s.fake.state.calls.length, 0, "nothing reached tastytrade");
    assert.equal(s.h.rows("broker_connections").length, 0);
  } finally {
    await s.close();
  }

  const open = await setup({ env: { BROKER_AUDIENCE: "tastytrade_oauth=all" } });
  try {
    assert.equal(tastyOption(await open.h.req("/v1/options")).available, true, "opened to everyone once tastytrade approves");
  } finally {
    await open.close();
  }
  const off = await setup({ env: { BROKER_AUDIENCE: "tastytrade_oauth=off" } });
  try {
    const o = tastyOption(await off.req("/v1/options"));
    assert.equal(o.reasonCode, "off", "off even for the owner");
    const run = await off.connect();
    assert.equal(run.failedAt, "start");
    assert.equal(run.res?.status, 403);
  } finally {
    await off.close();
  }
});

test("connect: tastytrade's login page, the code exchanged with a JSON body, the customer reference names the login, no personal data kept", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const u = new URL(String(run.hop?.json.redirectUrl));
    assert.equal(`${u.origin}${u.pathname}`, s.fake.urls.authorize);
    assert.equal(u.searchParams.get("client_id"), CLIENT.id);
    assert.equal(u.searchParams.get("redirect_uri"), CALLBACK, "exactly the redirect URI registered on the app");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("scope"), "read", "read only: no trade scope in this release");
    assert.ok(u.searchParams.get("state"));

    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.grant, c.status]),
      [["authorization_code", 200]],
    );
    const exchange = s.fake.state.tokenCalls[0].body;
    assert.deepEqual(Object.keys(exchange).sort(), ["client_id", "client_secret", "code", "grant_type", "redirect_uri"]);
    assert.equal(exchange.redirect_uri, CALLBACK);

    for (const c of s.fake.serviceCalls()) {
      assert.match(c.userAgent, /^nasscord\/\d+\.\d+\.\d+$/, `${c.method} ${c.path} carries User-Agent nasscord/<version>`);
      assert.equal(c.version, "20261012", `${c.method} ${c.path} carries Accept-Version`);
    }

    const c = /** @type {any} */ (run.connection);
    assert.equal(c.status, "active");
    assert.equal(c.method, "tastytrade_oauth");
    assert.equal(c.environment, "production");
    assert.equal(c.sessionExpiresAt, null, "the refresh token never expires: no session end");
    assert.deepEqual(
      c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
      [
        ["Main", "5WT•••01", "margin", true],
        ["Roth IRA", "5WT•••02", "roth", true],
      ],
      "the closed account is left out",
    );
    assert.equal(s.row(c.id)?.external_ref, `cust:${CUSTOMER_REF}`, "tastytrade's customer reference, not the 'me' id");
    assert.equal(s.row(c.id)?.scope, "read");

    const secret = /** @type {any} */ (s.sealed(c.id));
    assert.equal(secret.client, "platform");
    assert.equal(secret.clientId, undefined, "the platform client stays in the service env");
    assert.equal(secret.clientSecret, undefined);
    assert.equal(secret.redirectUri, CALLBACK);
    assert.ok(secret.accessToken && secret.refreshToken);
    assert.equal(secret.refreshExpiresAt, null);
    const tables = JSON.stringify(Object.fromEntries([...s.h.db.tables.entries()]));
    for (const v of [secret.accessToken, secret.refreshToken, CLIENT.secret]) assert.ok(!tables.includes(v), "sealed, never plain");
    for (const p of PII) assert.ok(!tables.includes(p) && !s.h.logLines.join("\n").includes(p), `personal data is never kept: ${p}`);
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("connect refused: a denied approval, a login without an open account, and another login on Reconnect", async () => {
  const s = await setup();
  try {
    s.fake.state.deny = true;
    const denied = await s.connect();
    assert.equal(denied.failedAt, "complete");
    assert.equal(denied.res?.json.code, "oauth_denied");
    s.fake.state.deny = false;
    assert.equal(s.h.rows("broker_connections").length, 0, "a login that never connected leaves nothing");

    const closedOnly = await setup({ fake: { accounts: [] } });
    try {
      const none = await closedOnly.connect();
      assert.equal(none.failedAt, "complete");
      assert.equal(none.res?.status, 400);
      assert.equal(none.res?.json.error, TASTYTRADE_DETAIL.noAccounts);
    } finally {
      await closedOnly.close();
    }

    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    s.fake.state.customer["external-id"] = "C0000099999";
    const other = await s.connect({ connectionId: id });
    assert.equal(other.failedAt, "complete");
    assert.equal(other.res?.status, 409, "a Reconnect must be the same tastytrade login");
    s.fake.state.customer["external-id"] = CUSTOMER_REF;
    assert.equal(s.row(id)?.external_ref, `cust:${CUSTOMER_REF}`);
  } finally {
    await s.close();
  }
});

test("reads: balances, positions with marks, orders merged from /orders/live and the 30-day search over several pages, Trade transactions", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    s.fake.state.pageSize = 2;
    const margin = s.accountId(MARGIN);
    const roth = s.accountId(ROTH);

    const p = await s.req("/v1/portfolio");
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.errors, []);
    assert.deepEqual(
      p.json.accounts.find((/** @type {any} */ a) => a.accountId === margin),
      { accountId: margin, netLiq: 25_340.5, buyingPower: 40_000, cash: 10_000.25, currency: "USD" },
      "no day P&L: the balances answer has none",
    );
    assert.deepEqual(p.json.accounts.find((/** @type {any} */ a) => a.accountId === roth), { accountId: roth, netLiq: 5_000, buyingPower: 3_700, cash: 3_700, currency: "USD" });
    /** @param {string} sym */
    const pos = (sym) => {
      const x = p.json.positions.find((/** @type {any} */ y) => y.symbol === sym);
      return x && { qty: x.qty, avgCost: x.avgCost, last: x.last, marketValue: x.marketValue, unrealizedPnl: x.unrealizedPnl, dayPnl: x.dayPnl, secType: x.secType, accountId: x.accountId };
    };
    assert.equal(p.json.positions.length, 4, "a closed (zero) position is left out");
    assert.deepEqual(pos("AAPL"), { qty: 10, avgCost: 150.25, last: 151.5, marketValue: 1_515, unrealizedPnl: 12.5, dayPnl: 25, secType: "STK", accountId: margin });
    assert.deepEqual(pos("SPY 261218C00600000"), { qty: -2, avgCost: 3.1, last: 3.5, marketValue: -700, unrealizedPnl: -80, dayPnl: -40, secType: "OPT", accountId: margin });
    assert.deepEqual(pos("/ESZ6"), { qty: 1, avgCost: 6000, last: 6020, marketValue: 301_000, unrealizedPnl: 1_000, dayPnl: 500, secType: "FUT", accountId: margin });
    assert.deepEqual(pos("VTI"), { qty: 5, avgCost: 250, last: 262, marketValue: 1_310, unrealizedPnl: 60, dayPnl: 10, secType: "STK", accountId: roth });
    assert.ok(
      s.fake.serviceCalls().filter((c) => c.path.endsWith("/positions")).every((c) => c.query["include-marks"] === "true"),
      "positions are always read with their marks",
    );

    const o = await s.req("/v1/orders");
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    /** @param {string} id */
    const order = (id) => o.json.orders.filter((/** @type {any} */ x) => x.brokerRef === id);
    assert.deepEqual(
      [...new Set(o.json.orders.map((/** @type {any} */ x) => x.brokerRef))].sort(),
      ["101", "102", "103", "105", "106", "201"],
      "104 (filled 45 days ago) is outside every search",
    );
    const [o101] = order("101");
    assert.deepEqual(
      (({ symbol, side, qty, type, price, tif, status, filledQty, avgFill, outsideRth, accountId }) => ({ symbol, side, qty, type, price, tif, status, filledQty, avgFill, outsideRth, accountId }))(o101),
      { symbol: "AAPL", side: "BUY", qty: 10, type: "LMT", price: 150, tif: "DAY", status: "filled", filledQty: 10, avgFill: 149.96, outsideRth: false, accountId: margin },
    );
    const [o102] = order("102");
    assert.deepEqual([o102.type, o102.price, o102.tif, o102.status, o102.side], ["STP", 140, "GTC", "working", "SELL"], "a GTC stop from three months ago, from /orders/live (it holds every order still working)");
    assert.equal(order("103").length, 2, "one order per leg");
    assert.deepEqual(order("103").map((/** @type {any} */ x) => [x.symbol, x.side, x.status]), [
      ["SPY 261218C00600000", "SELL", "cancelled"],
      ["SPY 261218C00610000", "BUY", "cancelled"],
    ]);
    assert.equal(order("105")[0].status, "filled", "an old GTC that filled today comes from today's live orders");
    assert.deepEqual([order("106")[0].status, order("106")[0].outsideRth], ["working", true]);
    assert.deepEqual([order("201")[0].status, order("201")[0].accountId], ["rejected", roth]);
    const searches = s.fake.serviceCalls().filter((c) => /\/orders$/.test(c.path));
    assert.ok(searches.length > 0 && searches.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.query["start-date"] ?? "")), "every order search sends start-date (else tastytrade answers 400)");
    assert.ok(searches.every((c) => c.query["status[]"] === undefined), "no separate working-orders search: /orders/live already holds them");
    assert.equal(new Set(searches.map((c) => c.query["start-date"])).size, 1, "one search window: the last 30 days");
    assert.equal(
      s.fake.serviceCalls().filter((c) => /\/orders(\/live)?$/.test(c.path) && c.query["page-offset"] === "0").length,
      4,
      "two order lists per account, no more",
    );
    assert.ok(s.fake.serviceCalls().some((c) => c.query["page-offset"] === "1"), "several pages were read");

    const e = await s.req("/v1/executions");
    assert.equal(e.status, 200, e.text);
    assert.deepEqual(e.json.errors, []);
    /** @param {string} n */
    const exec = (n) => e.json.executions.find((/** @type {any} */ x) => x.id.endsWith(`:t:${n}`));
    assert.equal(e.json.executions.length, 3, "Trade transactions of the last 30 days only (no deposit, nothing 45 days old)");
    assert.deepEqual(
      (({ symbol, side, qty, price, commission, net, accountId }) => ({ symbol, side, qty, price, commission, net, accountId }))(exec("9001")),
      { symbol: "AAPL", side: "BUY", qty: 4, price: 149.9, commission: 0.03, net: -599.63, accountId: margin },
    );
    assert.equal(exec("9002").provisional, true, "estimated fees");
    assert.deepEqual([exec("9003").side, exec("9003").commission, exec("9003").net], ["SELL", 2.25, 497.75]);
    const tx = s.fake.serviceCalls().filter((c) => c.path.endsWith("/transactions"));
    assert.ok(tx.every((c) => c.query.type === "Trade" && /^\d{4}-\d{2}-\d{2}$/.test(c.query["start-date"] ?? "")));
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("positions without a current mark are shown at yesterday's close and named; one refused account does not hide the other's balances, positions, orders or trades", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    s.fake.state.noMarks = true;
    const roth = s.fake.state.accounts.find((a) => a.number === ROTH);
    if (roth) roth.number = "5WT00099"; // tastytrade no longer answers for this account (404)
    const p = await s.req("/v1/portfolio");
    assert.equal(p.status, 200, p.text);
    const aapl = p.json.positions.find((/** @type {any} */ x) => x.symbol === "AAPL");
    assert.deepEqual([aapl.last, aapl.marketValue, aapl.dayPnl], [149, 1_490, undefined], "yesterday's close, no day P&L");
    assert.deepEqual(p.json.accounts.map((/** @type {any} */ a) => a.accountId), [s.accountId(MARGIN)]);
    assert.deepEqual(p.json.errors, [
      { connectionId: id, message: TASTYTRADE_DETAIL.accountRead("balances", "5WT•••02") },
      { connectionId: id, message: TASTYTRADE_DETAIL.accountRead("positions", "5WT•••02") },
      { connectionId: id, message: TASTYTRADE_DETAIL.noMark(["AAPL", "SPY 261218C00600000", "/ESZ6"]) },
    ]);
    assert.equal(s.row(id)?.status, "active");

    // Orders and trades: the account tastytrade no longer answers for is left out (and logged
    // without its number); the other account's still show.
    const o = await s.req("/v1/orders");
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    assert.deepEqual([...new Set(o.json.orders.map((/** @type {any} */ x) => x.brokerRef))].sort(), ["101", "102", "103", "105", "106"]);
    assert.ok(o.json.orders.every((/** @type {any} */ x) => x.accountId === s.accountId(MARGIN)));
    const e = await s.req("/v1/executions");
    assert.deepEqual(e.json.errors, []);
    assert.equal(e.json.executions.length, 3);
    assert.ok(s.h.logLines.some((l) => l.includes("tastytrade orders read in part")));
    assert.ok(s.h.logLines.some((l) => l.includes("tastytrade trades read in part")));
    const logs = s.h.logLines.join("\n");
    assert.ok(!logs.includes(ROTH) && !logs.includes("5WT00099"), "no account number in the logs");

    // Every account refused: the read fails for the connection, which stays active.
    const margin = s.fake.state.accounts.find((a) => a.number === MARGIN);
    if (margin) margin.number = "5WT00098";
    s.later();
    const none = await s.req("/v1/orders");
    assert.deepEqual(none.json.orders, []);
    assert.deepEqual(none.json.errors, [{ connectionId: id, message: "tastytrade could not answer this request (404)." }]);
    assert.equal(s.row(id)?.status, "active");
  } finally {
    await s.close();
  }
});

test("refresh: a new 15-minute access token when under 2 minutes are left, once for concurrent reads, the refresh token never rotates", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    const first = /** @type {any} */ (s.sealed(id));

    s.h.advance(10 * MIN);
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(s.fake.refreshes(), 0, "no refresh while more than 2 minutes are left");

    s.h.advance(4 * MIN);
    const reads = await Promise.all([s.req("/v1/portfolio"), s.req("/v1/orders"), s.req("/v1/executions")]);
    for (const r of reads) assert.deepEqual(r.json.errors, [], r.text);
    assert.equal(s.fake.refreshes(), 1, "one refresh under the token lock, shared by every read");
    const refresh = s.fake.state.tokenCalls.find((c) => c.grant === "refresh_token")?.body ?? {};
    assert.deepEqual(Object.keys(refresh).sort(), ["client_id", "client_secret", "grant_type", "refresh_token"], "JSON body with the client secret");
    assert.equal(refresh.refresh_token, first.refreshToken);
    const second = /** @type {any} */ (s.sealed(id));
    assert.notEqual(second.accessToken, first.accessToken);
    assert.equal(second.refreshToken, first.refreshToken, "tastytrade does not rotate the refresh token");
    assert.equal(s.row(id)?.session_expires_at, null);

    s.h.advance(15 * MIN);
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(s.fake.refreshes(), 2, "every 15 minutes of use");

    // tastytrade ended the access token early: one refresh, and the read goes on.
    s.fake.revokeAccess();
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(s.fake.refreshes(), 3);
    assert.equal(s.row(id)?.status, "active");
    assert.equal(/** @type {any} */ (s.sealed(id)).refreshToken, first.refreshToken);
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("a deleted grant expires the connection once and pauses nobody; Reconnect approves again on the same connection", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    const roth = s.h.rows("broker_accounts").find((a) => a.external_id === ROTH);
    if (roth) roth.included = false;

    s.fake.deleteGrant();
    s.later();
    const dead = await s.req("/v1/portfolio");
    assert.deepEqual(dead.json.errors, [{ connectionId: id, message: TASTYTRADE_DETAIL.removed }]);
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, "tastytrade access was removed. Reconnect to continue.");
    assert.deepEqual(
      s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token").map((c) => c.status),
      [401],
      "one refused refresh for the whole read, never a loop on the token endpoint",
    );
    const kept = /** @type {any} */ (s.sealed(id));
    assert.deepEqual(Object.keys(kept).sort(), ["client", "redirectUri"], "the tokens are dropped");
    assert.equal(s.h.svc.oauth2.circuitOpen("tastytrade"), false, "one user's deleted grant pauses nobody");

    const calls = s.fake.state.calls.length;
    s.later();
    await s.req("/v1/portfolio");
    assert.equal(s.fake.state.calls.length, calls, "an expired connection is not read");

    const plain = await s.req(`/v1/connections/${id}/renew`, { method: "POST", body: {} });
    assert.equal(plain.status, 400);
    assert.equal(plain.json.code, "needs_login");

    const again = await s.connect({ connectionId: id });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
    assert.equal(/** @type {any} */ (again.connection).id, id);
    assert.equal(s.row(id)?.status, "active");
    assert.equal(s.h.rows("broker_accounts").find((a) => a.external_id === ROTH)?.included, false, "the Included switches survive");
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
  } finally {
    await s.close();
  }
});

test("a just-refreshed token that tastytrade still refuses is a read error: the tokens stay, the login stays, no second refresh for it", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    const first = /** @type {any} */ (s.sealed(id));

    // tastytrade answers every read 401 while its token endpoint works (say, a new header rule).
    s.fake.state.refuseReads = true;
    s.later();
    const p = await s.req("/v1/portfolio");
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.errors, [{ connectionId: id, message: TASTYTRADE_DETAIL.refusedFresh("balances") }], "one error for the login, not one per account");
    assert.deepEqual(
      s.fake.state.tokenCalls.map((c) => [c.grant, c.status]),
      [
        ["authorization_code", 200],
        ["refresh_token", 200],
      ],
      "one refresh for the whole read",
    );
    assert.equal(s.row(id)?.status, "active", "a refresh that works proves the grant is alive");
    const kept = /** @type {any} */ (s.sealed(id));
    assert.equal(kept.refreshToken, first.refreshToken, "the refresh token is kept");
    assert.ok(kept.accessToken && kept.accessToken !== first.accessToken, "the new access token is kept");
    assert.equal(s.h.logLines.filter((l) => l.includes("tastytrade refused a just-refreshed token")).length, 1);

    // Later reads try that token once and fail the same way, without another refresh.
    s.later();
    const o = await s.req("/v1/orders");
    assert.deepEqual(o.json.errors, [{ connectionId: id, message: TASTYTRADE_DETAIL.refusedFresh("orders") }]);
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, [{ connectionId: id, message: TASTYTRADE_DETAIL.refusedFresh("balances") }]);
    assert.equal(s.fake.refreshes(), 1, "no refresh loop while tastytrade refuses reads");
    assert.equal(s.h.svc.oauth2.circuitOpen("tastytrade", "platform"), false);

    // tastytrade accepts the token again: reads go on with it.
    s.fake.state.refuseReads = false;
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(s.fake.refreshes(), 1);
    assert.equal(s.row(id)?.status, "active");
  } finally {
    await s.close();
  }
});

test("circuit breaker: 3 failed token calls pause tastytrade sign-ins for 30 minutes; the connection stays", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    s.h.advance(16 * MIN);
    s.fake.state.failToken = { count: 10, status: 503, body: { error: { code: "unavailable", message: "Down for maintenance" } } };
    const refreshCalls = () => s.fake.state.tokenCalls.filter((c) => c.grant === "refresh_token").length;

    for (let i = 1; i <= 3; i++) {
      s.h.advance(20_000);
      const r = await s.req("/v1/portfolio");
      assert.equal(r.json.errors.length, 1);
      assert.equal(refreshCalls(), i, "one token call per read, shared by every account and endpoint");
    }
    assert.equal(s.h.svc.oauth2.circuitOpen("tastytrade", "platform"), true);
    s.h.advance(20_000);
    const paused = await s.req("/v1/portfolio");
    assert.deepEqual(paused.json.errors, [{ connectionId: id, message: "Nasscord paused tastytrade sign-ins for a few minutes after repeated failures. Try again later." }]);
    assert.equal(refreshCalls(), 3, "nothing reached tastytrade while paused");
    assert.equal(s.row(id)?.status, "active", "an outage never ends the login");

    s.h.advance(11 * MIN);
    await s.req("/v1/portfolio");
    assert.equal(refreshCalls(), 3, "still paused after the engine's default 10 minutes");

    s.fake.state.failToken = null;
    s.h.advance(20 * MIN);
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(refreshCalls(), 4);
    assert.equal(s.row(id)?.status, "active");
  } finally {
    await s.close();
  }
});

test("a crash between tastytrade's token answer and the database write loses nothing; a restarted service reads with the saved token", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    const id = String(run.connectionId);
    const before = /** @type {any} */ (s.sealed(id)).accessToken;
    s.h.advance(14 * MIN);
    s.h.db.failNext.set("broker_secrets", new Error("database down"));
    const failed = await s.req("/v1/portfolio");
    assert.equal(failed.json.errors.length, 1);
    assert.equal(s.fake.refreshes(), 1);
    assert.equal(s.row(id)?.status, "active", "a failed save does not end the login");
    assert.equal(/** @type {any} */ (s.sealed(id)).accessToken, before, "nothing unsaved was kept");

    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, [], "the refresh token still works");
    assert.equal(s.fake.refreshes(), 2);

    const again = createBrokerService(
      testConfig({
        IBKR_GATEWAY_BUNDLE: "does-not-exist",
        BROKER_URL_OVERRIDES: JSON.stringify({ tastytrade: s.fake.urls }),
        TASTYTRADE_CLIENT_ID: CLIENT.id,
        TASTYTRADE_CLIENT_SECRET: CLIENT.secret,
      }),
      { db: s.h.db, now: s.h.now, packages: [], adapters: [["tastytrade", createAdapter]] },
    );
    const out = await again.service.orders(/** @type {any} */ ({ sub: s.h.user, wid: s.h.wid, role: "superadmin" }));
    assert.deepEqual(out.errors, []);
    assert.ok(out.orders.some((x) => x.brokerRef === "101"));
    assert.equal(s.fake.refreshes(), 2, "the access token saved by the first process is still good");
  } finally {
    await s.close();
  }
});

test("cert (sample data): refused in production by the config, the hosts and the adapter; outside production it is the only environment offered", async () => {
  const prodEnv = {
    NODE_ENV: "production",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    BROKER_SERVICE_SECRET: TEST_SECRET,
    BROKER_TOKEN_KEY: TEST_TOKEN_KEY,
    PUBLIC_LOGIN_URL: "https://ibkr-login.example.com",
    OAUTH_CALLBACK_BASE: "https://nasscord.com",
    TASTYTRADE_CLIENT_ID: CLIENT.id,
    TASTYTRADE_CLIENT_SECRET: CLIENT.secret,
  };
  assert.throws(
    () => loadConfig({ ...prodEnv, TASTYTRADE_ENV: "cert" }),
    (e) => e instanceof ConfigError && e.problems.includes("TASTYTRADE_ENV=cert is sample data and is refused in production"),
  );

  const local = { api: "http://127.0.0.1:1", authorize: "http://127.0.0.1:1/auth.html" };
  assert.deepEqual(tastytradeHosts(local, true, "production"), { api: "https://api.tastyworks.com", authorize: "https://my.tastytrade.com/auth.html" }, "no fake host in production");
  assert.throws(() => tastytradeHosts(local, true, "cert"), /refused in production/);
  assert.deepEqual(tastytradeHosts({}, false, "cert"), { api: "https://api.cert.tastyworks.com", authorize: "https://cert-my.staging-tasty.works/auth.html" });

  const prod = loadConfig(prodEnv);
  const adapter = /** @type {import("../src/adapter-types.mjs").BrokerAdapter} */ (
    createAdapter(/** @type {any} */ ({ config: prod, store: {}, oauth2: {}, locks: {}, cache: {}, log: {}, now: Date.now, urls: local, http: () => ({}) }))
  );
  assert.deepEqual(adapter.environmentsFor?.(prod), ["production"]);
  const live = adapter.oauthProfile?.("production", "platform");
  assert.equal(live?.authorizeUrl, "https://my.tastytrade.com/auth.html");
  assert.equal(live?.tokenUrl, "https://api.tastyworks.com/oauth/token");
  assert.deepEqual(live?.platformClient, { clientId: CLIENT.id, clientSecret: CLIENT.secret });
  assert.throws(() => adapter.oauthProfile?.("sandbox", "platform"), /refused in production/, "no cert login in production");
  const registry = createRegistry([adapter], prod);
  const opt = registry.options(/** @type {any} */ ({ sub: "u", wid: "w", role: "superadmin" })).options.find((x) => x.method === "tastytrade_oauth");
  assert.deepEqual(opt?.environments, ["production"]);
  assert.equal(opt?.callbackUrl, "https://nasscord.com/api/broker/callback/tastytrade", "the one frozen callback");

  // Outside production, TASTYTRADE_ENV=cert offers the cert sandbox only, at tastytrade's cert hosts.
  const h = await createHarness({
    env: { TASTYTRADE_ENV: "cert", TASTYTRADE_CLIENT_ID: CLIENT.id, TASTYTRADE_CLIENT_SECRET: CLIENT.secret },
    adapters: [["tastytrade", createAdapter]],
  });
  try {
    const owner = h.token({ role: "superadmin" });
    const o = (await h.req("/v1/options", { token: owner })).json.options.find((/** @type {any} */ x) => x.method === "tastytrade_oauth");
    assert.deepEqual(o.environments, ["sandbox"]);
    const b = newBinding();
    const wrong = await h.req("/v1/oauth/start", { method: "POST", token: owner, body: { brokerId: "tastytrade", environment: "production", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(wrong.status, 400, "the live app is not this server's");
    const start = await h.req("/v1/oauth/start", { method: "POST", token: owner, body: { brokerId: "tastytrade", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
    assert.equal(start.status, 200, start.text);
    assert.equal(h.rows("broker_connections").find((r) => r.id === start.json.connectionId)?.environment, "sandbox");
    const hop = await h.req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: start.json.connectionId, binding: b.nonce } });
    assert.equal(hop.status, 200, hop.text);
    assert.ok(String(hop.json.redirectUrl).startsWith("https://cert-my.staging-tasty.works/auth.html?"));
  } finally {
    await h.close();
  }
});

test("read only: the allowlist holds seven GETs; order, dry-run and quote-token calls are refused before the network", async () => {
  const allow = [...TASTYTRADE_READ_ALLOW];
  for (const path of [
    "/customers/me",
    "/customers/me/accounts",
    "/accounts/5WT00001/balances",
    "/accounts/5WT00001/positions",
    "/accounts/5WT00001/orders/live",
    "/accounts/5WT00001/orders",
    "/accounts/5WT00001/transactions",
  ]) {
    assert.equal(isAllowed(allow, "GET", path), true, path);
  }
  for (const [method, path] of [
    ["POST", "/accounts/5WT00001/orders"],
    ["POST", "/accounts/5WT00001/orders/dry-run"],
    ["PUT", "/accounts/5WT00001/orders/123"],
    ["PATCH", "/accounts/5WT00001/orders/123"],
    ["DELETE", "/accounts/5WT00001/orders/123"],
    ["POST", "/accounts/5WT00001/orders/123/dry-run"],
    ["GET", "/accounts/5WT00001/orders/123"],
    ["POST", "/accounts/5WT00001/complex-orders"],
    ["GET", "/accounts/5WT00001/complex-orders"],
    ["DELETE", "/accounts/5WT00001/complex-orders/9"],
    ["GET", "/api-quote-tokens"],
    ["GET", "/customers/me/accounts/5WT00001"],
    ["GET", "/accounts/5WT00001/transactions/total-fees"],
    ["GET", "/accounts/5WT00001/trading-status"],
    ["GET", "/accounts/5WT00001/../orders"],
    ["GET", "/accounts/5WT00001%2forders"],
    ["GET", "/accounts/5WT-0001/balances"],
    ["POST", "/oauth/token"],
    ["POST", "/customers/me"],
    ["POST", "/sessions"],
  ]) {
    assert.equal(isAllowed(allow, method, path), false, `${method} ${path}`);
  }
  assert.deepEqual(
    [...TASTYTRADE_TOKEN_ALLOW].map(([m, re]) => [m, re.source]),
    [["POST", "^\\/oauth\\/token$"]],
    "the token endpoint is the only write",
  );

  /** @type {Array<{ url: string, headers: Record<string, string> }>} */
  const fetched = [];
  /** @type {typeof fetch} */
  const countingFetch = async (url, init) => {
    fetched.push({ url: String(url), headers: /** @type {Record<string, string>} */ (init?.headers ?? {}) });
    return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
  };
  const client = createTastytradeClient({
    http: (o) => createBrokerHttp({ ...o, fetch: countingFetch }),
    base: "https://api.tastyworks.com",
    userAgent: "nasscord/0.1.0",
    apiVersion: "20261012",
  });
  const http = client.httpFor("tastytrade:x");
  await assert.rejects(http.request("POST", "/accounts/5WT00001/orders", { json: { "order-type": "Market", legs: [] } }), ReadOnlyViolation);
  await assert.rejects(http.request("POST", "/accounts/5WT00001/orders/dry-run", { json: {} }), ReadOnlyViolation);
  await assert.rejects(http.request("DELETE", "/accounts/5WT00001/orders/1"), ReadOnlyViolation);
  await assert.rejects(http.request("PATCH", "/accounts/5WT00001/orders/1"), ReadOnlyViolation);
  assert.equal(fetched.length, 0, "nothing reached the network");
  assert.deepEqual(await client.positions({ token: "acc3ss", bucket: "tastytrade:x" }, "5WT00001"), []);
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, "https://api.tastyworks.com/accounts/5WT00001/positions?include-marks=true");
  assert.equal(fetched[0].headers["user-agent"], "nasscord/0.1.0");
  assert.equal(fetched[0].headers["accept-version"], "20261012");
  assert.equal(fetched[0].headers.authorization, "Bearer acc3ss");
  await assert.rejects(client.balances({ token: "acc3ss", bucket: "tastytrade:x" }, "../orders"), /letters and digits/);
  assert.equal(fetched.length, 1);
});

test("no secret or personal data in logs, audit rows, connection rows or answers; Disconnect calls nobody", async () => {
  const s = await setup();
  try {
    const run = await s.connect();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    for (const path of ["/v1/portfolio", "/v1/orders", "/v1/executions", `/v1/connections/${id}`, "/v1/options"]) await s.req(path);
    s.h.advance(14 * MIN);
    await s.req("/v1/portfolio");
    // A deleted grant writes its sentence, never a value.
    s.fake.deleteGrant();
    s.later();
    await s.req("/v1/portfolio");
    const again = await s.connect({ connectionId: id });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));

    const needles = [...s.fake.state.issued, CLIENT.secret, ...PII];
    const haystacks = {
      logs: s.h.logLines.join("\n"),
      audit: JSON.stringify(s.h.rows("audit_events")),
      connections: JSON.stringify(s.h.rows("broker_connections")),
      accounts: JSON.stringify(s.h.rows("broker_accounts")),
      pending: JSON.stringify(s.h.rows("broker_oauth_pending")),
      answers: s.replies.join("\n"),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const n of needles) assert.ok(!text.includes(n), `${where} holds a secret value or personal data`);
    }
    for (const n of [MARGIN, ROTH, CUSTOMER_REF]) {
      assert.ok(!haystacks.logs.includes(n), `no account number or customer reference in the logs: ${n}`);
      assert.ok(!haystacks.answers.includes(n), `account numbers are only shown masked: ${n}`);
    }

    const calls = s.fake.state.calls.length;
    const del = await s.req(`/v1/connections/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal(s.sealed(id), null, "the tokens are deleted");
    assert.equal(s.row(id)?.status, "disconnected");
    assert.equal(s.fake.state.calls.length, calls, "tastytrade publishes no revocation; nothing is called");
  } finally {
    await s.close();
  }
});
