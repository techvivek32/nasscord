import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createStore } from "../src/db.mjs";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp } from "../src/http.mjs";
import { createLocks } from "../src/locks.mjs";
import { silentLogger } from "../src/log.mjs";
import { createSecretBox } from "../src/secrets.mjs";
import { createSnapTradeClient, SNAPTRADE_ALLOW, snaptradeBase } from "../src/snaptrade/client.mjs";
import { SNAPTRADE_DAILY_DESCRIPTOR, SNAPTRADE_DESCRIPTOR, SNAPTRADE_DETAIL, createAdapter } from "../src/snaptrade/index.mjs";
import { activityTime, snaptradeExecutions, snaptradeOptionPosition, snaptradePosition } from "../src/snaptrade/mapping.mjs";
import { createSnapTradeUsers } from "../src/snaptrade/users.mjs";
import { etDateKey, etToUtc } from "../src/time.mjs";
import { sleep } from "./helpers/common.mjs";
import { snapTimeText, startFakeSnapTrade } from "./helpers/fake-snaptrade.mjs";
import { createHarness, newBinding } from "./helpers/harness.mjs";
import { createMemoryDb } from "./helpers/memory-db.mjs";

/**
 * SnapTrade end to end: the service (memory database, real flows, registry and scheduler) against a
 * fake SnapTrade API and Connection Portal. Tests run in order and share the workspace.
 */

const CLIENT_ID = "NASSCORD-TEST";
const CONSUMER_KEY = randomBytes(24).toString("base64url");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CALLBACK = "http://localhost:3000/api/broker/callback/snaptrade";

/** @type {Awaited<ReturnType<typeof startFakeSnapTrade>>} */
let fake;
/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** Every reply body the tests received. */
const replies = /** @type {string[]} */ ([]);

let fidelityId = "";
let fidelityAuth = "";
let robinhoodId = "";
let robinhoodAuth = "";
let publicId = "";
let publicAuth = "";
/** SnapTrade account ids of the Fidelity connection. */
let fidelityAccount = "";
let t0 = 0;
let through = "";

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, token?: string }} [o]
 */
async function req(path, o) {
  const r = await h.req(path, o);
  replies.push(r.text);
  return r;
}

/** @param {string} id */
const row = (id) => h.rows("broker_connections").find((r) => r.id === id);
/** "2026-11-15" for "2026-11-14". @param {string} day */
const dayAfter = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
/**
 * A signed webhook from SnapTrade for the workspace's SnapTrade user, posted to /hooks/snaptrade.
 * @param {Record<string, unknown>} p
 */
async function sendHook(p) {
  const w = fake.webhook({ webhookId: randomUUID(), clientId: CLIENT_ID, eventTimestamp: new Date(h.now()).toISOString(), userId: snapUserId(), ...p });
  const r = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "content-type": "application/json", signature: w.signature }, body: w.body });
  return { status: r.status, json: await r.json(), w };
}
/** The workspace's SnapTrade user id at the fake. */
const snapUserId = () => String(h.rows("broker_aggregator_users").find((r) => r.workspace_id === h.wid)?.external_user_id ?? "");

/**
 * start (user's host) -> hop (canonical host).
 * @param {string} brokerId
 * @param {{ token?: string }} [o]
 */
async function startAndHop(brokerId, o = {}) {
  const b = newBinding();
  const start = await req("/v1/aggregator/start", { method: "POST", token: o.token, body: { brokerId, returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(start.status, 200, start.text);
  const id = start.json.connectionId;
  const hop = await req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: id, binding: b.nonce } });
  return { b, id, hop };
}

/**
 * The portal login, the canonical callback and the claim.
 * @param {Awaited<ReturnType<typeof startAndHop>>} s
 * @param {{ token?: string, authorizationId?: string }} [o]
 */
async function finish(s, o = {}) {
  assert.equal(s.hop.status, 200, s.hop.text);
  const back = await fake.follow(s.hop.json.redirectUrl);
  assert.equal(back.status, 302);
  const u = new URL(back.location);
  assert.equal(`${u.origin}${u.pathname}`, CALLBACK, "SnapTrade sends the browser to the canonical callback only");
  assert.equal(u.searchParams.get("cid"), s.id);
  const authorizationId = o.authorizationId ?? u.searchParams.get("connection_id") ?? undefined;
  const done = await req("/v1/aggregator/complete", {
    method: "POST",
    token: h.flowToken(),
    body: { connectionId: s.id, status: u.searchParams.get("status"), authorizationId, binding: s.b.nonce },
  });
  if (done.status !== 200) return { done, authorizationId };
  const claim = await req("/v1/connect/claim", { method: "POST", token: o.token, body: { connectionId: s.id, ticket: done.json.ticket, binding: s.b.nonce } });
  return { done, claim, authorizationId };
}

/** @param {string} ticker @param {string} code */
const stock = (ticker, code) => ({ id: `sym-${ticker}`, symbol: ticker, raw_symbol: ticker, description: `${ticker} Inc`, currency: { code: "USD" }, type: { code, description: code } });
/** @param {any} u @param {number} units @param {number} price @param {number | null} avg @param {number | null} pnl */
const position = (u, units, price, avg, pnl) => ({ symbol: { symbol: u, id: `pos-${u.symbol}`, description: u.description }, units, price, average_purchase_price: avg, open_pnl: pnl, currency: { code: "USD" } });
const OPTION = { id: "opt-aapl-c150", ticker: "AAPL  251219C00150000", option_type: "CALL", strike_price: 150, expiration_date: "2025-12-19", is_mini_option: false, underlying_symbol: stock("AAPL", "cs") };

/** @param {number} ms @param {number} h24 @param {number} m */
const etAt = (ms, h24, m) => {
  const [y, mo, d] = etDateKey(ms).split("-").map(Number);
  return etToUtc(y, mo, d, h24, m);
};
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();

/** The Fidelity account: balances, stocks, an option, orders and transactions. @param {number} t */
function fidelitySpec(t) {
  const d4 = etDateKey(t - 4 * DAY);
  const d3 = etDateKey(t - 3 * DAY);
  /** @param {string} id @param {Record<string, unknown>} x */
  const order = (id, x) => ({
    brokerage_order_id: id,
    status: "EXECUTED",
    universal_symbol: stock("AAPL", "cs"),
    option_symbol: null,
    action: "BUY",
    total_quantity: "1",
    open_quantity: "0",
    canceled_quantity: "0",
    filled_quantity: "0",
    execution_price: null,
    limit_price: null,
    stop_price: null,
    order_type: "Market",
    time_in_force: "Day",
    time_placed: iso(t - 60 * MIN),
    time_updated: iso(t - 60 * MIN),
    time_executed: null,
    ...x,
  });
  return {
    name: "Individual - TOD X12345678",
    number: "X12345678",
    rawType: "Margin",
    total: 25000.55,
    holdingsSync: snapTimeText(t - 8 * MIN),
    txThrough: etDateKey(t - 2 * DAY),
    balances: [
      { currency: { id: "cad", code: "CAD", name: "Canadian Dollar" }, cash: 5, buying_power: 5 },
      { currency: { id: "usd", code: "USD", name: "US Dollar" }, cash: 1200.1, buying_power: 2400.2 },
    ],
    positions: [position(stock("AAPL", "cs"), 10, 160, 150, 100), position(stock("VOO", "et"), 2, 500, 450, null), position(stock("FXAIX", "oef"), 3.5, 200, 180, 70)],
    options: [{ symbol: { id: "pos-opt-1", option_symbol: OPTION, description: "AAPL Dec 19 2025 150 Call" }, price: 3.1, units: 1, average_purchase_price: 250, currency: { code: "USD" } }],
    orders: [
      order("o-filled-aapl", { filled_quantity: "10", total_quantity: "10", execution_price: "150", limit_price: "150.5", order_type: "Limit", time_placed: iso(etAt(t - 4 * DAY, 14, 0)), time_executed: iso(etAt(t - 4 * DAY, 14, 30)) }),
      order("o-tsla", { universal_symbol: stock("TSLA", "cs"), action: "SELL", total_quantity: "2", filled_quantity: "2", execution_price: "200", time_executed: iso(t - 60 * MIN) }),
      order("o-partial", {
        status: "PARTIAL",
        universal_symbol: stock("NVDA", "cs"),
        total_quantity: "10",
        filled_quantity: "5",
        open_quantity: "5",
        execution_price: "50",
        limit_price: "50",
        order_type: "Limit",
        time_in_force: "GTC",
        time_placed: iso(t - 120 * MIN),
        time_executed: iso(t - 90 * MIN),
      }),
      order("o-pending", { status: "PENDING", universal_symbol: stock("F", "cs"), total_quantity: "100", limit_price: "12", order_type: "Limit", time_placed: iso(t - 30 * MIN) }),
      order("o-canceled", { status: "CANCELED", universal_symbol: stock("F", "cs"), action: "SELL", total_quantity: "50", canceled_quantity: "50", stop_price: "11", limit_price: "10.9", order_type: "StopLimit", time_placed: iso(t - 180 * MIN) }),
      order("o-old-gtc", { status: "ACCEPTED", universal_symbol: stock("SPY", "et"), limit_price: "400", order_type: "Limit", time_in_force: "GTC", time_placed: iso(t - 60 * DAY) }),
      order("o-option", { universal_symbol: null, option_symbol: OPTION, action: "BUY_OPEN", filled_quantity: "1", execution_price: "2.5", order_type: "Limit", limit_price: "2.5", time_placed: iso(etAt(t - 3 * DAY, 10, 0)), time_executed: iso(etAt(t - 3 * DAY, 10, 1)) }),
      order("o-rejected", { status: "REJECTED", universal_symbol: stock("GME", "cs"), time_placed: iso(t - 240 * MIN) }),
    ],
    activities: [
      { id: "act-aapl", symbol: stock("AAPL", "cs"), option_symbol: null, price: 150, units: 10, amount: -1501, fee: 1, type: "BUY", trade_date: `${d4}T00:00:00Z`, currency: { code: "USD" } },
      { id: "act-msft", symbol: stock("MSFT", "cs"), option_symbol: null, price: 300, units: -5, amount: 1499.5, fee: 0.5, type: "SELL", trade_date: `${d3}T00:00:00Z`, currency: { code: "USD" } },
      { id: "act-opt", symbol: null, option_symbol: OPTION, price: 2.5, units: 1, amount: -250.65, fee: 0.65, type: "BUY", option_type: "BUY_TO_OPEN", trade_date: `${d3}T00:00:00Z`, currency: { code: "USD" } },
      { id: "act-div", symbol: stock("AAPL", "cs"), price: 0, units: 0, amount: 2.4, fee: 0, type: "DIVIDEND", trade_date: `${d3}T00:00:00Z` },
      { id: "act-old", symbol: stock("F", "cs"), price: 10, units: 1, amount: -10, fee: 0, type: "BUY", trade_date: `${etDateKey(t - 40 * DAY)}T00:00:00Z` },
      { id: "act-new", symbol: stock("TSLA", "cs"), price: 200, units: -2, amount: 400, fee: 0, type: "SELL", trade_date: `${etDateKey(t)}T00:00:00Z` },
    ],
  };
}

before(async () => {
  fake = await startFakeSnapTrade({ clientId: CLIENT_ID, consumerKey: CONSUMER_KEY });
  h = await createHarness({
    env: {
      SNAPTRADE_CLIENT_ID: CLIENT_ID,
      SNAPTRADE_CONSUMER_KEY: CONSUMER_KEY,
      SNAPTRADE_PLAN: "realtime",
      BROKER_URL_OVERRIDES: JSON.stringify({ snaptrade: { api: fake.url } }),
      BROKER_CONNECT_PER_USER: "500",
      BROKER_CONNECT_GLOBAL_PER_MIN: "500",
    },
    adapters: [["snaptrade", createAdapter]],
  });
  fake.state.now = h.now;
  t0 = h.now();
  through = etDateKey(t0 - 2 * DAY);
});

after(async () => {
  await h?.close();
  await fake?.close();
});

test("options: SnapTrade is built for its brokers, open to everyone once its keys are set; Schwab and tastytrade wait for SNAPTRADE_BROKERS", async () => {
  const r = await req("/v1/options");
  assert.equal(r.status, 200);
  /** @param {string} b */
  const pick = (b) => r.json.options.find((/** @type {any} */ x) => x.brokerId === b && x.method === "snaptrade");
  for (const b of ["fidelity", "robinhood", "public", "moomoo", "webull"]) {
    const o = pick(b);
    assert.equal(o.built, true, b);
    assert.equal(o.available, true, b);
    assert.equal(o.flow, "aggregator_portal");
    assert.equal(o.audience, "all");
    assert.deepEqual(o.environments, ["production"], "live accounts only: no sandbox, paper or demo through SnapTrade");
    assert.equal(o.callbackUrl, CALLBACK);
  }
  for (const b of ["schwab", "tastytrade"]) {
    assert.equal(pick(b).built, true, `${b} is read through SnapTrade too`);
    assert.equal(pick(b).reasonCode, "not_configured", `${b} needs SnapTrade's own approval first (SNAPTRADE_BROKERS)`);
  }
  assert.equal(SNAPTRADE_DESCRIPTOR.readTtlMs.portfolio, 10 * MIN);
  assert.equal(h.svc.registry.get("snaptrade")?.descriptor.readTtlMs.portfolio, 10 * MIN, "SNAPTRADE_PLAN=realtime: SnapTrade's 10-minute polling guidance");
  assert.equal(SNAPTRADE_DAILY_DESCRIPTOR.readTtlMs.orders, 30 * MIN);
});

test("start refuses a broker SnapTrade is not set up for, a broker Nasscord does not offer, and sample data", async () => {
  const b = newBinding();
  const schwab = await req("/v1/aggregator/start", { method: "POST", body: { brokerId: "schwab", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(schwab.status, 503);
  assert.equal(schwab.json.code, "not_configured");
  const vanguard = await req("/v1/aggregator/start", { method: "POST", body: { brokerId: "vanguard", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(vanguard.status, 400, "Vanguard connects with the user's password at SnapTrade: not offered");
  const sandbox = await req("/v1/aggregator/start", { method: "POST", body: { brokerId: "fidelity", environment: "sandbox", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(sandbox.status, 400);
  const paper = await req("/v1/aggregator/start", { method: "POST", body: { brokerId: "robinhood", environment: "paper", returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(paper.status, 400);
  assert.equal(fake.state.calls.length, 0, "nothing reached SnapTrade");
  assert.equal(h.rows("broker_connections").length, 0);
});

test("Fidelity: one SnapTrade user for the workspace, a read-only portal at Fidelity, back through the canonical callback, accounts listed", async () => {
  fake.state.portal.accounts = () => [fidelitySpec(t0)];
  const s = await startAndHop("fidelity");
  assert.equal(s.hop.status, 200, s.hop.text);
  assert.deepEqual(fake.paths(), ["POST /snapTrade/registerUser", "POST /snapTrade/login"]);
  assert.equal(fake.state.calls[0].userId, null, "registerUser is not a user call");
  assert.ok(fake.state.users.has(h.wid), "the SnapTrade userId is the workspace id, never an email");
  const login = fake.state.logins.at(-1);
  assert.deepEqual(login, { broker: "FIDELITY", connectionType: "read", customRedirect: `${CALLBACK}?cid=${s.id}`, immediateRedirect: true, showCloseButton: true });

  // The userSecret is sealed with AAD "snaptrade:<workspace id>".
  const stored = /** @type {any} */ (h.rows("broker_aggregator_users").find((r) => r.workspace_id === h.wid));
  assert.equal(stored.external_user_id, h.wid);
  assert.equal(stored.provider, "snaptrade");
  assert.deepEqual(h.svc.secretBox.decrypt(`snaptrade:${h.wid}`, stored), { userSecret: fake.state.users.get(h.wid)?.userSecret });
  assert.throws(() => h.svc.secretBox.decrypt(`snaptrade:${randomUUID()}`, stored), /could not be decrypted/, "a row copied to another workspace does not open");

  const r = await finish(s);
  assert.equal(r.done.status, 200, r.done.text);
  assert.equal(r.claim?.status, 200, r.claim?.text);
  const c = r.claim?.json.connection;
  fidelityId = c.id;
  fidelityAuth = String(r.authorizationId);
  assert.equal(c.brokerId, "fidelity");
  assert.equal(c.method, "snaptrade");
  assert.equal(c.environment, "production");
  assert.equal(c.status, "active");
  assert.equal(c.scope, "read");
  assert.equal(c.dataAsOf, new Date(t0 - 8 * MIN).toISOString(), "data_as_of is SnapTrade's last holdings sync");
  assert.deepEqual(
    c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
    [["Individual - TOD X12•••78", "X12•••78", "margin", true]],
  );
  assert.equal(row(c.id)?.external_ref, fidelityAuth, "the login is named by the SnapTrade authorization id");
  fidelityAccount = String(h.rows("broker_accounts").find((a) => a.connection_id === c.id)?.external_id);
  assert.ok(fake.state.accounts.has(fidelityAccount));
  assert.deepEqual(fake.paths(2), ["GET /authorizations/" + fidelityAuth, "GET /accounts"], "complete checks the connection; the claim reuses its account list");
  assert.ok(fake.state.calls.slice(2).every((x) => x.userId === h.wid));
  await sleep(10);
  assert.ok(h.rows("audit_events").some((a) => a.action === "broker.fidelity.connect" && a.result === "ok"));
});

test("Robinhood: the same SnapTrade user; only this connection's accounts", async () => {
  fake.state.portal.accounts = () => [
    { name: "Robinhood Individual", number: "****6789", rawType: "individual", total: 5000, holdingsSync: snapTimeText(t0 - 3 * MIN), txThrough: through },
    { name: "Roth IRA", number: "****4321", rawType: "IRA_ROTH", total: 12000, holdingsSync: snapTimeText(t0 - 20 * MIN), txThrough: through },
  ];
  const calls = fake.state.calls.length;
  const s = await startAndHop("robinhood");
  assert.equal(fake.paths(calls)[0], "POST /snapTrade/login", "no second registration");
  assert.equal(fake.state.logins.at(-1).broker, "ROBINHOOD");
  const r = await finish(s);
  assert.equal(r.claim?.status, 200, r.claim?.text ?? r.done.text);
  const c = r.claim?.json.connection;
  robinhoodId = c.id;
  robinhoodAuth = String(r.authorizationId);
  assert.deepEqual(
    c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type]),
    [
      ["Robinhood Individual", "•••89", "individual"],
      ["Roth IRA", "•••21", "roth"],
    ],
  );
  assert.equal(c.dataAsOf, new Date(t0 - 20 * MIN).toISOString(), "the oldest account sync");
  assert.equal(fake.state.users.size, 1);
  assert.equal(h.rows("broker_aggregator_users").length, 1);
});

test("each broker opens the portal at its own slug; ABANDONED and ERROR remove the attempt", async () => {
  for (const [brokerId, slug, outcome] of /** @type {const} */ ([
    ["public", "PUBLIC", "ABANDONED"],
    ["moomoo", "MOOMOO", "ERROR"],
    ["webull", "WEBULL", "ABANDONED"],
  ])) {
    fake.state.portal.outcome = outcome;
    const s = await startAndHop(brokerId);
    assert.equal(s.hop.status, 200, s.hop.text);
    assert.equal(fake.state.logins.at(-1).broker, slug, `${brokerId} opens at ${slug}`);
    assert.equal(fake.state.logins.at(-1).connectionType, "read");
    const r = await finish(s);
    assert.equal(r.done.status, 400, brokerId);
    assert.equal(r.done.json.code, "aggregator_not_finished");
    assert.equal(row(s.id), undefined, `${brokerId}: the attempt is gone`);
  }
  fake.state.portal.outcome = "SUCCESS";
});

test("complete refuses a SnapTrade connection of another workspace", async () => {
  const otherWid = randomUUID();
  const otherUser = randomUUID();
  const other = h.token({ wid: otherWid, sub: otherUser });
  fake.state.portal.accounts = () => [{ name: "Other Fidelity" }];
  const theirs = await startAndHop("fidelity", { token: other });
  const back = await fake.follow(theirs.hop.json.redirectUrl);
  const stolen = String(new URL(back.location).searchParams.get("connection_id"));
  assert.ok(h.rows("broker_aggregator_users").some((r) => r.workspace_id === otherWid), "the other workspace has its own SnapTrade user");

  const mine = await startAndHop("fidelity");
  const done = await req("/v1/aggregator/complete", { method: "POST", token: h.flowToken(), body: { connectionId: mine.id, status: "SUCCESS", authorizationId: stolen, binding: mine.b.nonce } });
  assert.equal(done.status, 400);
  assert.equal(done.json.code, "wrong_user");
  assert.match(done.json.error, /SnapTrade does not list this Fidelity connection for your workspace/);
  assert.equal(row(mine.id), undefined, "the attempt is removed");
  assert.ok(fake.state.authorizations.has(stolen), "the other workspace's connection is untouched");

  // The other workspace finishes its own login normally.
  const done2 = await req("/v1/aggregator/complete", { method: "POST", token: h.flowToken(), body: { connectionId: theirs.id, status: "SUCCESS", authorizationId: stolen, binding: theirs.b.nonce } });
  assert.equal(done2.status, 200, done2.text);
  const claim = await req("/v1/connect/claim", { method: "POST", token: other, body: { connectionId: theirs.id, ticket: done2.json.ticket, binding: theirs.b.nonce } });
  assert.equal(claim.status, 200, claim.text);
  const peek = await req(`/v1/connections/${theirs.id}`);
  assert.equal(peek.status, 404, "another workspace's connection looks like none");
});

test("complete refuses another brokerage, a sample brokerage and paper accounts, and deletes those SnapTrade connections", async () => {
  for (const [plan, code, error] of /** @type {const} */ ([
    [{ slug: "ROBINHOOD", accounts: null }, "wrong_brokerage", "That login is not at Fidelity. Start again from Brokers and log in to Fidelity."],
    [{ slug: "SNAPTRADE-SANDBOX", accounts: null }, "sample_data", SNAPTRADE_DETAIL.sample("Fidelity")],
    [{ slug: "ALPACA-PAPER", accounts: null }, "paper_refused", SNAPTRADE_DETAIL.paper("Fidelity")],
    [{ slug: null, accounts: () => [{ name: "Paper", isPaper: true }] }, "paper_refused", SNAPTRADE_DETAIL.paperOnly("Fidelity")],
  ])) {
    fake.state.portal.slug = plan.slug;
    fake.state.portal.accounts = plan.accounts;
    const s = await startAndHop("fidelity");
    const r = await finish(s);
    assert.equal(r.done.status, 400, code);
    assert.equal(r.done.json.code, code);
    assert.equal(r.done.json.error, error);
    if (code === "sample_data") assert.match(r.done.json.error, /sandbox or demo brokerage with sample data, which Nasscord does not read/);
    if (code === "paper_refused") assert.doesNotMatch(r.done.json.error, /sample/, "a user's own paper account is not called sample data");
    assert.equal(row(s.id), undefined);
    assert.equal(fake.state.authorizations.has(String(r.authorizationId)), false, `${code}: the stray SnapTrade connection was deleted`);
  }
  fake.state.portal.slug = null;
  fake.state.portal.accounts = null;
});

test("portfolio: balances, stocks and options mapped; data_as_of kept; one SnapTrade read per 10 minutes", async () => {
  const before = fake.state.calls.length;
  const r = await req("/v1/portfolio");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.errors, []);
  const fidAcct = String(h.rows("broker_accounts").find((a) => a.connection_id === fidelityId)?.id);
  const acct = r.json.accounts.find((/** @type {any} */ a) => a.accountId === fidAcct);
  assert.deepEqual(acct, { accountId: fidAcct, netLiq: 25000.55, cash: 1200.1, buyingPower: 2400.2, currency: "USD" }, "no day P&L: SnapTrade does not report it");
  const fid = r.json.positions.filter((/** @type {any} */ p) => p.accountId === fidAcct);
  assert.deepEqual(
    fid.map((/** @type {any} */ p) => [p.symbol, p.secType, p.qty, p.avgCost, p.last, p.marketValue, p.unrealizedPnl, p.brokerId]),
    [
      ["AAPL", "STK", 10, 150, 160, 1600, 100, "fidelity"],
      ["VOO", "STK", 2, 450, 500, 1000, 100, "fidelity"],
      ["FXAIX", "FUND", 3.5, 180, 200, 700, 70, "fidelity"],
      ["AAPL 251219C00150000", "OPT", 1, 2.5, 3.1, 310, 60, "fidelity"],
    ],
  );
  assert.equal(r.json.accounts.length, 3, "Fidelity's account and Robinhood's two (the other workspace is not read)");
  const first = fake.paths(before);
  assert.ok(first.includes(`GET /accounts/${fidelityAccount}/positions`) && first.includes(`GET /accounts/${fidelityAccount}/options`));
  assert.ok(!first.some((p) => p.includes("/trade")), "reads only");
  assert.equal(row(fidelityId)?.data_as_of, new Date(t0 - 8 * MIN).toISOString());
  assert.ok(row(fidelityId)?.last_ok_at);

  const mid = fake.state.calls.length;
  h.advance(5 * MIN);
  const again = await req("/v1/portfolio");
  assert.equal(again.status, 200);
  assert.equal(fake.state.calls.length, mid, "within 10 minutes the answer is reused: no SnapTrade call");
  h.advance(6 * MIN);
  await req("/v1/portfolio");
  assert.ok(fake.state.calls.length > mid, "after 10 minutes SnapTrade is read again");
});

test("orders: 30 days plus open orders of 90, statuses and types mapped, newest first", async () => {
  const r = await req("/v1/orders");
  assert.equal(r.status, 200, r.text);
  const fidAcct = String(h.rows("broker_accounts").find((a) => a.connection_id === fidelityId)?.id);
  const fid = r.json.orders.filter((/** @type {any} */ o) => o.accountId === fidAcct);
  assert.deepEqual(
    fid.map((/** @type {any} */ o) => [o.brokerRef, o.symbol, o.side, o.qty, o.type, o.price ?? null, o.tif, o.status, o.filledQty ?? null, o.avgFill ?? null]),
    [
      ["o-pending", "F", "BUY", 100, "LMT", 12, "DAY", "working", 0, null],
      ["o-tsla", "TSLA", "SELL", 2, "MKT", null, "DAY", "filled", 2, 200],
      ["o-partial", "NVDA", "BUY", 10, "LMT", 50, "GTC", "working", 5, 50],
      ["o-canceled", "F", "SELL", 50, "STP", 11, "DAY", "cancelled", 0, null],
      ["o-rejected", "GME", "BUY", 1, "MKT", null, "DAY", "rejected", 0, null],
      ["o-option", "AAPL 251219C00150000", "BUY", 1, "LMT", 2.5, "DAY", "filled", 1, 2.5],
      ["o-filled-aapl", "AAPL", "BUY", 10, "LMT", 150.5, "DAY", "filled", 10, 150],
      ["o-old-gtc", "SPY", "BUY", 1, "LMT", 400, "GTC", "working", 0, null],
    ],
  );
  assert.equal(fid[0].id, `fidelity:${fidAcct}:o-pending`);
  assert.equal(fid[0].brokerId, "fidelity");
  const q = fake.state.calls.filter((c) => c.path === `/accounts/${fidelityAccount}/orders`).map((c) => `${c.query.state}/${c.query.days}`);
  assert.deepEqual(q.slice(-2), ["open/90", "all/30"]);
});

test("executions: transactions up to SnapTrade's last synced day with their fees, then provisional fills from orders", async () => {
  const r = await req("/v1/executions");
  assert.equal(r.status, 200, r.text);
  const fidAcct = String(h.rows("broker_accounts").find((a) => a.connection_id === fidelityId)?.id);
  const fid = r.json.executions.filter((/** @type {any} */ e) => e.accountId === fidAcct);
  const d3 = etDateKey(t0 - 3 * DAY).split("-").map(Number);
  assert.deepEqual(
    fid.map((/** @type {any} */ e) => [e.id.split(":").slice(2).join(":"), e.symbol, e.side, e.qty, e.price, e.commission, e.net, e.tradedAt, e.provisional ?? false]),
    [
      ["o:o-tsla", "TSLA", "SELL", 2, 200, 0, 400, iso(t0 - 60 * MIN), true],
      ["o:o-partial", "NVDA", "BUY", 5, 50, 0, -250, iso(t0 - 90 * MIN), true],
      ["a:act-msft", "MSFT", "SELL", 5, 300, 0.5, 1499.5, iso(etToUtc(d3[0], d3[1], d3[2], 0, 0)), false],
      ["a:act-opt", "AAPL 251219C00150000", "BUY", 1, 2.5, 0.65, -250.65, iso(etAt(t0 - 3 * DAY, 10, 1)), false],
      ["a:act-aapl", "AAPL", "BUY", 10, 150, 1, -1501, iso(etAt(t0 - 4 * DAY, 14, 30)), false],
    ].sort((a, b) => (a[7] < b[7] ? 1 : a[7] > b[7] ? -1 : 0)),
  );
  const act = fake.state.calls.filter((c) => c.path === `/accounts/${fidelityAccount}/activities`).at(-1);
  assert.equal(act?.query.endDate, dayAfter(through), "transactions up to the last synced day (asked a day past it for evening fills dated in UTC)");
  assert.equal(act?.query.startDate, etDateKey(h.now() - 30 * DAY));
  assert.equal(act?.query.type, "BUY,SELL");

  const calls = fake.state.calls.length;
  h.advance(11 * MIN);
  await req("/v1/executions");
  assert.ok(!fake.paths(calls).some((p) => p.endsWith("/activities")), "transactions change once a day: cached for hours");
  h.advance(7 * 60 * MIN);
  const later = fake.state.calls.length;
  await req("/v1/executions");
  assert.ok(!fake.paths(later).some((p) => p.endsWith("/activities")), "read at most once a day per account (SnapTrade's launch checklist)");
});

test("an account list SnapTrade has not sent yet: connected, then the accounts appear on a read", async () => {
  fake.state.portal.accounts = () => [];
  const s = await startAndHop("public");
  const r = await finish(s);
  assert.equal(r.claim?.status, 200, r.claim?.text ?? r.done.text);
  publicId = s.id;
  publicAuth = String(r.authorizationId);
  const c = r.claim?.json.connection;
  assert.equal(c.status, "active");
  assert.equal(c.statusDetail, "Connected. Public has not sent the account list yet; it loads on the next refresh.");
  assert.deepEqual(c.accounts, []);

  const still = await req("/v1/portfolio");
  const err = still.json.errors.find((/** @type {any} */ e) => e.connectionId === publicId);
  assert.equal(err?.message, SNAPTRADE_DETAIL.accountsSyncing("Public"));

  fake.addAccount(publicAuth, { name: "Public Individual", number: "5PA00042", holdingsSync: snapTimeText(h.now() - MIN), txThrough: through });
  h.advance(31_000);
  const now = await req("/v1/portfolio");
  assert.equal(now.status, 200);
  assert.equal(now.json.errors.find((/** @type {any} */ e) => e.connectionId === publicId), undefined);
  assert.equal(row(publicId)?.status_detail, null, "the detail is cleared once the list arrives");
  assert.equal(h.rows("broker_accounts").filter((a) => a.connection_id === publicId).length, 1);
  fake.state.portal.accounts = null;
});

test("webhooks: refused without a valid signature, a fresh timestamp and Nasscord's client id", async () => {
  const base = { webhookId: randomUUID(), clientId: CLIENT_ID, eventTimestamp: iso(h.now()), userId: snapUserId(), eventType: "ACCOUNT_HOLDINGS_UPDATED", brokerageAuthorizationId: fidelityAuth };
  /** @param {{ body: string, signature: string }} w */
  const post = (w) => fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "content-type": "application/json", signature: w.signature }, body: w.body });
  assert.equal((await post({ ...fake.webhook(base), signature: fake.webhook(base, { key: "not-the-key" }).signature })).status, 401, "bad HMAC");
  assert.equal((await post(fake.webhook({ ...base, webhookId: randomUUID(), eventTimestamp: iso(h.now() - 6 * MIN) }))).status, 401, "older than 5 minutes");
  assert.equal((await post(fake.webhook({ ...base, webhookId: randomUUID(), eventTimestamp: iso(h.now() + 6 * MIN) }))).status, 401, "more than 5 minutes ahead");
  assert.equal((await post(fake.webhook({ ...base, webhookId: randomUUID(), clientId: "SOMEONE-ELSE" }))).status, 401, "another client");
  const tampered = fake.webhook(base);
  assert.equal((await post({ ...tampered, body: tampered.body.replace("ACCOUNT_HOLDINGS_UPDATED", "CONNECTION_BROKEN") })).status, 401, "a changed body");
  const noSig = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base) });
  assert.equal(noSig.status, 401);
  const notJson = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", body: "nope" });
  assert.equal(notJson.status, 400);
  assert.equal(row(fidelityId)?.status, "active");
});

test("webhooks: holdings updated drops the cache, a repeat does nothing, a new account is listed, a broken connection expires", async () => {
  /** @param {Record<string, unknown>} p */
  const send = async (p) => {
    const w = fake.webhook({ webhookId: randomUUID(), clientId: CLIENT_ID, eventTimestamp: iso(h.now()), userId: snapUserId(), ...p });
    const r = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "content-type": "application/json", signature: w.signature }, body: w.body });
    return { status: r.status, json: await r.json(), w };
  };
  await req("/v1/portfolio");
  const quiet = fake.state.calls.length;
  await req("/v1/portfolio");
  assert.equal(fake.state.calls.length, quiet, "cached");

  const hook = await send({ eventType: "ACCOUNT_HOLDINGS_UPDATED", brokerageAuthorizationId: fidelityAuth, accountId: fidelityAccount });
  assert.equal(hook.status, 200);
  await req("/v1/portfolio");
  const after = fake.paths(quiet);
  assert.ok(after.includes(`GET /accounts/${fidelityAccount}/positions`), "Fidelity is read again");
  assert.ok(!after.some((p) => p.includes(robinhoodAuth)) && after.filter((p) => p.endsWith("/positions")).length === 1, "Robinhood's cache is untouched");

  const repeat = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "content-type": "application/json", signature: hook.w.signature }, body: hook.w.body });
  assert.equal(repeat.status, 200);
  assert.equal(/** @type {any} */ (await repeat.json()).repeated, true);

  const added = fake.addAccount(fidelityAuth, { name: "Fidelity Roth IRA", number: "Y87654321", rawType: "Roth IRA", total: 900, holdingsSync: snapTimeText(h.now()), txThrough: through });
  assert.equal((await send({ eventType: "NEW_ACCOUNT_AVAILABLE", brokerageAuthorizationId: fidelityAuth, accountId: added })).status, 200);
  const listed = await req("/v1/portfolio");
  assert.equal(listed.status, 200);
  const rows = h.rows("broker_accounts").filter((a) => a.connection_id === fidelityId);
  assert.deepEqual(rows.map((a) => a.type).sort(), ["margin", "roth"], "the new account is in the list");

  // Found by the account id alone, too.
  fake.disable(robinhoodAuth);
  const robinhoodAccount = String(h.rows("broker_accounts").find((a) => a.connection_id === robinhoodId)?.external_id);
  assert.equal((await send({ eventType: "CONNECTION_BROKEN", accountId: robinhoodAccount })).status, 200);
  assert.equal(row(robinhoodId)?.status, "expired");
  assert.equal(row(robinhoodId)?.status_detail, "Robinhood ended Nasscord's access. Reconnect to continue.");

  // A user SnapTrade does not know, or an event type that changes nothing: acknowledged.
  assert.equal((await send({ eventType: "ACCOUNT_HOLDINGS_UPDATED", userId: randomUUID() })).status, 200);
  assert.equal((await send({ eventType: "USER_REGISTERED" })).status, 200);
});

test("a connection whose last account closes: the account goes, and reads say so without asking SnapTrade on every read", async () => {
  const publicAccount = String(h.rows("broker_accounts").find((a) => a.connection_id === publicId)?.external_id);
  const acct = /** @type {any} */ (fake.state.accounts.get(publicAccount));
  acct.json.status = "closed";
  assert.equal((await sendHook({ eventType: "ACCOUNT_REMOVED", brokerageAuthorizationId: publicAuth, accountId: publicAccount })).status, 200);
  const first = await req("/v1/portfolio");
  assert.equal(first.status, 200, first.text);
  assert.equal(h.rows("broker_accounts").filter((a) => a.connection_id === publicId).length, 0, "the closed account is removed");
  assert.equal(row(publicId)?.status, "active");
  assert.equal(row(publicId)?.status_detail, SNAPTRADE_DETAIL.noAccounts("Public"));

  const calls = fake.state.calls.length;
  for (let i = 0; i < 3; i++) {
    h.advance(MIN);
    const r = await req("/v1/portfolio");
    assert.equal(r.status, 200);
    assert.equal(r.json.errors.find((/** @type {any} */ e) => e.connectionId === publicId)?.message, SNAPTRADE_DETAIL.noAccounts("Public"), "not 'still sending' and not 'refreshes on the next read'");
  }
  assert.ok(!fake.paths(calls).includes(`GET /authorizations/${publicAuth}`), "the connection is not checked again on every read");

  // The account opens again: it is listed once the reads ask SnapTrade again.
  acct.json.status = "open";
  h.advance(11 * MIN);
  const back = await req("/v1/portfolio");
  assert.equal(back.status, 200);
  assert.equal(back.json.errors.find((/** @type {any} */ e) => e.connectionId === publicId), undefined);
  assert.equal(h.rows("broker_accounts").filter((a) => a.connection_id === publicId).length, 1);
  assert.equal(row(publicId)?.status_detail, null);
});

test("Reconnect: the portal reopens the same SnapTrade connection, at the same broker, and the connection is active again", async () => {
  const b = newBinding();
  const renew = await req(`/v1/connections/${robinhoodId}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(renew.status, 200, renew.text);
  assert.deepEqual(renew.json.next, { kind: "redirect" });
  assert.equal(row(robinhoodId)?.status, "pending");
  const included = h.rows("broker_accounts").find((a) => a.connection_id === robinhoodId);
  if (included) included.included = false;
  const hop = await req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: robinhoodId, binding: b.nonce } });
  assert.equal(hop.status, 200, hop.text);
  const login = fake.state.logins.at(-1);
  assert.equal(login.broker, "ROBINHOOD", "the broker is always named, also on a Reconnect");
  assert.equal(login.reconnect, robinhoodAuth);
  const r = await finish({ b, id: robinhoodId, hop });
  assert.equal(r.claim?.status, 200, r.claim?.text ?? r.done.text);
  assert.equal(r.authorizationId, robinhoodAuth, "SnapTrade keeps the connection id");
  assert.equal(r.claim?.json.connection.status, "active");
  assert.equal(r.claim?.json.connection.id, robinhoodId);
  assert.equal(h.rows("broker_accounts").find((a) => a.id === included?.id)?.included, false, "the Included switches survive");
});

test("transactions: more than 1000 are read page by page; a transactions webhook reads them again, a holdings one does not", async () => {
  const account = String(h.rows("broker_accounts").find((a) => a.connection_id === robinhoodId && a.included)?.external_id);
  const spec = /** @type {any} */ (fake.state.accounts.get(account)).spec;
  spec.activities = Array.from({ length: 1500 }, (_, i) => ({
    id: `act-page-${i}`,
    symbol: stock("F", "cs"),
    option_symbol: null,
    price: 10,
    units: 1,
    amount: -10,
    fee: 0,
    type: "BUY",
    trade_date: `${through}T00:00:00Z`,
    currency: { code: "USD" },
  }));
  assert.equal((await sendHook({ eventType: "ACCOUNT_TRANSACTIONS_UPDATED", brokerageAuthorizationId: robinhoodAuth, accountId: account })).status, 200);
  const calls = fake.state.calls.length;
  const r = await req("/v1/executions");
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const acctId = String(h.rows("broker_accounts").find((a) => a.external_id === account)?.id);
  assert.equal(r.json.executions.filter((/** @type {any} */ e) => e.accountId === acctId).length, 1500);
  const pages = fake.state.calls.slice(calls).filter((c) => c.path === `/accounts/${account}/activities`);
  assert.deepEqual(
    pages.map((c) => [c.query.offset, c.query.limit]),
    [
      ["0", "1000"],
      ["1000", "1000"],
    ],
  );

  const quiet = fake.state.calls.length;
  assert.equal((await sendHook({ eventType: "ACCOUNT_HOLDINGS_UPDATED", brokerageAuthorizationId: robinhoodAuth })).status, 200);
  const again = await req("/v1/executions");
  assert.equal(again.json.executions.filter((/** @type {any} */ e) => e.accountId === acctId).length, 1500);
  assert.ok(!fake.paths(quiet).some((p) => p.endsWith("/activities")), "holdings changed, transactions did not: no transactions call");
  spec.activities = [];
});

test("sweep: a disabled connection expires, an old orphan at SnapTrade is deleted, a young one is kept, a missing one is an error", async () => {
  fake.disable(fidelityAuth);
  const oldOrphan = fake.addAuthorization({ userId: snapUserId(), slug: "FIDELITY", createdAt: h.now() - 31 * MIN });
  const youngOrphan = fake.addAuthorization({ userId: snapUserId(), slug: "MOOMOO", createdAt: h.now() });
  fake.remove(publicAuth);
  h.advance(16 * MIN);
  const calls = fake.state.calls.length;
  await h.svc.scheduler.tick();
  assert.equal(row(fidelityId)?.status, "expired");
  assert.equal(row(fidelityId)?.status_detail, "Fidelity ended Nasscord's access. Reconnect to continue.");
  assert.equal(row(publicId)?.status, "error");
  assert.equal(row(publicId)?.status_detail, SNAPTRADE_DETAIL.gone("Public"));
  assert.equal(row(robinhoodId)?.status, "active");
  assert.equal(fake.state.authorizations.has(oldOrphan), false, "an orphan older than 30 minutes is deleted");
  assert.equal(fake.state.authorizations.has(youngOrphan), true, "a young one may still be finishing a login");
  const swept = fake.paths(calls);
  assert.equal(swept.filter((p) => p === "GET /authorizations").length, 2, "one list per workspace with a SnapTrade user");
  assert.ok(!swept.includes(`GET /authorizations/${robinhoodAuth}`), "a healthy connection is confirmed by that list, without a call of its own");
  assert.ok(swept.includes(`GET /authorizations/${fidelityAuth}`), "a disabled one is asked again before it expires");
  await sleep(10);
  assert.ok(h.rows("audit_events").some((a) => a.action === "broker.session.expired" && String(a.target).includes(fidelityId)));
  fake.remove(youngOrphan);
});

test("Reconnect of a working connection (the app always sends a login binding): checked with SnapTrade, no portal", async () => {
  fake.state.portal.accounts = () => [{ name: "Webull Individual", holdingsSync: snapTimeText(h.now()), txThrough: through }];
  const s = await startAndHop("webull");
  const r = await finish(s);
  assert.equal(r.claim?.status, 200, r.claim?.text ?? r.done.text);
  const logins = fake.state.logins.length;
  const before = fake.state.calls.length;
  const b = newBinding();
  const renew = await req(`/v1/connections/${s.id}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(renew.status, 200, renew.text);
  assert.equal(renew.json.connection.status, "active", "checked with SnapTrade, not with a list made before it existed");
  assert.equal(renew.json.next, undefined, "a working connection needs nothing: SnapTrade's reconnect is for a disabled connection only");
  assert.deepEqual(fake.paths(before), [`GET /authorizations/${r.authorizationId}`]);
  assert.equal(fake.state.logins.length, logins, "no portal link was asked for");
  assert.equal(h.rows("broker_oauth_pending").some((p) => p.connection_id === s.id), false, "no login hand-off was started");
  const plain = await req(`/v1/connections/${s.id}/renew`, { method: "POST", body: {} });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.json.next, undefined);
  const calls = fake.state.calls.length;
  const gone = await req(`/v1/connections/${s.id}`, { method: "DELETE" });
  assert.equal(gone.status, 200);
  assert.deepEqual(fake.paths(calls), [`DELETE /authorizations/${r.authorizationId}`], "other connections remain: the SnapTrade user stays");
  fake.state.portal.accounts = null;
});

test("Reconnect of a connection SnapTrade no longer holds: a plain 409, never another login", async () => {
  const b = newBinding();
  const logins = fake.state.logins.length;
  const renew = await req(`/v1/connections/${publicId}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(renew.status, 409, renew.text);
  assert.equal(renew.json.code, "aggregator_gone");
  assert.equal(renew.json.error, "SnapTrade no longer holds this Public connection. Disconnect it, then connect Public again.");
  assert.equal(fake.state.logins.length, logins, "no portal link was asked for");
  assert.equal(h.rows("broker_oauth_pending").some((p) => p.connection_id === publicId), false, "no login hand-off was started");
  assert.equal(row(publicId)?.status, "error");
});

test("SnapTrade refusing Nasscord's keys is a readable 502 that expires nothing; a 429 pauses SnapTrade calls", async () => {
  h.advance(11 * MIN);
  fake.state.failNext.push({ path: /^\/accounts$/, status: 401, body: { detail: "Unable to verify signature sent", code: "1076" } });
  const r = await req("/v1/portfolio");
  assert.equal(r.status, 200);
  const err = r.json.errors.find((/** @type {any} */ e) => e.connectionId === robinhoodId);
  assert.equal(err?.message, "SnapTrade did not accept Nasscord's request right now. Try again in a few minutes.");
  assert.equal(row(robinhoodId)?.status, "active", "a refusal of Nasscord's own keys is not the user's to fix");
  assert.ok(h.logLines.some((l) => l.includes("snaptrade refused a request") && l.includes('"status":401')));

  h.advance(11 * MIN);
  fake.state.failNext.push({ path: /\/orders$/, status: 429, body: { detail: "Request was throttled. Expected available in 2 seconds.", status_code: 429 }, headers: { "retry-after": "2" } });
  const o = await req("/v1/orders");
  assert.equal(o.status, 200);
  assert.match(String(o.json.errors.find((/** @type {any} */ e) => e.connectionId === robinhoodId)?.message), /SnapTrade is limiting requests right now/);
  h.advance(2 * MIN);
  const ok = await req("/v1/orders");
  assert.deepEqual(ok.json.errors.filter((/** @type {any} */ e) => e.connectionId === robinhoodId), [], "after the pause it reads again");
});

test("read-only: the allowlist holds the reads and the connect steps only; anything else is refused before the network", async () => {
  let fetched = 0;
  const client = createSnapTradeClient({
    http: (o) =>
      createBrokerHttp({
        ...o,
        fetch: /** @type {typeof fetch} */ (async () => {
          fetched++;
          return new Response("{}", { status: 200 });
        }),
      }),
    base: "https://api.snaptrade.com/api/v1",
    clientId: CLIENT_ID,
    consumerKey: CONSUMER_KEY,
    now: Date.now,
    log: silentLogger,
  });
  const id = randomUUID();
  for (const [m, p] of [
    ["GET", "/accounts"],
    ["GET", `/accounts/${id}/balances`],
    ["GET", `/accounts/${id}/positions`],
    ["GET", `/accounts/${id}/options`],
    ["GET", `/accounts/${id}/orders`],
    ["GET", `/accounts/${id}/activities`],
    ["GET", "/authorizations"],
    ["GET", `/authorizations/${id}`],
    ["DELETE", `/authorizations/${id}`],
    ["POST", "/snapTrade/registerUser"],
    ["DELETE", "/snapTrade/deleteUser"],
    ["GET", "/snapTrade/listUsers"],
    ["POST", "/snapTrade/login"],
  ]) {
    assert.equal(client.http.allows(m, p), true, `${m} ${p}`);
  }
  for (const [m, p] of [
    ["POST", "/trade/place"],
    ["POST", "/trade/impact"],
    ["POST", `/trade/${id}`],
    ["POST", `/accounts/${id}/orders/cancel`],
    ["POST", `/accounts/${id}/trading/simple`],
    ["POST", `/accounts/${id}/trading/options`],
    ["POST", `/authorizations/${id}/refresh`],
    ["POST", `/authorizations/${id}/disable`],
    ["POST", "/snapTrade/resetUserSecret"],
    ["POST", "/snapTrade/listUsers"],
    ["DELETE", "/snapTrade/listUsers"],
    ["GET", `/accounts/${id}/../../trade/place`],
    ["GET", `/accounts/${id}/positions/extra`],
    ["POST", "/accounts"],
    ["DELETE", `/accounts/${id}`],
    ["PUT", `/accounts/${id}`],
  ]) {
    assert.equal(client.http.allows(m, p), false, `${m} ${p}`);
    await assert.rejects(client.call(m, p), (e) => e instanceof ReadOnlyViolation || /characters SnapTrade never uses/.test(String(e)), `${m} ${p}`);
  }
  assert.equal(fetched, 0, "nothing was sent");
  assert.equal(SNAPTRADE_ALLOW.filter(([m]) => m === "POST").length, 2, "the only POSTs: register the user and the portal link");
  assert.ok(!fake.state.calls.some((c) => c.path.startsWith("/trade") || (c.method !== "GET" && c.path.startsWith("/accounts"))), "the fake never saw a write");
});

test("production calls SnapTrade's own host whatever the overrides say; without keys there is no webhook and nothing is built to call", async () => {
  assert.equal(snaptradeBase({ api: "http://127.0.0.1:9" }, true), "https://api.snaptrade.com/api/v1");
  assert.equal(snaptradeBase({ api: "http://127.0.0.1:9" }, false), "http://127.0.0.1:9/api/v1");
  assert.equal(snaptradeBase({}, false), "https://api.snaptrade.com/api/v1");
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", BROKER_URL_OVERRIDES: JSON.stringify({ snaptrade: { api: fake.url } }) }),
    /BROKER_URL_OVERRIDES is for local fake brokers and is refused in production/,
  );

  const g = await createHarness({ adapters: [["snaptrade", createAdapter]] });
  try {
    const hook = await fetch(`${g.api.url}/hooks/snaptrade`, { method: "POST", headers: { signature: "x" }, body: "{}" });
    assert.equal(hook.status, 404, "no consumer key: no webhook route");
    const o = await g.req("/v1/options");
    const fid = o.json.options.find((/** @type {any} */ x) => x.brokerId === "fidelity" && x.method === "snaptrade");
    assert.equal(fid.built, true);
    assert.equal(fid.reasonCode, "not_configured");
    const adapter = g.svc.registry.get("snaptrade");
    assert.equal(adapter?.descriptor.readTtlMs.portfolio, 30 * MIN, "the default Daily plan keeps reads 30 minutes");
    assert.equal(await adapter?.refresh?.(/** @type {any} */ ({ id: randomUUID(), external_ref: "x", workspace_id: g.wid })), "skipped");
    await adapter?.sweep?.();
  } finally {
    await g.close();
  }
});

test("an expired connection is active again once SnapTrade re-enables it: CONNECTION_FIXED, the sweep's list, or Reconnect", async () => {
  assert.equal(row(fidelityId)?.status, "expired");
  fake.enable(fidelityAuth);
  assert.equal((await sendHook({ eventType: "CONNECTION_FIXED", brokerageAuthorizationId: fidelityAuth })).status, 200);
  assert.equal(row(fidelityId)?.status, "active");
  assert.equal(row(fidelityId)?.status_detail, null);

  // Broken again, then fixed at SnapTrade with no webhook: the sweep's authorization list brings it back.
  fake.disable(fidelityAuth);
  await sendHook({ eventType: "CONNECTION_BROKEN", brokerageAuthorizationId: fidelityAuth });
  assert.equal(row(fidelityId)?.status, "expired");
  fake.enable(fidelityAuth);
  h.advance(16 * MIN);
  await h.svc.scheduler.tick();
  assert.equal(row(fidelityId)?.status, "active");
  assert.equal(row(publicId)?.status, "error", "a connection SnapTrade no longer lists stays an error");

  // Broken, fixed, then Reconnect pressed with the app's login binding: nothing to log in to.
  fake.disable(fidelityAuth);
  await sendHook({ eventType: "CONNECTION_BROKEN", brokerageAuthorizationId: fidelityAuth });
  fake.enable(fidelityAuth);
  const logins = fake.state.logins.length;
  const renew = await req(`/v1/connections/${fidelityId}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: newBinding().hash } });
  assert.equal(renew.status, 200, renew.text);
  assert.equal(renew.json.next, undefined);
  assert.equal(renew.json.connection.status, "active");
  assert.equal(fake.state.logins.length, logins, "no portal link");

  // Reconnect pressed while broken, fixed before the hop: no login without reconnect (it would make
  // a second SnapTrade connection); the connection is active and the hop says so.
  fake.disable(fidelityAuth);
  await sendHook({ eventType: "CONNECTION_BROKEN", brokerageAuthorizationId: fidelityAuth });
  const b = newBinding();
  const pending = await req(`/v1/connections/${fidelityId}/renew`, { method: "POST", body: { returnOrigin: "http://localhost:3000", bindingHash: b.hash } });
  assert.equal(pending.status, 200, pending.text);
  assert.deepEqual(pending.json.next, { kind: "redirect" });
  fake.enable(fidelityAuth);
  const hop = await req("/v1/connect/hop", { method: "POST", token: h.flowToken(), body: { connectionId: fidelityId, binding: b.nonce } });
  assert.equal(hop.status, 409, hop.text);
  assert.equal(hop.json.code, "aggregator_working");
  assert.equal(hop.json.error, SNAPTRADE_DETAIL.working("Fidelity"));
  assert.equal(fake.state.logins.length, logins, "no portal link");
  assert.equal(row(fidelityId)?.status, "active");

  const r = await req("/v1/portfolio");
  assert.equal(r.status, 200);
  assert.equal(r.json.errors.find((/** @type {any} */ e) => e.connectionId === fidelityId), undefined, "Fidelity is read again");
});

test("CONNECTION_DELETED: SnapTrade no longer holds the connection; it becomes an error", async () => {
  fake.remove(fidelityAuth);
  assert.equal((await sendHook({ eventType: "CONNECTION_DELETED", brokerageAuthorizationId: fidelityAuth })).status, 200);
  assert.equal(row(fidelityId)?.status, "error");
  assert.equal(row(fidelityId)?.status_detail, SNAPTRADE_DETAIL.gone("Fidelity"));
});

test("sweep: SnapTrade users no workspace holds (a workspace or account deleted) are deleted after 30 minutes; ids Nasscord never makes are left alone", async () => {
  /** @param {string} id */
  const stray = (id) => {
    fake.state.users.set(id, { userSecret: randomBytes(24).toString("base64url"), deleted: false });
    return id;
  };
  const known = [...fake.state.users.entries()].filter(([, u]) => !u.deleted).map(([id]) => id);
  const foreign = stray("legacy-user-1");
  const s1 = stray(randomUUID());
  const s2 = stray(`${randomUUID()}-0a1b2c3d`);
  const s3 = stray(randomUUID());
  const s4 = stray(randomUUID());

  // Four unknown users of seven listed: this database is probably not the one these keys belong to.
  h.advance(16 * MIN);
  await h.svc.scheduler.tick();
  h.advance(31 * MIN);
  await h.svc.scheduler.tick();
  assert.ok([s1, s2, s3, s4].every((id) => fake.state.users.has(id)), "too many strays: none deleted");
  assert.ok(h.logLines.some((l) => l.includes("snaptrade lists more users without a workspace than expected")));

  fake.state.users.delete(s3);
  fake.state.users.delete(s4);
  h.advance(16 * MIN);
  let calls = fake.state.calls.length;
  await h.svc.scheduler.tick();
  assert.ok(fake.paths(calls).includes("GET /snapTrade/listUsers"));
  assert.ok(fake.state.users.has(s1) && fake.state.users.has(s2), "first seen now: kept (a registration may be finishing)");

  h.advance(31 * MIN);
  calls = fake.state.calls.length;
  await h.svc.scheduler.tick();
  const deleted = fake.state.calls
    .slice(calls)
    .filter((c) => c.method === "DELETE" && c.path === "/snapTrade/deleteUser")
    .map((c) => c.query.userId);
  assert.deepEqual(deleted.sort(), [s1, s2].sort());
  assert.equal(fake.state.users.has(s1) || fake.state.users.has(s2), false);
  assert.ok(fake.state.users.has(foreign), "an id Nasscord never makes is not touched");
  assert.ok(
    known.every((id) => fake.state.users.has(id) && !fake.state.users.get(id)?.deleted),
    "users with a workspace stay",
  );
  assert.equal(row(robinhoodId)?.status, "active");
});

test("a development server that talks to SnapTrade itself never deletes SnapTrade users", async () => {
  /** @type {string[]} */
  const fetched = [];
  const g = await createHarness({
    env: { SNAPTRADE_CLIENT_ID: CLIENT_ID, SNAPTRADE_CONSUMER_KEY: CONSUMER_KEY },
    adapters: [
      [
        "snaptrade",
        (deps) =>
          createAdapter({
            ...deps,
            urls: {},
            http: (o) =>
              createBrokerHttp({
                ...o,
                fetch: /** @type {typeof fetch} */ (
                  async (url) => {
                    fetched.push(new URL(String(url)).pathname);
                    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
                  }
                ),
              }),
          }),
      ],
    ],
  });
  try {
    await g.svc.registry.get("snaptrade")?.sweep?.();
    assert.deepEqual(fetched, [], "no user list, no deletion");
  } finally {
    await g.close();
  }
});

test("disconnect deletes the SnapTrade connection; the last one deletes the workspace's SnapTrade user, and a new one registers under a fresh id", async () => {
  let calls = fake.state.calls.length;
  const d1 = await req(`/v1/connections/${fidelityId}`, { method: "DELETE" });
  assert.equal(d1.status, 200, d1.text);
  assert.deepEqual(fake.paths(calls), [`DELETE /authorizations/${fidelityAuth}`]);
  assert.equal(fake.state.authorizations.has(fidelityAuth), false);
  assert.equal(row(fidelityId)?.status, "disconnected");
  assert.equal(h.rows("broker_accounts").filter((a) => a.connection_id === fidelityId).length, 0);
  assert.ok(h.rows("broker_aggregator_users").some((r) => r.workspace_id === h.wid), "Robinhood and Public still use the SnapTrade user");

  const d2 = await req(`/v1/connections/${publicId}`, { method: "DELETE" });
  assert.equal(d2.status, 200, d2.text);
  fake.state.keepDeletedIds = true;
  calls = fake.state.calls.length;
  const d3 = await req(`/v1/connections/${robinhoodId}`, { method: "DELETE" });
  assert.equal(d3.status, 200, d3.text);
  assert.deepEqual(fake.paths(calls), [`DELETE /authorizations/${robinhoodAuth}`, "DELETE /snapTrade/deleteUser"]);
  assert.equal(h.rows("broker_aggregator_users").some((r) => r.workspace_id === h.wid), false, "no connection left: the SnapTrade user is gone (no per-user billing)");

  // SnapTrade is still deleting the old user: its id is taken, so the workspace gets a fresh one.
  calls = fake.state.calls.length;
  const s = await startAndHop("fidelity");
  assert.equal(s.hop.status, 200, s.hop.text);
  assert.deepEqual(fake.paths(calls), ["POST /snapTrade/registerUser", "POST /snapTrade/registerUser", "POST /snapTrade/login"]);
  const fresh = snapUserId();
  assert.match(fresh, new RegExp(`^${h.wid}-[0-9a-f]{8}$`));
  fake.state.portal.outcome = "ABANDONED";
  await finish(s);
  fake.state.portal.outcome = "SUCCESS";

  // Webhooks find the workspace by that id.
  const w = fake.webhook({ webhookId: randomUUID(), clientId: CLIENT_ID, eventTimestamp: iso(h.now()), userId: fresh, eventType: "ACCOUNT_HOLDINGS_UPDATED" });
  const r = await fetch(`${h.api.url}/hooks/snaptrade`, { method: "POST", headers: { "content-type": "application/json", signature: w.signature }, body: w.body });
  assert.equal(r.status, 200);
});

test("sweep: the workspace's SnapTrade user goes 30 minutes after its last connection did (an unfinished first login)", async () => {
  const fresh = snapUserId();
  assert.ok(fresh, "the user registered by the abandoned login is still there");
  assert.equal(h.rows("broker_connections").filter((c) => c.workspace_id === h.wid && c.status !== "disconnected").length, 0);
  h.advance(31 * MIN);
  const calls = fake.state.calls.length;
  await h.svc.scheduler.tick();
  assert.ok(fake.state.calls.slice(calls).some((c) => c.method === "DELETE" && c.path === "/snapTrade/deleteUser" && c.query.userId === fresh));
  assert.equal(h.rows("broker_aggregator_users").some((r) => r.workspace_id === h.wid), false, "no per-user billing for a workspace without connections");
});

test("users: a userSecret sealed with an older BROKER_TOKEN_KEY is sealed again with the current key when read", async () => {
  const db = createMemoryDb();
  const store = createStore(/** @type {any} */ (db));
  const oldKey = randomBytes(32);
  const v1 = createSecretBox({ key: oldKey, keyVersion: 1 });
  const v2 = createSecretBox({ key: randomBytes(32), keyVersion: 2, previousKeys: new Map([[1, oldKey]]) });
  const wid = randomUUID();
  const secret = randomBytes(24).toString("base64url");
  await store.putAggregatorUser({ workspace_id: wid, external_user_id: wid, ...v1.encrypt(`snaptrade:${wid}`, { userSecret: secret }) });
  const users = createSnapTradeUsers({
    store,
    secretBox: v2,
    locks: createLocks(),
    client: () => {
      throw new Error("no SnapTrade call is needed to read a stored user");
    },
    log: silentLogger,
    now: Date.now,
  });
  assert.deepEqual(await users.get(wid), { userId: wid, userSecret: secret });
  const stored = /** @type {any} */ ((db.tables.get("broker_aggregator_users") ?? [])[0]);
  assert.equal(stored.key_version, 2, "sealed again with the current key");
  assert.deepEqual(v2.decrypt(`snaptrade:${wid}`, stored), { userSecret: secret });
  assert.throws(() => v1.decrypt(`snaptrade:${wid}`, stored), "the old key no longer opens it");
  assert.ok(!JSON.stringify(stored).includes(secret));
});

test("fills: a brokerage that sends exact times keeps an evening fill on its own New York day", () => {
  const ref = { id: "acct-1", external_id: "snap-1" };
  // Friday 13 November 2026, 20:30 Eastern = 01:30 UTC on the 14th; SnapTrade synced through the 13th.
  const evening = etToUtc(2026, 11, 13, 20, 30);
  const orders = [
    {
      brokerage_order_id: "o-eve",
      status: "EXECUTED",
      universal_symbol: { symbol: "AAPL" },
      action: "BUY",
      filled_quantity: "3",
      execution_price: "190",
      time_executed: new Date(evening + 4_000).toISOString(),
    },
  ];
  const activities = [
    { id: "a-eve", type: "BUY", symbol: { symbol: "AAPL" }, units: 3, price: 190, amount: -570.5, fee: 0.5, trade_date: new Date(evening).toISOString() },
    { id: "a-date", type: "SELL", symbol: { symbol: "MSFT" }, units: -1, price: 400, amount: 400, fee: 0, trade_date: "2026-11-13T00:00:00Z" },
    { id: "a-next", type: "BUY", symbol: { symbol: "TSLA" }, units: 1, price: 300, amount: -300, fee: 0, trade_date: "2026-11-14T00:00:00Z" },
  ];
  const out = snaptradeExecutions({ orders, activities, syncedThrough: "2026-11-13" }, ref, "fidelity");
  assert.deepEqual(
    out.map((e) => [e.id, e.tradedAt, e.commission, e.provisional ?? false]),
    [
      ["fidelity:acct-1:a:a-eve", new Date(evening).toISOString(), 0.5, false],
      ["fidelity:acct-1:a:a-date", new Date(etToUtc(2026, 11, 13, 0, 0)).toISOString(), 0, false],
    ],
    "the evening fill is listed once, from its transaction; a day after the synced one waits",
  );
  assert.deepEqual(activityTime(new Date(evening).toISOString()), { day: "2026-11-13", at: evening });
  assert.deepEqual(activityTime("2026-11-14 01:30:00.123456+00:00"), { day: "2026-11-13", at: Date.parse("2026-11-14T01:30:00.123Z") });
  assert.deepEqual(activityTime("2026-11-14"), { day: "2026-11-14", at: null });
  assert.deepEqual(activityTime("2026-11-14T00:00:00.000Z"), { day: "2026-11-14", at: null }, "midnight UTC is a date only");
  assert.deepEqual(activityTime("2026-11-14T15:00:00"), { day: "2026-11-14", at: null }, "a time without a zone is read as a date only");
  assert.deepEqual(activityTime(null), { day: null, at: null });
});

test("a holding SnapTrade sent no price for: no last price, market value or P&L, and the read names it", async () => {
  // The mapping alone: nothing is made up from a missing price or cost.
  const ref = { id: "acct-x", external_id: "snap-x" };
  const stockOut = snaptradePosition(position(stock("ZZZ", "cs"), 10, /** @type {any} */ (null), 50, null), ref, "fidelity");
  assert.deepEqual([stockOut.qty, stockOut.avgCost, "last" in stockOut, "marketValue" in stockOut, "unrealizedPnl" in stockOut], [10, 50, false, false, false]);
  const noCost = snaptradePosition(position(stock("YYY", "cs"), 2, 30, null, null), ref, "fidelity");
  assert.deepEqual([noCost.last, noCost.marketValue, "avgCost" in noCost, "unrealizedPnl" in noCost], [30, 60, false, false]);
  const opt = snaptradeOptionPosition({ symbol: { option_symbol: OPTION }, units: 1, price: null, average_purchase_price: 250 }, ref, "fidelity");
  assert.deepEqual([opt.avgCost, "last" in opt, "marketValue" in opt, "unrealizedPnl" in opt], [2.5, false, false, false]);

  // Through the service: the position is listed, and the read says why it has no value.
  const wid = randomUUID();
  const sub = randomUUID();
  const token = () => h.token({ wid, sub });
  fake.state.portal.outcome = "SUCCESS";
  fake.state.portal.slug = null;
  fake.state.portal.accounts = () => [{ name: "Unpriced", positions: [position(stock("ZZZ", "cs"), 10, /** @type {any} */ (null), 50, null)] }];
  const s = await startAndHop("fidelity", { token: token() });
  const r = await finish(s, { token: token() });
  assert.equal(r.claim?.status, 200, r.claim?.text ?? r.done.text);
  const p = await req("/v1/portfolio", { token: token() });
  assert.equal(p.status, 200, p.text);
  const z = p.json.positions.find((/** @type {any} */ x) => x.symbol === "ZZZ");
  assert.deepEqual([z?.qty, z?.avgCost, z?.last, z?.marketValue, z?.unrealizedPnl], [10, 50, undefined, undefined, undefined]);
  assert.deepEqual(
    p.json.errors.map((/** @type {any} */ e) => e.message),
    ["Fidelity sent no price for ZZZ through SnapTrade, so its market value is not shown."],
  );
  fake.state.portal.accounts = null;
});

test("D1: a forwarded portal link the victim completes is refused at the callback, and the SnapTrade connection it made is deleted", async () => {
  fake.state.portal.outcome = "SUCCESS";
  fake.state.portal.slug = null;
  fake.state.portal.accounts = () => [{ name: "Victim Fidelity" }];
  const attackerWid = randomUUID();
  const attacker = h.token({ wid: attackerWid, sub: randomUUID() });
  const s = await startAndHop("fidelity", { token: attacker });
  assert.equal(s.hop.status, 200, s.hop.text);
  // The victim follows the forwarded portal link: SnapTrade makes the connection under the attacker's SnapTrade user.
  const back = await fake.follow(s.hop.json.redirectUrl);
  const victimAuth = String(new URL(back.location).searchParams.get("connection_id"));
  assert.ok(fake.state.authorizations.has(victimAuth));
  // The victim's browser holds no binding of this login.
  const refused = await req("/v1/aggregator/complete", {
    method: "POST",
    token: h.flowToken(),
    body: { connectionId: s.id, status: "SUCCESS", authorizationId: victimAuth, binding: newBinding().nonce },
  });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, "binding");
  assert.equal(fake.state.authorizations.has(victimAuth), false, "the refused login's SnapTrade connection is deleted at once");

  // The attacker's second login cannot attach it by id: it is gone.
  const again = await startAndHop("fidelity", { token: attacker });
  const done = await req("/v1/aggregator/complete", { method: "POST", token: h.flowToken(), body: { connectionId: again.id, status: "SUCCESS", authorizationId: victimAuth, binding: again.b.nonce } });
  assert.equal(done.status, 400, done.text);
  assert.equal(done.json.code, "wrong_user");
  fake.state.portal.accounts = null;
});

test("complete takes only a SnapTrade connection made since this login started, and never deletes an older one", async () => {
  const wid = randomUUID();
  const sub = randomUUID();
  /** Service JWTs live 60 s and the clock moves: a fresh one per call. */
  const token = () => h.token({ wid, sub });
  const first = await startAndHop("fidelity", { token: token() });
  assert.equal(first.hop.status, 200, first.hop.text);
  const snapUser = String(h.rows("broker_aggregator_users").find((r) => r.workspace_id === wid)?.external_user_id ?? "");
  assert.ok(snapUser);
  const older = fake.addAuthorization({ userId: snapUser, slug: "FIDELITY", createdAt: h.now() - 10 * MIN, accounts: [{ name: "Older login" }] });
  h.advance(MIN);
  const s = await startAndHop("fidelity", { token: token() });
  const done = await req("/v1/aggregator/complete", { method: "POST", token: h.flowToken(), body: { connectionId: s.id, status: "SUCCESS", authorizationId: older, binding: s.b.nonce } });
  assert.equal(done.status, 400, done.text);
  assert.equal(done.json.code, "stale_authorization");
  assert.equal(done.json.error, "This Fidelity connection was not made by this login. Start again from Brokers.");
  assert.equal(row(s.id), undefined, "the attempt is removed");

  // A refusal at the callback (another browser) does not delete a connection this login did not make.
  const third = await startAndHop("fidelity", { token: token() });
  const wrong = await req("/v1/aggregator/complete", { method: "POST", token: h.flowToken(), body: { connectionId: third.id, status: "SUCCESS", authorizationId: older, binding: newBinding().nonce } });
  assert.equal(wrong.status, 403, wrong.text);
  assert.ok(fake.state.authorizations.has(older), "an authorization older than the login is left to the sweep");
  fake.state.authorizations.delete(older);
});

test("no userSecret or consumer key in any table, log line or reply; SnapTrade never got a trade call", async () => {
  await sleep(20);
  const secrets = [CONSUMER_KEY, ...[...fake.state.users.values()].map((u) => u.userSecret)];
  assert.ok(secrets.length >= 3);
  const tables = JSON.stringify([...h.db.tables.entries()]);
  const logs = h.logLines.join("\n");
  const answers = replies.join("\n");
  for (const s of secrets) {
    assert.ok(!tables.includes(s), "a secret in a table");
    assert.ok(!logs.includes(s), "a secret in a log line");
    assert.ok(!answers.includes(s), "a secret in a reply");
  }
  assert.ok(!logs.includes("userSecret="), "no query string in the log");
  assert.ok(!h.rows("audit_events").some((a) => JSON.stringify(a).includes("userSecret")));
  assert.ok(!fake.state.calls.some((c) => c.path.startsWith("/trade")));
  assert.deepEqual(fake.state.refused, [], "every call Nasscord made was signed as SnapTrade expects");
});
