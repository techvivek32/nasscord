import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ALPACA_HOSTS, ALPACA_READ_ALLOW, alpacaHosts, createAlpacaClient } from "../src/alpaca/client.mjs";
import { ALPACA_DETAIL, createAdapter } from "../src/alpaca/index.mjs";
import { ReadOnlyViolation } from "../src/errors.mjs";
import { createBrokerHttp, isAllowed } from "../src/http.mjs";
import { sleep } from "./helpers/common.mjs";
import { startFakeAlpaca } from "./helpers/fake-alpaca.mjs";
import { createHarness } from "./helpers/harness.mjs";

/**
 * The Alpaca adapter end to end: the service (memory database, real flows and registry) against a
 * fake Alpaca with a live and a paper host. Tests run in order and share the connections.
 */

const DAY = 24 * 3_600_000;

/** @type {Awaited<ReturnType<typeof startFakeAlpaca>>} */
let fake;
/** @type {Awaited<ReturnType<typeof createHarness>>} */
let h;
/** Every key ID and secret the fake ever issued: none may appear in a table, a log line or a reply. */
const issued = /** @type {string[]} */ ([]);
/** Every reply body the tests received. */
const replies = /** @type {string[]} */ ([]);

/** @type {ReturnType<Awaited<ReturnType<typeof startFakeAlpaca>>["addAccount"]>} */
let live;
/** @type {typeof live} */
let paper;
/** @type {typeof live} */
let other;
/** @type {typeof live} */
let closed;
let liveId = "";
let paperId = "";

/** @param {Parameters<typeof fake.addAccount>[0]} o */
function add(o) {
  const a = fake.addAccount(o);
  issued.push(a.keyId, a.secret);
  return a;
}

/** @param {typeof live} a */
function regenerate(a) {
  const pair = fake.regenerate(a);
  issued.push(pair.keyId, pair.secret);
  return pair;
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, token?: string }} [o]
 */
async function req(path, o) {
  const r = await h.req(path, o);
  replies.push(r.text);
  return r;
}

/** @param {typeof live} a @param {Record<string, unknown>} [extra] */
const connect = (a, extra = {}) => req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: a.keyId, secret: a.secret, ...extra } });

/** Past every read cache (15 s / 30 s) and every rate-limit pause. */
const later = () => h.advance(2 * 60_000);

/** @param {string} id */
const row = (id) => h.rows("broker_connections").find((r) => r.id === id);

/** @param {any} json @param {string} id */
const errorOf = (json, id) => json.errors.find((/** @type {any} */ e) => e.connectionId === id);

/** 520 orders an hour apart, an old GTC order still open, an old filled one, and a bracket. @param {number} t */
function makeOrders(t) {
  const statuses = ["filled", "canceled", "new", "partially_filled", "rejected"];
  /** @type {any[]} */
  const list = [];
  for (let i = 0; i < 520; i++) {
    list.push({
      id: `ord-${String(i).padStart(4, "0")}`,
      client_order_id: `cli-${i}`,
      symbol: i % 2 ? "AAPL" : "MSFT",
      asset_class: "us_equity",
      type: i % 3 ? "limit" : "market",
      order_type: i % 3 ? "limit" : "market",
      side: i % 2 ? "buy" : "sell",
      qty: "1",
      filled_qty: statuses[i % 5] === "filled" ? "1" : "0",
      filled_avg_price: statuses[i % 5] === "filled" ? "101.5" : null,
      limit_price: i % 3 ? "101.50" : null,
      time_in_force: "day",
      status: statuses[i % 5],
      extended_hours: false,
      submitted_at: new Date(t - (i + 1) * 3_600_000).toISOString(),
      created_at: new Date(t - (i + 1) * 3_600_000).toISOString(),
      legs: null,
    });
  }
  const at = (/** @type {number} */ ms) => new Date(t - ms).toISOString();
  list.push({ id: "ord-old-open", symbol: "SPY", type: "limit", side: "buy", qty: "3", filled_qty: "0", limit_price: "400", time_in_force: "gtc", status: "new", submitted_at: at(45 * DAY), legs: null });
  list.push({ id: "ord-old-done", symbol: "SPY", type: "market", side: "buy", qty: "1", filled_qty: "1", time_in_force: "day", status: "filled", submitted_at: at(40 * DAY), legs: null });
  // A bracket older than 30 days whose entry filled: only its legs are still open.
  list.push({
    id: "ord-old-bracket",
    symbol: "AMD",
    type: "market",
    order_class: "bracket",
    side: "buy",
    qty: "4",
    filled_qty: "4",
    filled_avg_price: "150",
    time_in_force: "gtc",
    status: "filled",
    submitted_at: at(45 * DAY),
    legs: [
      { id: "ord-old-take", symbol: "AMD", type: "limit", side: "sell", qty: "4", limit_price: "180", time_in_force: "gtc", status: "new", submitted_at: at(45 * DAY), legs: null },
      { id: "ord-old-stop", symbol: "AMD", type: "stop", side: "sell", qty: "4", stop_price: "140", time_in_force: "gtc", status: "held", submitted_at: at(45 * DAY), legs: null },
    ],
  });
  list.push({
    id: "ord-bracket",
    symbol: "NVDA",
    type: "market",
    order_class: "bracket",
    side: "buy",
    qty: "10",
    filled_qty: "10",
    filled_avg_price: "120.10",
    time_in_force: "gtc",
    status: "filled",
    submitted_at: at(30 * 60_000),
    legs: [
      { id: "ord-take", symbol: "NVDA", type: "limit", side: "sell", qty: "10", limit_price: "130", time_in_force: "gtc", status: "new", submitted_at: at(30 * 60_000), legs: null },
      { id: "ord-stop", symbol: "NVDA", type: "stop", side: "sell", qty: "10", stop_price: "115", time_in_force: "gtc", status: "held", submitted_at: at(30 * 60_000), legs: null },
    ],
  });
  return list;
}

/** 130 fills in the last 30 days (every seventh a partial fill, one option) and one older. @param {number} t */
function makeFills(t) {
  /** @type {any[]} */
  const list = [];
  for (let i = 0; i < 130; i++) {
    list.push({
      id: `${String(t - i * 3_000_000).padStart(17, "0")}::fill-${i}`,
      activity_type: "FILL",
      transaction_time: new Date(t - (i + 1) * 3_000_000).toISOString(),
      type: i % 7 === 0 ? "partial_fill" : "fill",
      price: i === 5 ? "1.25" : "100.50",
      qty: "2",
      side: i % 2 ? "buy" : "sell",
      symbol: i === 5 ? "AAPL240119C00190000" : "AAPL",
      leaves_qty: "0",
      order_id: `ord-${i}`,
      cum_qty: "2",
      order_status: "filled",
    });
  }
  list.push({ id: "old-fill", activity_type: "FILL", transaction_time: new Date(t - 35 * DAY).toISOString(), type: "fill", price: "10", qty: "1", side: "buy", symbol: "F" });
  return list;
}

before(async () => {
  fake = await startFakeAlpaca();
  const t = Date.now();
  live = add({
    host: "live",
    multiplier: "4",
    cash: "-23140.20",
    equity: "103820.56",
    lastEquity: "102716.42",
    buyingPower: "262113.63",
    positions: [
      { asset_id: "a-aapl", symbol: "AAPL", asset_class: "us_equity", qty: "5", side: "long", avg_entry_price: "100.0", current_price: "120.0", market_value: "600.0", unrealized_pl: "100.0", unrealized_intraday_pl: "10.0" },
      { asset_id: "a-tsla", symbol: "TSLA", asset_class: "us_equity", qty: "-3", side: "short", avg_entry_price: "250", current_price: "240", market_value: "-720", unrealized_pl: "30", unrealized_intraday_pl: "-4.5" },
      { asset_id: "a-opt", symbol: "AAPL240119C00190000", asset_class: "us_option", qty: "2", side: "long", avg_entry_price: "1.25", current_price: "1.50", market_value: "300", unrealized_pl: "50" },
      { asset_id: "a-btc", symbol: "BTCUSD", asset_class: "crypto", qty: "0.0123", side: "long", avg_entry_price: "60000", current_price: "65000.5", market_value: "799.51", unrealized_pl: "61.51" },
    ],
    orders: makeOrders(t),
    fills: makeFills(t),
  });
  paper = add({ host: "paper", accountNumber: "PA3XYZ12QW", equity: "100000", lastEquity: "99000", cash: "100000", buyingPower: "200000", multiplier: "2" });
  other = add({ host: "live" });
  closed = add({ host: "live", status: "ACCOUNT_CLOSED" });
  h = await createHarness({
    env: {
      BROKER_URL_OVERRIDES: JSON.stringify({ alpaca: fake.urls }),
      BROKER_CONNECT_PER_USER: "500",
      BROKER_CONNECT_GLOBAL_PER_MIN: "500",
    },
    adapters: [["alpaca", createAdapter]],
  });
  fake.state.now = h.now;
});

after(async () => {
  await h?.close();
  await fake?.close();
});

test("options: the Alpaca key method is built and open to everyone", async () => {
  const r = await req("/v1/options");
  assert.equal(r.status, 200);
  const o = r.json.options.find((/** @type {any} */ x) => x.brokerId === "alpaca" && x.method === "alpaca_key");
  assert.equal(o.built, true);
  assert.equal(o.available, true);
  assert.equal(o.flow, "api_key");
  assert.equal(o.audience, "all");
  assert.deepEqual(o.environments, ["production", "paper"], "Live and the user's own Paper; Alpaca has no sample-data environment");
  assert.equal(o.callbackUrl, null);
});

test("a paper key is refused by the live host and accepted by the paper host: a Paper connection", async () => {
  const calls = fake.state.calls.length;
  const r = await connect(paper);
  assert.equal(r.status, 200, r.text);
  const c = r.json.connection;
  paperId = c.id;
  assert.equal(c.method, "alpaca_key");
  assert.equal(c.environment, "paper");
  assert.equal(c.status, "active");
  assert.equal(c.sessionExpiresAt, null, "keys do not expire");
  assert.deepEqual(
    c.accounts.map((/** @type {any} */ a) => [a.label, a.displayNumber, a.type, a.included]),
    [["Alpaca Paper", "PA3•••QW", "paper", true]],
  );
  assert.deepEqual(
    fake.state.calls.slice(calls).map((x) => `${x.host} ${x.method} ${x.path}`),
    ["live GET /v2/account", "paper GET /v2/account"],
  );
  assert.equal(row(c.id)?.external_ref, paper.id, "the login is named by the Alpaca account id");
  assert.equal(h.rows("broker_accounts").find((a) => a.connection_id === c.id)?.external_id, paper.id);
  const stored = h.svc.secretBox.decrypt(c.id, /** @type {any} */ (h.rows("broker_secrets").find((s) => s.connection_id === c.id)));
  assert.deepEqual(stored, { keyId: paper.keyId, secretKey: paper.secret, host: "paper" });
  await sleep(10);
  assert.ok(h.rows("audit_events").some((a) => a.action === "broker.alpaca.connect" && a.result === "ok"));
});

test("a live key connects as Live, checked on the live host only", async () => {
  const calls = fake.state.calls.length;
  const r = await connect(live);
  assert.equal(r.status, 200, r.text);
  const c = r.json.connection;
  liveId = c.id;
  assert.equal(c.environment, "production");
  assert.equal(c.accounts[0].type, "margin", "multiplier 4");
  assert.equal(c.accounts[0].label, "Alpaca Margin");
  assert.deepEqual(
    fake.state.calls.slice(calls).map((x) => `${x.host} ${x.path}`),
    ["live /v2/account"],
  );
  assert.equal(row(c.id)?.external_ref, live.id);
});

test("a wrong pair is a 400 with a readable sentence and leaves no connection; a missing Key ID never reaches Alpaca", async () => {
  const rows = h.rows("broker_connections").length;
  const wrong = await req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: live.keyId, secret: "not-the-secret-0000000000" } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.code, "alpaca_key_rejected");
  assert.match(wrong.json.error, /^Alpaca did not accept this key\. /);
  assert.equal(h.rows("broker_connections").length, rows, "no connection row left behind");
  assert.equal(h.rows("broker_secrets").length, 2);

  const calls = fake.state.calls.length;
  const noId = await req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", secret: live.secret } });
  assert.equal(noId.status, 400);
  assert.equal(noId.json.code, "bad_key_id");
  assert.equal(fake.state.calls.length, calls, "nothing was sent to Alpaca");

  const sandbox = await req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: live.keyId, secret: live.secret, environment: "sandbox" } });
  assert.equal(sandbox.status, 400, "Alpaca offers no sandbox here");
  await sleep(10);
  assert.ok(h.rows("audit_events").some((a) => a.action === "broker.alpaca.connect" && a.result === "denied"));
});

test("the same account connected twice keeps one connection and its Included switch", async () => {
  const acct = h.rows("broker_accounts").find((a) => a.connection_id === paperId);
  assert.ok(acct);
  acct.included = false;
  const again = await connect(paper);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.connection.id, paperId);
  assert.equal(again.json.connection.accounts[0].included, false, "the user's choice survives");
  assert.equal(h.rows("broker_connections").filter((r) => r.broker_id === "alpaca" && r.environment === "paper" && r.status !== "disconnected").length, 1);
  acct.included = true;
});

test("portfolio: balances and positions from Alpaca's strings", async () => {
  const r = await req("/v1/portfolio");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.errors, []);
  const liveAcct = h.rows("broker_accounts").find((a) => a.connection_id === liveId);
  const paperAcct = h.rows("broker_accounts").find((a) => a.connection_id === paperId);
  assert.deepEqual(
    r.json.accounts.find((/** @type {any} */ a) => a.accountId === liveAcct?.id),
    { accountId: liveAcct?.id, netLiq: 103820.56, buyingPower: 262113.63, cash: -23140.2, dayPnl: 1104.14, currency: "USD" },
  );
  assert.equal(r.json.accounts.find((/** @type {any} */ a) => a.accountId === paperAcct?.id)?.dayPnl, 1000);
  const pos = r.json.positions.filter((/** @type {any} */ p) => p.accountId === liveAcct?.id);
  assert.equal(pos.length, 4);
  const bySymbol = Object.fromEntries(pos.map((/** @type {any} */ p) => [p.symbol, p]));
  assert.equal(bySymbol.AAPL.qty, 5);
  assert.equal(bySymbol.AAPL.dayPnl, 10);
  assert.equal(bySymbol.TSLA.qty, -3, "a short is negative");
  assert.equal(bySymbol.TSLA.marketValue, -720);
  assert.equal(bySymbol.AAPL240119C00190000.secType, "OPT");
  assert.equal(bySymbol.BTCUSD.secType, "CRYPTO");
  assert.equal(bySymbol.BTCUSD.qty, 0.0123);
  assert.ok(pos.every((/** @type {any} */ p) => p.brokerId === "alpaca" && p.id.startsWith(`alpaca:${liveAcct?.id}:`)));

  const calls = fake.state.calls.length;
  await req("/v1/portfolio");
  assert.equal(fake.state.calls.length, calls, "reused within the 15-second cache");
});

test("orders: every open order plus 30 days, paged by until, legs under their parent", async () => {
  const before = fake.state.calls.length;
  const r = await req("/v1/orders");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.errors, []);
  const liveAcct = h.rows("broker_accounts").find((a) => a.connection_id === liveId);
  const orders = r.json.orders.filter((/** @type {any} */ o) => o.accountId === liveAcct?.id);
  assert.equal(orders.length, 520 + 1 + 3 + 2, "520 recent, the old open GTC order, the bracket and its 2 legs, the 2 open legs of the old bracket");
  assert.equal(new Set(orders.map((/** @type {any} */ o) => o.id)).size, orders.length, "no order twice");
  assert.ok(!orders.some((/** @type {any} */ o) => o.brokerRef === "ord-old-done"), "a closed order older than 30 days is left out");
  assert.ok(!orders.some((/** @type {any} */ o) => o.brokerRef === "ord-old-bracket"), "the old filled parent is left out");
  const oldTake = orders.find((/** @type {any} */ o) => o.brokerRef === "ord-old-take");
  const oldStop = orders.find((/** @type {any} */ o) => o.brokerRef === "ord-old-stop");
  assert.equal(oldTake?.status, "submitted", "an open leg of a filled bracket older than 30 days is still shown");
  assert.equal(oldTake?.price, 180);
  assert.equal(oldStop?.status, "working");
  assert.equal(oldStop?.parentId, undefined, "read flat: its parent is not in the list");
  const old = orders.find((/** @type {any} */ o) => o.brokerRef === "ord-old-open");
  assert.equal(old?.status, "submitted");
  assert.equal(old?.tif, "GTC");
  const take = orders.find((/** @type {any} */ o) => o.brokerRef === "ord-take");
  const stop = orders.find((/** @type {any} */ o) => o.brokerRef === "ord-stop");
  assert.equal(take?.parentId, `alpaca:${liveAcct?.id}:ord-bracket`);
  assert.equal(stop?.parentId, `alpaca:${liveAcct?.id}:ord-bracket`);
  assert.equal(stop?.status, "working", "held");
  assert.equal(stop?.price, 115);
  const counts = orders.reduce((/** @type {Record<string, number>} */ m, /** @type {any} */ o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {});
  assert.deepEqual(counts, { filled: 105, cancelled: 104, submitted: 107, working: 106, rejected: 104 });
  assert.ok(orders.every((/** @type {any} */ o, /** @type {number} */ i) => i === 0 || orders[i - 1].placedAt >= o.placedAt), "newest first");

  const calls = fake.state.calls.slice(before).filter((c) => c.host === "live" && c.path === "/v2/orders");
  assert.equal(calls.length, 3, "open orders, then two pages of the last 30 days");
  assert.equal(calls[0].query.status, "open");
  assert.equal(calls[0].query.after, undefined, "open orders whatever their age");
  assert.equal(calls[0].query.nested, "false", "open orders flat, so open legs of a filled parent come back");
  assert.equal(calls[1].query.status, "all");
  assert.equal(calls[1].query.limit, "500");
  assert.equal(calls[1].query.nested, "true");
  assert.equal(calls[1].query.direction, "desc");
  assert.ok(calls[1].query.after && Date.parse(calls[1].query.after) < Date.now() - 29 * DAY);
  assert.equal(calls[1].query.until, undefined);
  assert.ok(calls[2].query.until, "the second page continues before the oldest order of the first");
});

test("open orders are paged too: more than 500 open orders older than 30 days all come back", async () => {
  const t = Date.now();
  const busy = add({
    host: "live",
    orders: Array.from({ length: 1_050 }, (_, i) => ({
      id: `gtc-${String(i).padStart(4, "0")}`,
      symbol: "F",
      type: "limit",
      side: "buy",
      qty: "1",
      filled_qty: "0",
      limit_price: "9",
      time_in_force: "gtc",
      status: "new",
      submitted_at: new Date(t - 40 * DAY - i * 60_000).toISOString(),
      legs: null,
    })),
  });
  const client = createAlpacaClient({ http: (o) => createBrokerHttp(o), base: fake.urls.live, keyId: busy.keyId, secretKey: busy.secret, bucketKey: "alpaca:test-busy" });
  const before = fake.state.calls.length;
  const list = await client.orders(new Date(t - 30 * DAY).toISOString());
  assert.equal(list.length, 1_050);
  assert.equal(new Set(list.map((o) => o.id)).size, 1_050, "the oldest open orders are not dropped, and none twice");
  const calls = fake.state.calls.slice(before).filter((c) => c.path === "/v2/orders");
  assert.deepEqual(
    calls.map((c) => `${c.query.status} ${c.query.nested} ${c.query.until ? "until" : "-"}`),
    ["open false -", "open false until", "open false until", "all true -"],
  );
});

test("executions: FILL activities paged by page_token, partial fills included", async () => {
  const before = fake.state.calls.length;
  const r = await req("/v1/executions");
  assert.equal(r.status, 200, r.text);
  const liveAcct = h.rows("broker_accounts").find((a) => a.connection_id === liveId);
  const fills = r.json.executions.filter((/** @type {any} */ e) => e.accountId === liveAcct?.id);
  assert.equal(fills.length, 130, "the fill older than 30 days is not read");
  const option = fills.find((/** @type {any} */ e) => e.symbol === "AAPL240119C00190000");
  assert.equal(option?.net, -250, "2 contracts at 1.25, 100 shares each, bought");
  assert.ok(fills.every((/** @type {any} */ e) => e.commission === 0 && e.provisional === true), "regulatory fees come later as FEE activities: never shown as final");
  const calls = fake.state.calls.slice(before).filter((c) => c.host === "live" && c.path === "/v2/account/activities/FILL");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.page_size, "100");
  assert.equal(calls[0].query.page_token, undefined);
  assert.ok(calls[1].query.page_token?.endsWith("::fill-99"), "continues after the last activity of the first page");
});

test("a 429 pauses the connection's bucket, and a connect step answers 429 with Retry-After", async () => {
  later();
  fake.state.failNext.push({ host: "live", path: "/v2/positions", status: 429, resetInSec: 30 });
  const first = await req("/v1/portfolio");
  assert.equal(first.status, 200);
  assert.match(errorOf(first.json, liveId)?.message ?? "", /^Alpaca is limiting requests right now/);
  assert.equal(errorOf(first.json, paperId), undefined, "the paper connection has its own bucket");
  const calls = fake.count("/v2/positions", "live") + fake.count("/v2/account", "live");
  const second = await req("/v1/portfolio");
  assert.match(errorOf(second.json, liveId)?.message ?? "", /^Alpaca is limiting requests right now/);
  assert.equal(fake.count("/v2/positions", "live") + fake.count("/v2/account", "live"), calls, "paused: nothing more reached Alpaca");
  later();
  const third = await req("/v1/portfolio");
  assert.deepEqual(third.json.errors, []);

  fake.state.failNext.push({ host: "live", path: "/v2/account", status: 429, resetInSec: 20 });
  const step = await connect(other);
  assert.equal(step.status, 429);
  assert.ok(Number(step.headers.get("retry-after")) >= 1);
  assert.equal(h.rows("broker_connections").filter((r) => r.external_ref === other.id).length, 0);
  later();
});

test("a 429 on one key's check pauses that key only: another key connects at once, and paused buckets are dropped", async () => {
  const busy = add({ host: "live" });
  const calm = add({ host: "live" });
  const stray = add({ host: "live" });
  // Past the pause the previous test left on its key, and a check that drops it.
  h.advance(11 * 60_000);
  assert.equal((await connect(calm)).status, 200);
  const buckets = h.svc.limiter.size();
  fake.state.failNext.push({ host: "live", path: "/v2/account", status: 429, resetInSec: 60 });
  const limited = await connect(busy);
  assert.equal(limited.status, 429, limited.text);
  assert.ok(Number(limited.headers.get("retry-after")) >= 30);

  const calls = fake.count("/v2/account");
  const ok = await connect(calm);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(fake.count("/v2/account"), calls + 1, "the other key was checked with Alpaca at once");

  const again = await connect(busy);
  assert.equal(again.status, 429, "the same key within its pause");
  assert.equal(fake.count("/v2/account"), calls + 1, "answered without calling Alpaca");
  assert.equal(h.svc.limiter.size(), buckets + 1, "only the paused key's check bucket is kept");

  h.advance(2 * 60_000);
  const done = await connect(busy);
  assert.equal(done.status, 200, done.text);
  assert.equal(h.svc.limiter.size(), buckets, "a check that ends drops its bucket");

  // A paused key that never comes back: its bucket goes once the longest pause is over.
  fake.state.failNext.push({ host: "live", path: "/v2/account", status: 429, resetInSec: 5 });
  assert.equal((await connect(stray)).status, 429);
  assert.equal(h.svc.limiter.size(), buckets + 1);
  h.advance(11 * 60_000);
  assert.equal((await connect(calm)).status, 200);
  assert.equal(h.svc.limiter.size(), buckets);
});

test("a 403 on one endpoint fails that read only; the connection stays", async () => {
  later();
  fake.forbid(live, "/v2/account/activities/FILL");
  const r = await req("/v1/executions");
  assert.match(errorOf(r.json, liveId)?.message ?? "", /^Alpaca refused to send the fills of this account \(403\)/);
  assert.equal(row(liveId)?.status, "active");
  fake.forbid(live, "/v2/account/activities/FILL", false);
  later();
  assert.equal(errorOf((await req("/v1/executions")).json, liveId), undefined);
});

test("a regenerated key expires the connection; renew asks for the key; another account's key is a 409; the new key reconnects", async () => {
  const renewOk = await req(`/v1/connections/${liveId}/renew`, { method: "POST" });
  assert.equal(renewOk.status, 200, renewOk.text);
  assert.equal(renewOk.json.next, undefined, "a working key needs nothing");

  later();
  const pair = regenerate(live);
  const r = await req("/v1/portfolio");
  assert.equal(errorOf(r.json, liveId)?.message, ALPACA_DETAIL.keyRefused);
  assert.equal(row(liveId)?.status, "expired");
  assert.equal(row(liveId)?.status_detail, "Alpaca no longer accepts this key. Paste the new key.");
  later();
  assert.equal(errorOf((await req("/v1/orders")).json, liveId), undefined, "an expired connection is not read");

  const renew = await req(`/v1/connections/${liveId}/renew`, { method: "POST" });
  assert.equal(renew.status, 200, renew.text);
  assert.deepEqual(renew.json.next, { kind: "api_key" });
  assert.equal(renew.json.connection.status, "expired");

  const wrongAccount = await connect(other, { connectionId: liveId });
  assert.equal(wrongAccount.status, 409);
  assert.equal(wrongAccount.json.code, "other_account");
  assert.equal(row(liveId)?.status, "expired");

  const fixed = await req("/v1/keys/connect", { method: "POST", body: { brokerId: "alpaca", keyId: pair.keyId, secret: pair.secret, connectionId: liveId } });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.json.connection.id, liveId);
  assert.equal(fixed.json.connection.status, "active");
  later();
  assert.deepEqual((await req("/v1/portfolio")).json.errors, []);
});

test("a reset or deleted paper account: the paper wording, and its new paper account is a new connection", async () => {
  later();
  regenerate(paper); // Alpaca now deletes and re-creates paper accounts: the old pair answers 401
  const r = await req("/v1/portfolio");
  assert.equal(errorOf(r.json, paperId)?.message, ALPACA_DETAIL.paperKeyRefused);
  assert.match(String(row(paperId)?.status_detail), /if you reset or deleted this paper account, disconnect it and connect the new one/);

  const fresh = add({ host: "paper" });
  const replace = await connect(fresh, { connectionId: paperId });
  assert.equal(replace.status, 409, "another paper account is not this connection");
  const calls = fake.state.calls.length;
  const added = await connect(fresh);
  assert.equal(added.status, 200, added.text);
  assert.notEqual(added.json.connection.id, paperId);
  assert.equal(added.json.connection.environment, "paper");
  assert.deepEqual(
    fake.state.calls.slice(calls).map((c) => c.host),
    ["live", "paper"],
  );
});

test("a closed account is refused at connect and becomes an error on read", async () => {
  const refused = await connect(closed);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "alpaca_account_closed");
  assert.equal(h.rows("broker_connections").filter((r) => r.external_ref === closed.id).length, 0);

  const ok = await connect(other);
  assert.equal(ok.status, 200, ok.text);
  const id = ok.json.connection.id;
  fake.setStatus(other, "ACCOUNT_CLOSED");
  later();
  const r = await req("/v1/portfolio");
  assert.equal(errorOf(r.json, id)?.message, ALPACA_DETAIL.closed);
  assert.equal(row(id)?.status, "error");
  fake.setStatus(other, "ACTIVE");

  // Closed between two reads: Reconnect says so instead of asking for a new key.
  const gone = add({ host: "live" });
  const made = await connect(gone);
  assert.equal(made.status, 200, made.text);
  fake.setStatus(gone, "ACCOUNT_CLOSED");
  const renew = await req(`/v1/connections/${made.json.connection.id}/renew`, { method: "POST" });
  assert.equal(renew.status, 409);
  assert.equal(renew.json.code, "account_closed");
  assert.equal(renew.json.error, ALPACA_DETAIL.closed);
  assert.equal(row(made.json.connection.id)?.status, "error");
});

test("closed by a read first: Reconnect still says closed instead of asking for a key; open again, it is active", async () => {
  const a = add({ host: "live" });
  const made = await connect(a);
  assert.equal(made.status, 200, made.text);
  const id = made.json.connection.id;
  fake.setStatus(a, "ACCOUNT_CLOSED");
  later();
  assert.equal(errorOf((await req("/v1/portfolio")).json, id)?.message, ALPACA_DETAIL.closed);
  assert.equal(row(id)?.status, "error");

  const renew = await req(`/v1/connections/${id}/renew`, { method: "POST" });
  assert.equal(renew.status, 409, renew.text);
  assert.equal(renew.json.code, "account_closed");
  assert.equal(renew.json.error, ALPACA_DETAIL.closed);
  assert.equal(renew.json.next, undefined, "no key dialog: a new key cannot help");
  assert.equal(row(id)?.status, "error");

  fake.setStatus(a, "ACTIVE");
  const back = await req(`/v1/connections/${id}/renew`, { method: "POST" });
  assert.equal(back.status, 200, back.text);
  assert.equal(back.json.next, undefined);
  assert.equal(back.json.connection.status, "active");
  assert.equal(row(id)?.status_detail, null);
  later();
  assert.equal(errorOf((await req("/v1/portfolio")).json, id), undefined, "read again");

  // Closed, and the key regenerated since: nothing to check with, so ask for the key.
  fake.setStatus(a, "ACCOUNT_CLOSED");
  later();
  await req("/v1/portfolio");
  assert.equal(row(id)?.status, "error");
  regenerate(a);
  const ask = await req(`/v1/connections/${id}/renew`, { method: "POST" });
  assert.equal(ask.status, 200, ask.text);
  assert.deepEqual(ask.json.next, { kind: "api_key" });
});

test("Alpaca down on the live host: a paper key still connects; a live key answers 502 and leaves nothing", async () => {
  const p = add({ host: "paper" });
  fake.state.failNext.push({ host: "live", path: "/v2/account", status: 503 });
  const okPaper = await connect(p);
  assert.equal(okPaper.status, 200, okPaper.text);
  assert.equal(okPaper.json.connection.environment, "paper");

  const l = add({ host: "live" });
  fake.state.failNext.push({ host: "live", path: "/v2/account", status: 503 });
  const down = await connect(l);
  assert.equal(down.status, 502);
  assert.match(down.json.error, /^Alpaca is not answering right now \(503\)/);
  assert.equal(h.rows("broker_connections").filter((r) => r.external_ref === l.id).length, 0);
});

test("a key replaced while a read still held the old one does not expire the connection", async () => {
  const a = add({ host: "live" });
  const made = await connect(a);
  assert.equal(made.status, 200, made.text);
  const id = made.json.connection.id;
  const pair = regenerate(a);
  // Replace-key mode stored the new key while this read still used the old one (in memory).
  await h.svc.store.putSecret({ connection_id: id, ...h.svc.secretBox.encrypt(id, { keyId: pair.keyId, secretKey: pair.secret, host: "live" }) });
  later();
  const r = await req("/v1/portfolio");
  assert.match(errorOf(r.json, id)?.message ?? "", /^The Alpaca key of this connection was just replaced/);
  assert.equal(row(id)?.status, "active");
  h.advance(11 * 60_000);
  assert.equal(errorOf((await req("/v1/portfolio")).json, id), undefined, "the next read uses the new key");
});

test("another workspace's connection id is a 404 everywhere", async () => {
  const token = h.token({ wid: randomUUID() });
  assert.equal((await req(`/v1/connections/${liveId}`, { token })).status, 404);
  assert.equal((await req(`/v1/connections/${liveId}/renew`, { method: "POST", token })).status, 404);
  assert.equal((await req(`/v1/connections/${liveId}`, { method: "DELETE", token })).status, 404);
  const rekey = await req("/v1/keys/connect", { method: "POST", token, body: { brokerId: "alpaca", keyId: live.keyId, secret: live.secret, connectionId: liveId } });
  assert.equal(rekey.status, 404);
  assert.equal(row(liveId)?.status, "active");
});

test("disconnect deletes the stored key and the accounts; Alpaca is not called", async () => {
  assert.ok(h.rows("broker_secrets").some((s) => s.connection_id === paperId));
  const calls = fake.state.calls.length;
  const r = await req(`/v1/connections/${paperId}`, { method: "DELETE" });
  assert.equal(r.status, 200, r.text);
  assert.equal(row(paperId)?.status, "disconnected");
  assert.equal(h.rows("broker_secrets").some((s) => s.connection_id === paperId), false);
  assert.equal(h.rows("broker_accounts").some((a) => a.connection_id === paperId), false);
  assert.equal(fake.state.calls.length, calls, "Alpaca has no key revoke: nothing is sent");
});

test("read-only: every write is refused before the network; the allowlist holds the read endpoints only", async () => {
  for (const path of ["/v2/account", "/v2/positions", "/v2/orders", "/v2/account/activities", "/v2/account/activities/FILL", "/v2/account/portfolio/history"]) {
    assert.equal(isAllowed(ALPACA_READ_ALLOW, "GET", path), true, path);
  }
  const client = createAlpacaClient({ http: (o) => createBrokerHttp(o), base: fake.urls.live, keyId: live.keyId, secretKey: live.secret, bucketKey: "alpaca:test" });
  const calls = fake.state.calls.length;
  for (const [method, path] of [
    ["POST", "/v2/orders"],
    ["PATCH", "/v2/orders/ord-0001"],
    ["DELETE", "/v2/orders/ord-0001"],
    ["DELETE", "/v2/orders"],
    ["DELETE", "/v2/positions/AAPL"],
    ["DELETE", "/v2/positions"],
    ["POST", "/v2/positions/AAPL/exercise"],
    ["POST", "/v2/watchlists"],
    ["PATCH", "/v2/account/configurations"],
    ["POST", "/v2/account"],
    ["GET", "/v2/account/configurations"],
    ["GET", "/v2/orders/ord-0001"],
    ["GET", "/v2/account/../orders"],
    ["GET", "/v2/account%2f..%2forders"],
    ["GET", "//v2/account"],
    ["GET", "/v2/account?x=1"],
    ["GET", "/v1/account"],
  ]) {
    assert.equal(isAllowed(ALPACA_READ_ALLOW, method, path), false, `${method} ${path}`);
    await assert.rejects(client.http.request(method, path), ReadOnlyViolation, `${method} ${path}`);
  }
  assert.equal(fake.state.calls.length, calls, "nothing reached Alpaca");
  assert.equal(typeof (await client.account()).id, "string", "the same client reads");
});

test("production calls Alpaca's own hosts whatever the overrides say", () => {
  const fakes = { live: "http://127.0.0.1:9", paper: "http://127.0.0.1:10" };
  assert.deepEqual(alpacaHosts(fakes, true), { live: "https://api.alpaca.markets", paper: "https://paper-api.alpaca.markets" });
  assert.deepEqual(alpacaHosts(fakes, false), fakes);
  assert.deepEqual(alpacaHosts({}, false), { ...ALPACA_HOSTS });
});

test("BROKER_AUDIENCE gates the Alpaca key method", async () => {
  const env = { BROKER_URL_OVERRIDES: JSON.stringify({ alpaca: fake.urls }) };
  const owner = await createHarness({ env: { ...env, BROKER_AUDIENCE: "alpaca_key=superadmin" }, adapters: [["alpaca", createAdapter]] });
  const off = await createHarness({ env: { ...env, BROKER_AUDIENCE: "alpaca_key=off" }, adapters: [["alpaca", createAdapter]] });
  try {
    const a = add({ host: "live" });
    const body = { brokerId: "alpaca", keyId: a.keyId, secret: a.secret };
    const trader = await owner.req("/v1/keys/connect", { method: "POST", body });
    assert.equal(trader.status, 403);
    assert.equal(trader.json.code, "owner_only");
    const admin = await owner.req("/v1/keys/connect", { method: "POST", body, token: owner.token({ role: "superadmin" }) });
    assert.equal(admin.status, 200, admin.text);
    const nobody = await off.req("/v1/keys/connect", { method: "POST", body, token: off.token({ role: "superadmin" }) });
    assert.equal(nobody.status, 403);
    assert.equal(nobody.json.code, "off");
    replies.push(trader.text, admin.text, nobody.text);
    for (const g of [owner, off]) replies.push(g.logLines.join("\n"));
  } finally {
    await owner.close();
    await off.close();
  }
});

test("no key or secret in any table, log line or reply; Alpaca never got a request other than GET", () => {
  const tables = JSON.stringify([...h.db.tables.entries()]);
  const logs = h.logLines.join("\n");
  assert.ok(issued.length >= 16);
  for (const s of issued) {
    assert.ok(!tables.includes(s), "a key or secret is stored in plain text");
    assert.ok(!logs.includes(s), "a key or secret reached the log");
    assert.ok(!replies.some((r) => r.includes(s)), "a key or secret was sent back");
  }
  assert.ok(h.logLines.some((l) => l.includes("alpaca key refused")), "the log names the event, not the key");
  assert.equal(fake.state.nonGet, 0);
});
