import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError, ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed } from "../src/http.mjs";
import { createLimiter } from "../src/limits.mjs";
import { createBrokerService } from "../src/server.mjs";
import { etDateKey, etToUtc } from "../src/time.mjs";
import { createTradierClient, quotaAwareFetch, TRADIER_READ_ALLOW, TRADIER_TOKEN_ALLOW, tradierHosts } from "../src/tradier/client.mjs";
import { createAdapter, TRADIER_DETAIL } from "../src/tradier/index.mjs";
import { testConfig } from "./helpers/common.mjs";
import { CALLBACK, CLIENT, defaultLogin, startFakeTradier } from "./helpers/fake-tradier.mjs";
import { createHarness, runOAuthLogin } from "./helpers/harness.mjs";

/**
 * The Tradier adapter end to end: the service (memory database, real flows, registry and
 * scheduler) against a fake Tradier with a Live and a Sandbox host that share the harness clock.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * @param {{ platform?: boolean, refreshTokens?: boolean, env?: Record<string, string> }} [o]
 * - platform: TRADIER_CLIENT_ID and TRADIER_CLIENT_SECRET are set (Nasscord's partner client).
 */
async function setup(o = {}) {
  /** @type {Awaited<ReturnType<typeof createHarness>> | null} */
  let harness = null;
  const fake = await startFakeTradier({ now: () => (harness ? harness.now() : Date.now()), refreshTokens: o.refreshTokens });
  const env = {
    BROKER_URL_OVERRIDES: JSON.stringify({ tradier: fake.urls }),
    ...(o.platform ? { TRADIER_CLIENT_ID: CLIENT.id, TRADIER_CLIENT_SECRET: CLIENT.secret } : {}),
    ...(o.refreshTokens ? { TRADIER_REFRESH_TOKENS: "true" } : {}),
    ...(o.env ?? {}),
  };
  const h = await createHarness({ env, adapters: [["tradier", createAdapter]] });
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
  /** @param {string} secret @param {Record<string, unknown>} [extra] @param {string} [as] */
  const connectToken = (secret, extra = {}, as = owner()) => req("/v1/keys/connect", { method: "POST", token: as, body: { brokerId: "tradier", secret, ...extra } });
  /** @param {{ connectionId?: string, skipClaim?: boolean }} [x] */
  const connectOAuth = async (x = {}) => {
    const run = await runOAuthLogin(h, { start: { brokerId: "tradier" }, token: owner(), ...x });
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
  /** Service calls to the fake that are neither a token endpoint nor an allowed read. */
  const outsideAllowlist = () => fake.serviceCalls().filter((c) => !isAllowed([...TRADIER_TOKEN_ALLOW], c.method, c.path) && !isAllowed([...TRADIER_READ_ALLOW], c.method, c.path));
  /** Past every read cache (the history's 10 minutes included) and every rate-limit pause. */
  const later = () => h.advance(11 * 60_000);
  return {
    h,
    fake,
    owner,
    req,
    replies,
    connectToken,
    connectOAuth,
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

/** @param {any} json @param {string} b @param {string} m */
const pick = (json, b, m) => json.options.find((/** @type {any} */ x) => x.brokerId === b && x.method === m);

test("options: the personal token is the owner's and Live only; the partner client waits for its env keys", async () => {
  const s = await setup();
  try {
    const forTrader = (await s.h.req("/v1/options")).json;
    const token = pick(forTrader, "tradier", "tradier_token");
    assert.equal(token.built, true);
    assert.equal(token.flow, "api_key");
    assert.equal(token.reasonCode, "owner_only", "Tradier's API is for personal use unless you are a partner");
    assert.deepEqual(token.environments, ["production"], "sandbox (paper) tokens wait for TRADIER_SANDBOX_TOKENS");
    const oauth = pick(forTrader, "tradier", "tradier_oauth");
    assert.equal(oauth.built, true);
    assert.equal(oauth.flow, "oauth2_platform");
    assert.equal(oauth.reasonCode, "not_configured");
    assert.equal(oauth.reason, "Tradier is not set up on this server yet.");

    const forOwner = (await s.req("/v1/options")).json;
    assert.equal(pick(forOwner, "tradier", "tradier_token").available, true);
    assert.match(pick(forOwner, "tradier", "tradier_oauth").reason, /TRADIER_CLIENT_ID and TRADIER_CLIENT_SECRET are not set/);

    const refused = await s.h.req("/v1/keys/connect", { method: "POST", body: { brokerId: "tradier", secret: s.fake.addToken("live") } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.code, "owner_only");
    assert.equal(s.fake.state.calls.length, 0, "nothing reached Tradier");
  } finally {
    await s.close();
  }

  const p = await setup({ platform: true, env: { TRADIER_SANDBOX_TOKENS: "true" } });
  try {
    const forOwner = (await p.req("/v1/options")).json;
    const oauth = pick(forOwner, "tradier", "tradier_oauth");
    assert.equal(oauth.available, true);
    assert.equal(oauth.client, "platform");
    assert.deepEqual(oauth.environments, ["production"], "Tradier documents OAuth for Live only");
    assert.equal(oauth.callbackUrl, CALLBACK);
    assert.equal(pick((await p.h.req("/v1/options")).json, "tradier", "tradier_oauth").reasonCode, "owner_only", "the owner tests it before opening it with BROKER_AUDIENCE");
    assert.deepEqual(pick(forOwner, "tradier", "tradier_token").environments, ["production", "paper"]);
  } finally {
    await p.close();
  }
});

test("token: a Live token connects the owner's open accounts, sealed; the same login again reuses the connection", async () => {
  const s = await setup();
  try {
    const token = s.fake.addToken("live");
    const r = await s.connectToken(token);
    assert.equal(r.status, 200, r.text);
    const c = r.json.connection;
    assert.equal(c.method, "tradier_token");
    assert.equal(c.environment, "production");
    assert.equal(c.status, "active");
    assert.equal(c.sessionExpiresAt, null, "a personal token does not expire");
    assert.deepEqual(
      c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
      [
        ["Tradier Margin", "6YA•••01", "margin", true],
        ["Tradier Roth IRA", "6YA•••02", "roth", true],
      ],
      "the closed account is left out",
    );
    assert.equal(s.row(c.id)?.external_ref, "id-tradier-owner", "the profile id names the login");
    assert.deepEqual(s.sealed(c.id), { token, host: "live" });
    assert.ok(!JSON.stringify(s.h.rows("broker_secrets")).includes(token), "sealed, never plain");
    assert.deepEqual(
      s.fake.state.calls.map((x) => [x.host, x.method, x.path]),
      [["live", "GET", "/v1/user/profile"]],
      "one read checks the token",
    );

    // A second token of the same login: the same connection, its switches kept.
    const ira = s.h.rows("broker_accounts").find((a) => a.connection_id === c.id && a.external_id === "6YA00002");
    if (ira) ira.included = false;
    const again = await s.connectToken(s.fake.addToken("live"));
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.connection.id, c.id);
    assert.equal(s.h.rows("broker_connections").filter((x) => x.broker_id === "tradier").length, 1);
    assert.equal(s.h.rows("broker_accounts").find((a) => a.connection_id === c.id && a.external_id === "6YA00002")?.included, false);
  } finally {
    await s.close();
  }
});

test("token: a Live token stays the owner's even with the audience open; sandbox (paper) tokens wait for TRADIER_SANDBOX_TOKENS", async () => {
  const s = await setup({ env: { BROKER_AUDIENCE: "tradier_token=all" } });
  try {
    // Opened to everyone with Paper tokens off, every user's attempt would fail: the options say so.
    const forTrader = pick((await s.h.req("/v1/options")).json, "tradier", "tradier_token");
    assert.equal(forTrader.available, false);
    assert.equal(forTrader.reasonCode, "not_configured");
    assert.equal(forTrader.reason, "Tradier is not set up on this server yet.");
    const forOwner = pick((await s.req("/v1/options")).json, "tradier", "tradier_token");
    assert.equal(forOwner.reasonCode, "not_configured");
    assert.equal(forOwner.reason, `Not set up on this server: ${TRADIER_DETAIL.audienceNeedsSandbox}.`);
    const token = s.fake.addToken("live");
    for (const extra of [{}, { environment: "production" }]) {
      const r = await s.connectToken(token, extra, s.h.token());
      assert.equal(r.status, 503, r.text);
      assert.equal(r.json.code, "not_configured");
    }
    const paper = await s.connectToken(s.fake.addToken("sandbox"), { environment: "paper" }, s.h.token());
    assert.equal(paper.status, 503);
    assert.equal(paper.json.code, "not_configured", "Paper is not offered while TRADIER_SANDBOX_TOKENS is off");
    assert.equal(s.fake.state.calls.length, 0, "nothing reached Tradier");
  } finally {
    await s.close();
  }

  const p = await setup({ env: { BROKER_AUDIENCE: "tradier_token=all", TRADIER_SANDBOX_TOKENS: "true" } });
  try {
    assert.equal(pick((await p.h.req("/v1/options")).json, "tradier", "tradier_token").available, true, "everyone may connect a Paper token");
    // The adapter still refuses a Live token from anyone but the owner, whatever the audience says.
    const live = p.fake.addToken("live");
    for (const extra of [{}, { environment: "production" }]) {
      const r = await p.connectToken(live, extra, p.h.token());
      assert.equal(r.status, extra.environment ? 403 : 400, r.text);
      assert.equal(r.json.code, extra.environment ? "tradier_personal_only" : "tradier_token_rejected");
      if (extra.environment) assert.equal(r.json.error, TRADIER_DETAIL.ownerOnly);
    }
    assert.deepEqual(
      p.fake.state.calls.map((x) => x.host),
      ["sandbox"],
      "a user who is not the owner is never checked against Live: a Live token is only tried as Paper",
    );
    p.fake.state.calls.length = 0;
    const sandbox = p.fake.addToken("sandbox");
    const r = await p.connectToken(sandbox, {}, p.h.token());
    assert.equal(r.status, 200, r.text);
    const c = r.json.connection;
    assert.equal(c.environment, "paper", "the user's own paper account, labelled Paper");
    assert.deepEqual(
      c.accounts.map((/** @type {any} */ a) => [a.label, a.type]),
      [["Tradier Paper", "paper"]],
      "a single account arrives as a bare object",
    );
    assert.deepEqual(p.sealed(c.id), { token: sandbox, host: "sandbox" });
    assert.deepEqual(
      p.fake.state.calls.map((x) => x.host),
      ["sandbox"],
      "a user who is not the owner is never checked against Live",
    );
    const reads = await p.req("/v1/portfolio", { token: p.h.token() });
    assert.deepEqual(reads.json.errors, []);
    assert.deepEqual(reads.json.accounts, [{ accountId: p.accountId("VA00000001"), netLiq: 100_000, cash: 100_000, buyingPower: 200_000, currency: "USD" }]);

    const asLive = await p.connectToken(p.fake.addToken("sandbox"), { environment: "production" });
    assert.equal(asLive.status, 400);
    assert.equal(asLive.json.code, "tradier_token_rejected");
    assert.match(asLive.json.error, /as a Live token\. Copy the token under Production Account Access/);
    const asPaper = await p.connectToken(p.fake.addToken("live"), { environment: "paper" });
    assert.equal(asPaper.status, 400);
    assert.match(asPaper.json.error, /as a Paper token\. Copy the token under Sandbox Account Access/);
  } finally {
    await p.close();
  }
});

test("a stored paper connection is not read once sandbox tokens are switched off", async () => {
  const p = await setup({ env: { TRADIER_SANDBOX_TOKENS: "true" } });
  try {
    const r = await p.connectToken(p.fake.addToken("sandbox"), { environment: "paper" });
    assert.equal(r.status, 200, r.text);
    const id = r.json.connection.id;
    const off = createBrokerService(testConfig({ IBKR_GATEWAY_BUNDLE: "does-not-exist", BROKER_URL_OVERRIDES: JSON.stringify({ tradier: p.fake.urls }) }), {
      db: p.h.db,
      now: p.h.now,
      packages: [],
      adapters: [["tradier", createAdapter]],
    });
    const calls = p.fake.state.calls.length;
    const out = await off.service.portfolio(/** @type {any} */ ({ sub: p.h.user, wid: p.h.wid, role: "superadmin" }));
    assert.deepEqual(out.errors, [{ connectionId: id, message: TRADIER_DETAIL.sandboxOffRead }]);
    assert.equal(p.fake.state.calls.length, calls);
  } finally {
    await p.close();
  }
});

test("reads: balances, positions valued from quotes, collapsed collections everywhere", async () => {
  const s = await setup();
  try {
    const c = (await s.connectToken(s.fake.addToken("live"))).json.connection;
    const margin = s.accountId("6YA00001");
    const ira = s.accountId("6YA00002");
    const p = await s.req("/v1/portfolio");
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.errors, []);
    assert.deepEqual(
      p.json.accounts.find((/** @type {any} */ a) => a.accountId === margin),
      { accountId: margin, netLiq: 25_340.5, cash: 10_000.25, buyingPower: 40_000, currency: "USD" },
      "no day P&L: Tradier's balances do not report one",
    );
    assert.deepEqual(
      p.json.accounts.find((/** @type {any} */ a) => a.accountId === ira),
      { accountId: ira, netLiq: 5_000, cash: 2_950, buyingPower: 2_900, currency: "USD" },
      "a cash account's buying power is cash_available",
    );
    /** @param {string} sym */
    const pos = (sym) => {
      const x = p.json.positions.find((/** @type {any} */ y) => y.symbol === sym);
      return x && { accountId: x.accountId, qty: x.qty, avgCost: x.avgCost, last: x.last, marketValue: x.marketValue, unrealizedPnl: x.unrealizedPnl, secType: x.secType, dayPnl: x.dayPnl };
    };
    assert.equal(p.json.positions.length, 3);
    assert.deepEqual(pos("AAPL"), { accountId: margin, qty: 10, avgCost: 150.25, last: 151.5, marketValue: 1_515, unrealizedPnl: 12.5, secType: "STK", dayPnl: undefined });
    assert.deepEqual(pos("SPY261218C00600000"), { accountId: margin, qty: -2, avgCost: 3.1, last: 3.5, marketValue: -700, unrealizedPnl: -80, secType: "OPT", dayPnl: undefined });
    assert.deepEqual(pos("MSFT"), { accountId: ira, qty: 5, avgCost: 400, last: 410, marketValue: 2_050, unrealizedPnl: 50, secType: "STK", dayPnl: undefined }, "one position arrives as a bare object");
    const quotes = s.fake.state.calls.filter((x) => x.path === "/v1/markets/quotes");
    assert.equal(quotes.length, 1, "one quote read for every account");
    assert.deepEqual(quotes[0].query.symbols.split(",").sort(), ["AAPL", "MSFT", "SPY261218C00600000"]);
    assert.equal(quotes[0].query.greeks, "false");
    assert.equal(s.row(c.id)?.status, "active");
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("prices: a quote failure leaves the positions out with a sentence; an unpriced symbol is named; one refused account does not hide the others", async () => {
  const s = await setup();
  try {
    const c = (await s.connectToken(s.fake.addToken("live"))).json.connection;
    s.fake.state.failQuotes = 1;
    const p = await s.req("/v1/portfolio");
    assert.equal(p.json.accounts.length, 2, "the balances still show");
    assert.deepEqual(p.json.positions, [], "never shown at an invented price");
    assert.deepEqual(p.json.errors, [{ connectionId: c.id, message: TRADIER_DETAIL.noQuotes }]);

    s.later();
    s.fake.state.login.accounts[1].positions.push({ id: 202, symbol: "ZZZZ", quantity: 7, cost_basis: 70 });
    const q = await s.req("/v1/portfolio");
    assert.deepEqual(q.json.errors, [{ connectionId: c.id, message: "Tradier sent no price for ZZZZ, so its market value is not shown." }]);
    const z = q.json.positions.find((/** @type {any} */ x) => x.symbol === "ZZZZ");
    assert.deepEqual([z.qty, z.avgCost, z.last, z.marketValue, z.unrealizedPnl], [7, 10, undefined, undefined, undefined]);
    assert.equal(q.json.positions.length, 4);
    s.fake.state.login.accounts[1].positions.pop();

    s.later();
    s.fake.state.forbid.push({ host: "live", path: /^\/v1\/accounts\/6YA00001\/positions$/ });
    const f = await s.req("/v1/portfolio");
    assert.deepEqual(f.json.errors, [{ connectionId: c.id, message: TRADIER_DETAIL.accountRead("positions", "6YA•••01") }]);
    assert.deepEqual(
      f.json.positions.map((/** @type {any} */ x) => x.symbol),
      ["MSFT"],
    );
    assert.equal(f.json.accounts.length, 2);
    assert.equal(s.row(c.id)?.status, "active", "the token itself still works");
  } finally {
    await s.close();
  }
});

test("orders and executions: today's orders with their legs, today's fills from them, earlier fills from the history", async () => {
  const s = await setup();
  try {
    await s.connectToken(s.fake.addToken("live"));
    const margin = s.accountId("6YA00001");
    const o = await s.req("/v1/orders");
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    /** @param {string} id */
    const order = (id) => o.json.orders.find((/** @type {any} */ x) => x.id === `tradier:${margin}:${id}`);
    assert.equal(o.json.orders.length, 6, "five orders, the multileg one as its two legs");
    assert.deepEqual(
      (({ symbol, type, side, qty, price, tif, status, filledQty, avgFill, outsideRth, clientId, brokerRef }) => ({ symbol, type, side, qty, price, tif, status, filledQty, avgFill, outsideRth, clientId, brokerRef }))(order("1001")),
      { symbol: "AAPL", type: "LMT", side: "BUY", qty: 10, price: 150, tif: "DAY", status: "filled", filledQty: 10, avgFill: 149.96, outsideRth: false, clientId: "my-tag", brokerRef: "1001" },
    );
    assert.deepEqual(
      (({ type, side, price, tif, status }) => ({ type, side, price, tif, status }))(order("1002")),
      { type: "STP", side: "SELL", price: 140, tif: "GTC", status: "working" },
    );
    assert.deepEqual(
      (({ symbol, type, side, status }) => ({ symbol, type, side, status }))(order("1003")),
      { symbol: "SPY261218C00600000", type: "MKT", side: "SELL", status: "filled" },
      "an option order shows its OCC symbol",
    );
    assert.equal(order("1004"), undefined);
    assert.deepEqual(
      [order("1004:1005"), order("1004:1006")].map((x) => [x.symbol, x.side, x.qty, x.status, x.brokerRef, x.tif]),
      [
        ["SPY261218C00600000", "BUY", 1, "filled", "1004", "DAY"],
        ["SPY261218C00610000", "SELL", 1, "filled", "1004", "DAY"],
      ],
    );
    assert.deepEqual(
      (({ status, outsideRth, tif }) => ({ status, outsideRth, tif }))(order("1007")),
      { status: "submitted", outsideRth: true, tif: "DAY" },
      "a pre-market order is outside regular hours",
    );
    const orderCalls = s.fake.state.calls.filter((x) => x.path.endsWith("/orders"));
    assert.ok(orderCalls.every((x) => x.query.includeTags === "true" && x.query.limit === "1000" && x.query.page === "1"), "never Tradier's default of 25 orders");

    const before = s.fake.state.calls.filter((x) => x.path.endsWith("/orders")).length;
    const e = await s.req("/v1/executions");
    assert.equal(e.status, 200, e.text);
    assert.deepEqual(e.json.errors, []);
    assert.equal(s.fake.state.calls.filter((x) => x.path.endsWith("/orders")).length, before, "executions reuse the orders just read");
    const fills = e.json.executions;
    /** @param {(x: any) => boolean} f */
    const fill = (f) => {
      const x = fills.find(f);
      return x && { symbol: x.symbol, side: x.side, qty: x.qty, price: x.price, commission: x.commission, net: x.net, provisional: x.provisional };
    };
    assert.equal(fills.length, 7, "four of today's from the orders, three earlier ones from the history");
    assert.deepEqual(fill((x) => x.id.endsWith(":o:1001")), { symbol: "AAPL", side: "BUY", qty: 10, price: 149.96, commission: 0, net: -1_499.6, provisional: true });
    assert.deepEqual(fill((x) => x.id.endsWith(":o:1003")), { symbol: "SPY261218C00600000", side: "SELL", qty: 2, price: 3.1, commission: 0, net: 620, provisional: true });
    assert.deepEqual(fill((x) => x.id.endsWith(":o:1004:1005")), { symbol: "SPY261218C00600000", side: "BUY", qty: 1, price: 3.5, commission: 0, net: -350, provisional: true });
    assert.deepEqual(fill((x) => x.id.endsWith(":o:1004:1006")), { symbol: "SPY261218C00610000", side: "SELL", qty: 1, price: 2.25, commission: 0, net: 225, provisional: true });
    const history = fills.filter((/** @type {any} */ x) => x.id.includes(":h:"));
    assert.deepEqual(
      history.map((/** @type {any} */ x) => [x.symbol, x.side, x.qty, x.price, x.commission, x.net, x.provisional]).sort(),
      [
        ["AAPL", "BUY", 10, 150.25, 0, -1_502.5, true],
        ["MSFT", "BUY", 5, 400, 0, -2_000, true],
        ["SPY261218C00600000", "SELL", 2, 3.1, 1.3, 618.7, true],
      ],
      "no dividend, nothing from today again, nothing older than 60 days",
    );
    // A history event has a date only: the fill sits at that day's close, on the right New York day.
    const today = etDateKey(s.h.now());
    const aapl = history.find((/** @type {any} */ x) => x.symbol === "AAPL");
    const [y, m, d] = new Date(Date.parse(`${today}T12:00:00Z`) - 3 * DAY).toISOString().slice(0, 10).split("-").map(Number);
    assert.equal(aapl.tradedAt, new Date(etToUtc(y, m, d, 16, 0)).toISOString());

    const hist = s.fake.state.calls.filter((x) => x.path.endsWith("/history"));
    assert.equal(hist.length, 2, "one history read per account");
    for (const x of hist) {
      assert.equal(x.query.type, "trade");
      assert.equal(x.query.end < today, true, "up to yesterday: today's fills come from the orders");
      assert.equal(Math.round((Date.parse(today) - Date.parse(x.query.start)) / DAY), 60);
    }
    s.h.advance(2 * 60_000);
    await s.req("/v1/executions");
    assert.equal(s.fake.state.calls.filter((x) => x.path.endsWith("/history")).length, 2, "the history is kept 10 minutes");
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

/** "2026-11-16" shifted by `days` (calendar arithmetic). @param {string} key @param {number} days */
const shift = (key, days) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

test("orders: more than Tradier's default 25 today are all read, a page of 1000 at a time", async () => {
  const s = await setup();
  try {
    await s.connectToken(s.fake.addToken("live"));
    const margin = s.accountId("6YA00001");
    // An active day: 1,030 orders, every other one filled.
    s.fake.state.login.accounts[0].orders = (now) =>
      Array.from({ length: 1_030 }, (_, i) => ({
        id: 5_000 + i,
        type: "limit",
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        price: 150,
        status: i % 2 ? "filled" : "open",
        duration: "day",
        avg_fill_price: i % 2 ? 149.5 : 0,
        exec_quantity: i % 2 ? 1 : 0,
        create_date: new Date(now - (i + 1) * 1_000).toISOString(),
        transaction_date: new Date(now - (i + 1) * 1_000).toISOString(),
        class: "equity",
      }));
    s.later();
    const o = await s.req("/v1/orders");
    assert.equal(o.status, 200, o.text);
    assert.deepEqual(o.json.errors, []);
    const mine = o.json.orders.filter((/** @type {any} */ x) => x.accountId === margin);
    assert.equal(mine.length, 1_030, "every order of the session");
    assert.equal(new Set(mine.map((/** @type {any} */ x) => x.id)).size, 1_030);
    assert.deepEqual(
      s.fake.state.calls.filter((x) => x.path === "/v1/accounts/6YA00001/orders").map((x) => [x.query.limit, x.query.page]),
      [
        ["1000", "1"],
        ["1000", "2"],
      ],
      "a full page reads the next one; a short page ends the read",
    );
    const e = await s.req("/v1/executions");
    assert.deepEqual(e.json.errors, []);
    assert.equal(e.json.executions.filter((/** @type {any} */ x) => x.id.includes(":o:")).length, 515, "today's fills of every order");
  } finally {
    await s.close();
  }
});

test("executions: an earlier day's order still in /orders counts until the history has that day's trade, never twice", async () => {
  const s = await setup();
  try {
    await s.connectToken(s.fake.addToken("live"));
    const today = etDateKey(s.h.now());
    const yesterday = shift(today, -1);
    const [y, m, d] = yesterday.split("-").map(Number);
    const at = new Date(etToUtc(y, m, d, 15, 0)).toISOString();
    const acct = s.fake.state.login.accounts[0];
    const baseOrders = acct.orders;
    acct.orders = (now) => [
      ...baseOrders(now),
      { id: 9001, type: "market", symbol: "NVDA", side: "buy", quantity: 4, status: "filled", duration: "day", avg_fill_price: 100, exec_quantity: 4, create_date: at, transaction_date: at, class: "equity" },
    ];
    const nvda = async () => (await s.req("/v1/executions")).json.executions.filter((/** @type {any} */ x) => x.symbol === "NVDA");

    const before = await nvda();
    assert.deepEqual(
      before.map((/** @type {any} */ x) => [x.id.split(":").slice(2).join(":"), x.qty, x.price]),
      [["o:9001", 4, 100]],
      "the history does not have it yet: shown from the order",
    );

    const baseHistory = acct.history;
    acct.history = (now) => [...baseHistory(now), { amount: -400, date: `${yesterday}T00:00:00Z`, type: "trade", trade: { commission: 0, price: 100, quantity: 4, symbol: "NVDA", trade_type: "Equity" } }];
    s.later();
    const after = await nvda();
    assert.equal(after.length, 1, "once, from the history");
    assert.match(after[0].id, /:h:/);
    assert.equal(etDateKey(Date.parse(after[0].tradedAt)), yesterday);
  } finally {
    await s.close();
  }
});

test("history: an account with more trades than one read takes is read over fewer days, whole", async () => {
  const s = await setup();
  try {
    await s.connectToken(s.fake.addToken("live"));
    const today = etDateKey(s.h.now());
    // 40 trades a day on each of the last 53 days: 2,120 in the 60-day window, over 4 pages of 500.
    s.fake.state.login.accounts[0].history = () =>
      Array.from({ length: 2_120 }, (_, i) => ({
        amount: -(10 + i / 100),
        date: `${shift(today, -1 - Math.floor(i / 40))}T00:00:00Z`,
        type: "trade",
        trade: { commission: 0, price: 10 + i / 100, quantity: 1, symbol: "F", trade_type: "Equity" },
      }));
    s.fake.state.login.accounts[0].orders = () => [];
    const e = await s.req("/v1/executions");
    assert.equal(e.status, 200, e.text);
    assert.deepEqual(e.json.errors, []);
    const f = e.json.executions.filter((/** @type {any} */ x) => x.symbol === "F");
    const days = new Set(f.map((/** @type {any} */ x) => etDateKey(Date.parse(x.tradedAt))));
    assert.equal(f.length, 30 * 40, "every trade of the last 30 days, none from a day read in part");
    assert.equal(days.size, 30);
    assert.ok([...days].every((k) => k >= shift(today, -30) && k < today));
    const reads = s.fake.state.calls.filter((x) => x.path === "/v1/accounts/6YA00001/history");
    assert.deepEqual(
      reads.map((x) => [x.query.start, x.query.page]),
      [
        [shift(today, -60), "1"],
        [shift(today, -60), "2"],
        [shift(today, -60), "3"],
        [shift(today, -60), "4"],
        [shift(today, -30), "1"],
        [shift(today, -30), "2"],
        [shift(today, -30), "3"],
      ],
      "four full pages: read again over half the days",
    );
  } finally {
    await s.close();
  }
});

test("one account's refused orders name that account", async () => {
  const s = await setup();
  try {
    const c = (await s.connectToken(s.fake.addToken("live"))).json.connection;
    s.fake.state.forbid.push({ host: "live", path: /^\/v1\/accounts\/6YA00002\/orders$/ });
    const o = await s.req("/v1/orders");
    assert.deepEqual(o.json.errors, [{ connectionId: c.id, message: "Tradier refused to send the orders of account 6YA•••02 (403)." }]);
    s.fake.state.forbid.length = 0;
    s.fake.state.forbid.push({ host: "live", path: /^\/v1\/accounts\/6YA00002\/history$/ });
    s.later();
    const e = await s.req("/v1/executions");
    assert.deepEqual(e.json.errors, [{ connectionId: c.id, message: "Tradier refused to send the trade history of account 6YA•••02 (403)." }]);
    assert.equal(s.row(c.id)?.status, "active", "the token itself still works");
  } finally {
    await s.close();
  }
});

test("Quota Violation: a 429 with Retry-After until Tradier's stated end, and the bucket waits", async () => {
  const s = await setup();
  try {
    // The client alone: the 400 "Quota Violation: Expires <ms>" becomes a 429 that waits for that end.
    const limiter = createLimiter({ now: s.h.now });
    const client = createTradierClient({
      makeHttp: (o) => createBrokerHttp({ ...o, limiter, fetch: quotaAwareFetch(fetch, s.h.now), now: s.h.now }),
      base: s.fake.urls.live,
      token: s.fake.addToken("live"),
      bucketKey: "tradier:test-connection",
      ratePerSec: 2,
    });
    s.fake.state.quota.push({ host: "live", expiresInMs: 30_000 });
    await assert.rejects(client.balances("6YA00001"), (e) => e instanceof HttpError && e.status === 429 && Number(e.retryAfterSec) >= 29 && /^Tradier is limiting requests right now/.test(e.message));
    const calls = s.fake.state.calls.length;
    await assert.rejects(client.positions("6YA00001"), (e) => e instanceof HttpError && e.status === 429);
    assert.equal(s.fake.state.calls.length, calls, "paused: nothing more reached Tradier");
    assert.equal((await client.quotes(["AAPL"])).length, 1);
    assert.equal(s.fake.state.calls.length, calls + 1, "market data is its own bucket at Tradier and here");
    s.h.advance(31_000);
    assert.ok((await client.balances("6YA00001")).balances);

    // Through the service: the read answers the sentence; a connect step answers 429 with Retry-After.
    const c = (await s.connectToken(s.fake.addToken("live"))).json.connection;
    s.fake.state.quota.push({ host: "live", path: /\/positions$/, expiresInMs: 20_000 });
    const p = await s.req("/v1/portfolio");
    assert.match(p.json.errors.find((/** @type {any} */ x) => x.connectionId === c.id)?.message ?? "", /^Tradier is limiting requests right now/);
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    s.fake.state.quota.push({ host: "live", path: /\/v1\/user\/profile$/, expiresInMs: 20_000 });
    const step = await s.connectToken(s.fake.addToken("live"));
    assert.equal(step.status, 429);
    assert.ok(Number(step.headers.get("retry-after")) >= 19);
  } finally {
    await s.close();
  }
});

test("a regenerated token expires the connection; renew asks for the token; another login's token is a 409; the new token reconnects", async () => {
  const s = await setup();
  try {
    const token = s.fake.addToken("live");
    const id = (await s.connectToken(token)).json.connection.id;
    const ok = await s.req(`/v1/connections/${id}/renew`, { method: "POST" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.next, undefined, "a working token needs nothing");

    s.later();
    const fresh = s.fake.regenerate(token);
    const r = await s.req("/v1/portfolio");
    assert.deepEqual(r.json.errors, [{ connectionId: id, message: TRADIER_DETAIL.tokenRefused }]);
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, "Tradier no longer accepts this token. Paste the new token.");

    const renew = await s.req(`/v1/connections/${id}/renew`, { method: "POST" });
    assert.equal(renew.status, 200, renew.text);
    assert.deepEqual(renew.json.next, { kind: "api_key" });

    const other = s.fake.addToken("live", { ...defaultLogin(), id: "id-someone-else" });
    const wrong = await s.connectToken(other, { connectionId: id });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.code, "other_account");

    const fixed = await s.connectToken(fresh, { connectionId: id });
    assert.equal(fixed.status, 200, fixed.text);
    assert.equal(fixed.json.connection.id, id);
    assert.equal(fixed.json.connection.status, "active");
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
  } finally {
    await s.close();
  }
});

test("OAuth: Nasscord's partner client, no redirect_uri, Basic auth, a 24-hour login the sweep ends, Reconnect approves again", async () => {
  const s = await setup({ platform: true });
  try {
    const t0 = s.h.now();
    const run = await s.connectOAuth();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const u = new URL(String(run.hop?.json.redirectUrl));
    assert.equal(`${u.origin}${u.pathname}`, `${s.fake.urls.live}/v1/oauth/authorize`);
    assert.equal(u.searchParams.get("client_id"), CLIENT.id);
    assert.equal(u.searchParams.get("scope"), "read market");
    assert.ok(u.searchParams.get("state"));
    assert.equal(u.searchParams.has("redirect_uri"), false, "Tradier uses the URI registered with the client");
    assert.equal(run.approval?.callbackUrl, CALLBACK);
    assert.deepEqual(s.fake.state.tokenCalls, [{ path: "/v1/oauth/accesstoken", grant: "authorization_code", status: 200 }], "exchanged with Basic auth and no redirect_uri");

    const c = /** @type {any} */ (run.connection);
    const id = String(run.connectionId);
    assert.equal(c.method, "tradier_oauth");
    assert.equal(c.environment, "production");
    assert.equal(c.status, "active");
    assert.equal(c.accounts.length, 2);
    assert.ok(Math.abs(Date.parse(c.sessionExpiresAt) - (t0 + DAY)) < 60_000, "without refresh tokens the login ends with the 24-hour access token");
    assert.equal(s.row(id)?.external_ref, "id-tradier-owner");
    assert.equal(s.row(id)?.scope, "read market");
    const secret = /** @type {any} */ (s.sealed(id));
    assert.equal(secret.client, "platform");
    assert.equal(secret.redirectUri, CALLBACK);
    assert.equal(secret.clientId, undefined, "the partner client stays in the service env");
    assert.equal(secret.clientSecret, undefined);
    assert.equal(secret.refreshToken, undefined);
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);

    s.h.advance(23 * HOUR);
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "active");
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);

    s.h.advance(t0 + DAY + 60_000 - s.h.now());
    await s.h.svc.scheduler.tick();
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.row(id)?.status_detail, TRADIER_DETAIL.daily);
    assert.equal(s.fake.state.tokenCalls.length, 1, "no refresh is tried without refresh tokens");
    assert.ok(s.h.rows("audit_events").some((a) => a.action === "broker.session.expired" && String(a.target).includes(id)));
    assert.equal(/** @type {any} */ (s.sealed(id)).accessToken, undefined, "the tokens are dropped");

    const t1 = s.h.now();
    const again = await s.connectOAuth({ connectionId: id });
    assert.equal(again.failedAt, undefined, JSON.stringify(again.res?.json));
    const c2 = /** @type {any} */ (again.connection);
    assert.equal(c2.id, id);
    assert.equal(c2.status, "active");
    assert.ok(Math.abs(Date.parse(c2.sessionExpiresAt) - (t1 + DAY)) < 60_000);
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);

    // The user revoked Nasscord at Tradier: the next read ends the login.
    s.fake.revokeAccess();
    s.later();
    const dead = await s.req("/v1/portfolio");
    assert.deepEqual(dead.json.errors, [{ connectionId: id, message: TRADIER_DETAIL.ended }]);
    assert.equal(s.row(id)?.status, "expired");
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("OAuth with refresh tokens: refreshed at /v1/oauth/refreshtoken in the last hour, once for concurrent callers; a dead grant ends the login", async () => {
  const s = await setup({ platform: true, refreshTokens: true });
  try {
    const run = await s.connectOAuth();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const id = String(run.connectionId);
    assert.equal(/** @type {any} */ (run.connection).sessionExpiresAt, null, "refresh tokens do not expire");
    const refreshes = () => s.fake.state.tokenCalls.filter((c) => c.path === "/v1/oauth/refreshtoken" && c.status === 200).length;

    s.h.advance(22 * HOUR);
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(refreshes(), 0, "no refresh while more than an hour is left");

    s.h.advance(HOUR + 60_000);
    const [, p, o] = await Promise.all([s.h.svc.scheduler.tick(), s.req("/v1/portfolio"), s.req("/v1/orders")]);
    assert.deepEqual(p.json.errors, []);
    assert.deepEqual(o.json.errors, []);
    assert.equal(refreshes(), 1, "one refresh under the token lock, shared by the sweep and both reads");
    assert.equal(s.row(id)?.status, "active");
    assert.equal(s.row(id)?.session_expires_at, null);

    // Tradier ended the access token early: one refresh and the read goes on.
    s.fake.revokeAccess();
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, []);
    assert.equal(refreshes(), 2);

    // The grant itself is gone: the refresh is refused and the login ends.
    s.fake.revokeAccess();
    s.fake.state.refresh.clear();
    s.later();
    const dead = await s.req("/v1/portfolio");
    assert.deepEqual(dead.json.errors, [{ connectionId: id, message: TRADIER_DETAIL.ended }]);
    assert.equal(s.row(id)?.status, "expired");
    assert.equal(s.h.svc.oauth2.circuitOpen("tradier"), false, "one user's dead grant pauses nobody");
    assert.deepEqual(s.outsideAllowlist(), []);
  } finally {
    await s.close();
  }
});

test("a crash between Tradier's token answer and the database write loses nothing; a restarted service reads with the saved token", async () => {
  const s = await setup({ platform: true, refreshTokens: true });
  try {
    const run = await s.connectOAuth();
    const id = String(run.connectionId);
    const refreshes = () => s.fake.state.tokenCalls.filter((c) => c.path === "/v1/oauth/refreshtoken").length;
    const before = /** @type {any} */ (s.sealed(id)).accessToken;
    s.h.advance(23 * HOUR + 60_000);
    // The sweep is the only caller: Tradier answers a new token, and saving it fails.
    s.h.db.failNext.set("broker_secrets", new Error("database down"));
    await s.h.svc.scheduler.tick();
    assert.equal(refreshes(), 1);
    assert.equal(s.row(id)?.status, "active", "a failed save does not end the login");
    assert.equal(/** @type {any} */ (s.sealed(id)).accessToken, before, "nothing unsaved was kept");
    assert.ok(s.h.logLines.some((l) => l.includes("adapter refresh failed for a connection")));
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, [], "the refresh token still works");
    assert.equal(refreshes(), 2);
    assert.notEqual(/** @type {any} */ (s.sealed(id)).accessToken, before);

    const again = createBrokerService(
      testConfig({
        IBKR_GATEWAY_BUNDLE: "does-not-exist",
        BROKER_URL_OVERRIDES: JSON.stringify({ tradier: s.fake.urls }),
        TRADIER_CLIENT_ID: CLIENT.id,
        TRADIER_CLIENT_SECRET: CLIENT.secret,
        TRADIER_REFRESH_TOKENS: "true",
      }),
      { db: s.h.db, now: s.h.now, packages: [], adapters: [["tradier", createAdapter]] },
    );
    const out = await again.service.orders(/** @type {any} */ ({ sub: s.h.user, wid: s.h.wid, role: "superadmin" }));
    assert.deepEqual(out.errors, []);
    assert.ok(out.orders.some((x) => x.brokerRef === "1001"));
    assert.equal(refreshes(), 2, "the access token saved by the first process is still good");
  } finally {
    await s.close();
  }
});

test("read only: the allowlist holds six GETs; order calls are refused before the network", async () => {
  const allow = [...TRADIER_READ_ALLOW];
  for (const path of [
    "/v1/user/profile",
    "/v1/accounts/6YA00001/balances",
    "/v1/accounts/6YA00001/positions",
    "/v1/accounts/6YA00001/orders",
    "/v1/accounts/6YA00001/history",
    "/v1/markets/quotes",
  ]) {
    assert.equal(isAllowed(allow, "GET", path), true, path);
  }
  for (const [method, path] of [
    ["POST", "/v1/accounts/6YA00001/orders"],
    ["PUT", "/v1/accounts/6YA00001/orders/123"],
    ["DELETE", "/v1/accounts/6YA00001/orders/123"],
    ["GET", "/v1/accounts/6YA00001/orders/123"],
    ["POST", "/v1/accounts/events/session"],
    ["POST", "/v1/markets/events/session"],
    ["GET", "/v1/watchlists"],
    ["POST", "/v1/watchlists"],
    ["GET", "/v1/accounts/6YA00001/gainloss"],
    ["POST", "/v1/markets/quotes"],
    ["GET", "/v1/accounts/6YA00001/../orders"],
    ["GET", "/v1/accounts/6YA00001%2forders"],
    ["GET", "/v1/accounts/6YA-0001/balances"],
    ["POST", "/v1/oauth/accesstoken"],
    ["POST", "/v1/user/profile"],
  ]) {
    assert.equal(isAllowed(allow, method, path), false, `${method} ${path}`);
  }
  assert.deepEqual(
    [...TRADIER_TOKEN_ALLOW].map(([m, re]) => [m, re.source]),
    [
      ["POST", "^\\/v1\\/oauth\\/accesstoken$"],
      ["POST", "^\\/v1\\/oauth\\/refreshtoken$"],
    ],
    "the token endpoints are the only writes",
  );

  let fetched = 0;
  /** @type {typeof fetch} */
  const countingFetch = async () => {
    fetched += 1;
    return new Response(JSON.stringify({ positions: "null" }), { status: 200 });
  };
  const client = createTradierClient({ makeHttp: (o) => createBrokerHttp({ ...o, fetch: countingFetch }), base: "https://api.tradier.com", token: "t0ken-value", bucketKey: "tradier:x", ratePerSec: 2 });
  await assert.rejects(client.http.request("POST", "/v1/accounts/6YA00001/orders", { form: { class: "equity", symbol: "AAPL", side: "buy", quantity: 1, type: "market", duration: "day" } }), ReadOnlyViolation);
  await assert.rejects(client.http.request("POST", "/v1/accounts/6YA00001/orders", { form: { preview: "true" } }), ReadOnlyViolation);
  await assert.rejects(client.http.request("DELETE", "/v1/accounts/6YA00001/orders/1"), ReadOnlyViolation);
  await assert.rejects(client.http.request("PUT", "/v1/accounts/6YA00001/orders/1"), ReadOnlyViolation);
  assert.equal(fetched, 0, "nothing reached the network");
  assert.deepEqual(await client.positions("6YA00001"), []);
  assert.equal(fetched, 1);
  await assert.rejects(client.balances("../orders"), /letters and digits/);
  assert.equal(fetched, 1);

  assert.deepEqual(tradierHosts({ live: "http://127.0.0.1:1", sandbox: "http://127.0.0.1:2" }, true), {
    live: "https://api.tradier.com",
    sandbox: "https://sandbox.tradier.com",
    oauth: "https://api.tradier.com",
  }, "fake hosts are never used in production");
});

test("the same Tradier login by token and then by OAuth is one connection: it moves to OAuth and keeps its switches", async () => {
  const s = await setup({ platform: true });
  try {
    const first = (await s.connectToken(s.fake.addToken("live"))).json.connection;
    const ira = s.h.rows("broker_accounts").find((a) => a.connection_id === first.id && a.external_id === "6YA00002");
    if (ira) ira.included = false;
    const run = await s.connectOAuth();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const c = /** @type {any} */ (run.connection);
    assert.equal(c.id, first.id, "the claim answers the existing connection");
    assert.equal(c.method, "tradier_oauth");
    assert.equal(s.h.rows("broker_connections").filter((r) => r.broker_id === "tradier").length, 1);
    assert.equal(s.h.rows("broker_accounts").find((a) => a.connection_id === first.id && a.external_id === "6YA00002")?.included, false);
    const secret = /** @type {any} */ (s.sealed(first.id));
    assert.equal(secret.token, undefined, "the pasted token is replaced whole");
    assert.equal(secret.client, "platform");
    s.later();
    assert.deepEqual((await s.req("/v1/portfolio")).json.errors, [], "it reads with the OAuth token");
  } finally {
    await s.close();
  }
});

test("no secret in logs, audit rows, connection rows or answers; Disconnect calls nobody", async () => {
  const s = await setup({ platform: true, env: { TRADIER_SANDBOX_TOKENS: "true" } });
  try {
    // A paper token (Sandbox) and the Live login by OAuth: two connections.
    const token = s.fake.addToken("sandbox");
    const tokenConn = (await s.connectToken(token, { environment: "paper" })).json.connection;
    const run = await s.connectOAuth();
    assert.equal(run.failedAt, undefined, JSON.stringify(run.res?.json));
    const oauthId = String(/** @type {any} */ (run.connection).id);
    assert.notEqual(oauthId, tokenConn.id);
    for (const path of ["/v1/portfolio", "/v1/orders", "/v1/executions", `/v1/connections/${tokenConn.id}`, `/v1/connections/${oauthId}`, "/v1/options"]) await s.req(path);
    // A refused token and an ended login write their sentences, never the values.
    s.fake.regenerate(token);
    s.fake.revokeAccess();
    s.later();
    await s.req("/v1/portfolio");
    await s.h.svc.scheduler.tick();
    await s.connectToken("not-a-real-tradier-token");

    const needles = [...s.fake.state.issued, CLIENT.secret, "not-a-real-tradier-token", "Pat Example"];
    const haystacks = {
      logs: s.h.logLines.join("\n"),
      audit: JSON.stringify(s.h.rows("audit_events")),
      connections: JSON.stringify(s.h.rows("broker_connections")),
      accounts: JSON.stringify(s.h.rows("broker_accounts")),
      pending: JSON.stringify(s.h.rows("broker_oauth_pending")),
      answers: s.replies.join("\n"),
    };
    for (const [where, text] of Object.entries(haystacks)) {
      for (const n of needles) assert.ok(!text.includes(n), `${where} holds a secret value or a name`);
    }
    for (const n of ["6YA00001", "6YA00002", "id-tradier-owner"]) {
      assert.ok(!haystacks.logs.includes(n), `no account number or login id in the logs: ${n}`);
      assert.ok(!haystacks.answers.includes(n), `account numbers are only shown masked: ${n}`);
    }

    const calls = s.fake.state.calls.length;
    for (const id of [tokenConn.id, oauthId]) {
      const del = await s.req(`/v1/connections/${id}`, { method: "DELETE" });
      assert.equal(del.status, 200);
      assert.equal(s.sealed(id), null, "the token and the tokens are deleted");
      assert.equal(s.row(id)?.status, "disconnected");
    }
    assert.equal(s.fake.state.calls.length, calls, "Tradier has no revocation API; nothing is called");
  } finally {
    await s.close();
  }
});
