import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { HttpError } from "../src/errors.mjs";
import { messageTextHash, newClientOrderId } from "../src/order-contract.mjs";
import { accountKey, checkNotional } from "../src/orders.mjs";
import { etToUtc } from "../src/time.mjs";
import { sleep } from "./helpers/common.mjs";
import { createHarness, fakeTradingAdapter, fakeTradingState, seedTradingAccount } from "./helpers/harness.mjs";

/**
 * The order core (src/orders.mjs) through the HTTP API, with the fake trading part of
 * test/helpers/harness.mjs and rows written straight into the memory database. No broker is called.
 */

/** @typedef {Awaited<ReturnType<typeof createHarness>>} Harness */

/**
 * @param {{ state?: Record<string, unknown>, env?: Record<string, string>, seed?: Parameters<typeof seedTradingAccount>[1] }} [o]
 */
async function setup(o = {}) {
  const state = fakeTradingState(o.state ?? {});
  const h = await createHarness({ env: o.env ?? {}, adapters: [["alpaca", fakeTradingAdapter({ state })]] });
  const seed = await seedTradingAccount(h, o.seed ?? {});
  return { h, state, ...seed };
}

/** @param {string} accountId @param {Record<string, unknown>} [over] */
const ticket = (accountId, over = {}) => ({ accountId, symbol: "AAPL", side: "BUY", quantity: 10, type: "LMT", limitPrice: 100.5, tif: "DAY", intent: "trade", ...over });

/** @param {Harness} h @param {unknown} body @param {string} [token] */
const preview = (h, body, token) => h.req("/v1/orders/preview", { method: "POST", body, token });
/** @param {Harness} h @param {unknown} body @param {string} [token] */
const place = (h, body, token) => h.req("/v1/orders/place", { method: "POST", body, token });
/** @param {Harness} h @param {string} id @param {string} [token] */
const status = (h, id, token) => h.req(`/v1/orders/requests/${id}`, { token });

/** A new member of the harness workspace. @param {Harness} h @param {string} [role] */
function addMember(h, role = "trader") {
  const id = randomUUID();
  h.rows("members").push({ user_id: id, email: `${id.slice(0, 6)}@example.com`, role, workspace_id: h.wid });
  return { id, token: () => h.token({ sub: id, role }) };
}

/** @param {Harness} h */
const ws = (h) => /** @type {Record<string, any>} */ (h.rows("workspaces").find((w) => w.id === h.wid));
/** @param {Harness} h @param {string} id */
const rowOf = (h, id) => /** @type {Record<string, any>} */ (h.rows("order_requests").find((r) => r.id === id));
/** @param {Harness} h @param {string} action */
const audits = (h, action) => /** @type {Array<Record<string, any>>} */ (h.rows("audit_events").filter((r) => r.action === action));

/** Previews a ticket and answers the request view (asserting 200). @param {Harness} h @param {Record<string, unknown>} body @param {string} [token] */
async function previewOk(h, body, token) {
  const r = await preview(h, body, token);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.request;
}

/**
 * A row written straight into the database.
 * @param {Harness} h
 * @param {{ connectionId: string, accountId: string }} seed
 * @param {Record<string, unknown>} [over]
 */
async function insertRow(h, seed, over = {}) {
  const account = /** @type {any} */ (h.rows("broker_accounts").find((a) => a.id === seed.accountId));
  const [row] = await h.db.insert("order_requests", {
    workspace_id: h.wid,
    user_id: h.user,
    connection_id: seed.connectionId,
    account_id: seed.accountId,
    account_key: accountKey(account),
    broker_id: "alpaca",
    method: "alpaca_key",
    environment: "paper",
    account_display: "PA1•••00",
    client_order_id: newClientOrderId(),
    symbol: "AAPL",
    side: "BUY",
    quantity: 1,
    order_type: "LMT",
    tif: "DAY",
    request: { symbol: "AAPL", side: "BUY", quantity: 1, type: "LMT", limitPrice: 100, stopPrice: null, tif: "DAY", bracket: null, intent: "trade", positionId: null, expectedPositionQty: null },
    preview: { position: { qty: 0 }, estimate: { source: "Fake" }, warnings: [], notices: [] },
    expires_at: new Date(h.now() + 120_000).toISOString(),
    ...over,
  });
  return /** @type {Record<string, any>} */ (row);
}

/** @param {() => boolean} cond @param {number} [ms] */
async function until(cond, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}

// ─────────────────────────────────────────────────────────────── 1. capabilities

test("capabilities: off, on, suspended, paused, another member's login, blocked, read-only methods", async () => {
  const { h, state, connectionId } = await setup();
  try {
    delete ws(h).orders_enabled;
    let r = await h.req("/v1/orders/capabilities");
    assert.equal(r.status, 200);
    assert.deepEqual(
      { enabled: r.json.enabled, reason: r.json.reason, message: r.json.message, connections: r.json.connections, blocked: r.json.blocked },
      { enabled: false, reason: "off", message: "Order entry is not switched on for this workspace.", connections: {}, blocked: {} },
    );

    ws(h).orders_enabled = true;
    r = await h.req("/v1/orders/capabilities");
    assert.equal(r.json.enabled, true);
    assert.equal(r.json.reason, null);
    assert.deepEqual(r.json.limits, { maxQty: 10_000, maxNotional: 250_000 });
    assert.deepEqual(r.json.connections[connectionId], state.caps);

    ws(h).status = "suspended";
    r = await h.req("/v1/orders/capabilities");
    assert.equal(r.json.reason, "suspended");
    assert.equal(r.json.message, "This workspace is suspended, so it cannot place orders.");
    ws(h).status = "active";

    // Another member connected a second login; the workspace owner is someone else.
    const other = addMember(h);
    const owner = addMember(h);
    const second = await seedTradingAccount(h, { userId: other.id, ownerId: owner.id });
    r = await h.req("/v1/orders/capabilities");
    assert.equal(r.json.blocked[second.connectionId], "Only the person who connected this Alpaca login, or the workspace owner, can place orders on it.");
    assert.ok(r.json.connections[connectionId], "my own login stays tradable");
    r = await h.req("/v1/orders/capabilities", { token: owner.token() });
    assert.ok(r.json.connections[second.connectionId], "the owner trades every login");
    assert.ok(r.json.connections[connectionId]);

    // Read-only methods of the same brokers are in neither list (gated by method, not broker id).
    const [oauthAlpaca] = await h.db.insert("broker_connections", { workspace_id: h.wid, user_id: h.user, broker_id: "alpaca", method: "alpaca_oauth", environment: "paper", status: "active" });
    const [oauthIbkr] = await h.db.insert("broker_connections", { workspace_id: h.wid, user_id: h.user, broker_id: "ibkr", method: "ibkr_oauth", environment: "paper", status: "active" });
    r = await h.req("/v1/orders/capabilities", { token: owner.token() });
    for (const id of [oauthAlpaca.id, oauthIbkr.id]) {
      assert.equal(r.json.connections[id], undefined);
      assert.equal(r.json.blocked[id], undefined);
    }

    state.caps = { blocked: "Nasscord places orders only for logins with one account for now." };
    r = await h.req("/v1/orders/capabilities");
    assert.equal(r.json.blocked[connectionId], "Nasscord places orders only for logins with one account for now.");
    assert.equal(r.json.connections[connectionId], undefined);
  } finally {
    await h.close();
  }
});

test("capabilities: ORDER_ENTRY=off answers paused", async () => {
  const { h } = await setup({ env: { ORDER_ENTRY: "off" } });
  try {
    const r = await h.req("/v1/orders/capabilities");
    assert.equal(r.status, 200);
    assert.equal(r.json.enabled, false);
    assert.equal(r.json.reason, "paused");
    assert.equal(r.json.message, "Order entry is paused on this server. Your broker's own app still works.");
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 2. gate

test("gate: the switch, roles, members, the kill switch and the drain", async () => {
  const { h, state, accountId } = await setup();
  try {
    const req = await previewOk(h, ticket(accountId));
    ws(h).orders_enabled = false;
    let r = await preview(h, ticket(accountId));
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Order entry is not switched on for this workspace.", code: "order_entry_off" });
    r = await place(h, { requestId: req.id });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "order_entry_off");
    assert.equal(state.calls.preview, 1);
    assert.equal(state.calls.place, 0);
    ws(h).orders_enabled = true;

    r = await preview(h, ticket(accountId), h.token({ role: "tenant" }));
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Order entry belongs to a trading workspace.", code: "forbidden" });
    r = await preview(h, ticket(accountId), h.token({ wid: null }));
    assert.equal(r.json.code, "no_workspace");

    const elsewhere = randomUUID();
    h.rows("members").push({ user_id: elsewhere, email: "x@example.com", role: "trader", workspace_id: randomUUID() });
    r = await preview(h, ticket(accountId), h.token({ sub: elsewhere }));
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not_member");
    r = await preview(h, ticket(accountId), h.token({ role: "tenant_user" }));
    assert.equal(r.json.code, "not_member", "the JWT role must match the members row");

    ws(h).status = "suspended";
    r = await preview(h, ticket(accountId));
    assert.equal(r.json.code, "workspace_suspended");
    ws(h).status = "trial";
    r = await preview(h, ticket(accountId));
    assert.equal(r.status, 200, "trial workspaces can trade");
    ws(h).status = "active";

    // A missing column (42703) reads as off.
    const real = h.db.select;
    h.db.select = async (name, o) => {
      if (name === "workspaces") throw Object.assign(new Error("column orders_enabled does not exist"), { code: "42703" });
      return real(name, o);
    };
    r = await preview(h, ticket(accountId));
    assert.equal(r.json.code, "order_entry_off");
    h.db.select = real;

    // Drain: previews and places refused, reads still answer.
    const fresh = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    await h.svc.orders.drain(0);
    r = await preview(h, ticket(accountId));
    assert.equal(r.status, 503);
    assert.equal(r.json.code, "shutting_down");
    assert.equal(r.json.error, "The broker service is restarting. Nothing was placed. Try again in a minute.");
    r = await place(h, { requestId: fresh.id });
    assert.equal(r.status, 503);
    assert.equal((await h.req("/v1/orders/requests")).status, 200);
    assert.equal((await status(h, fresh.id)).status, 200);
    assert.equal((await h.req("/v1/orders/capabilities")).json.enabled, true, "capabilities still answer while stopping");
    assert.equal(state.calls.place, 0);
  } finally {
    await h.close();
  }
});

test("gate: the kill switch refuses previews and places, cancels still work", async () => {
  const { h, state, accountId } = await setup({ env: { ORDER_ENTRY: "off" } });
  try {
    let r = await preview(h, ticket(accountId));
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Order entry is paused on this server. Your broker's own app still works.", code: "order_entry_paused" });
    const row = await insertRow(h, { connectionId: "", accountId }, { connection_id: null });
    r = await place(h, { requestId: row.id });
    assert.equal(r.json.code, "order_entry_paused");
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `alpaca:${accountId}:abc` } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "cancel_requested");
    assert.equal(state.calls.preview + state.calls.place, 0);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 3. resolve

test("resolve: foreign, excluded, expired, sandbox, read-only methods, another member's login", async () => {
  const { h, state, accountId, connectionId } = await setup();
  try {
    // Another workspace's account looks absent.
    const [foreignConn] = await h.db.insert("broker_connections", { workspace_id: randomUUID(), user_id: h.user, broker_id: "alpaca", method: "alpaca_key", environment: "paper", status: "active" });
    const [foreign] = await h.db.insert("broker_accounts", { connection_id: foreignConn.id, workspace_id: foreignConn.workspace_id, broker_id: "alpaca", external_id: "PA999", display_number: "•••99", label: "x", type: "paper" });
    let r = await preview(h, ticket(foreign.id));
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: "That account is not in your workspace.", code: "not_found" });
    r = await preview(h, ticket("not-a-uuid"));
    assert.equal(r.status, 404);

    const acct = /** @type {Record<string, any>} */ (h.rows("broker_accounts").find((a) => a.id === accountId));
    acct.included = false;
    r = await preview(h, ticket(accountId));
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "account_excluded");
    acct.included = true;

    const conn = /** @type {Record<string, any>} */ (h.rows("broker_connections").find((c) => c.id === connectionId));
    conn.status = "expired";
    r = await preview(h, ticket(accountId));
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "Alpaca is not connected right now. Reconnect it in Brokers, then try again.", code: "connection_not_live" });
    conn.status = "active";

    const sandbox = await seedTradingAccount(h, { method: "etrade_oauth1", environment: "sandbox", externalId: "sandboxKey1" });
    r = await preview(h, ticket(sandbox.accountId));
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: "Orders never go to a sandbox connection.", code: "sandbox_refused" });

    for (const [method, environment, name] of /** @type {const} */ ([
      ["schwab_oauth", "production", "Schwab"],
      ["alpaca_oauth", "paper", "Alpaca"],
      ["ibkr_oauth", "paper", "IBKR"],
    ])) {
      const s = await seedTradingAccount(h, { method, environment });
      r = await preview(h, ticket(s.accountId));
      assert.equal(r.status, 403, method);
      assert.deepEqual(r.json, { error: `Nasscord does not place orders at ${name}. Use ${name}'s own app.`, code: "broker_read_only" });
      const row = await insertRow(h, s);
      r = await place(h, { requestId: row.id });
      assert.equal(r.json.code, "broker_read_only", method);
      assert.equal(rowOf(h, row.id).status, "preview");
      r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId: s.accountId, orderId: `${method.split("_")[0]}:${s.accountId}:1` } });
      assert.equal(r.json.code, "broker_read_only", method);
    }

    // Another member's login: refused on preview, place and cancel; the owner passes.
    const other = addMember(h);
    const theirs = await seedTradingAccount(h, { userId: other.id });
    const sentence = "Only the person who connected this Alpaca login, or the workspace owner, can place or cancel orders on it.";
    ws(h).owner_id = randomUUID();
    r = await preview(h, ticket(theirs.accountId));
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: sentence, code: "not_your_connection" });
    const theirRow = await insertRow(h, theirs);
    r = await place(h, { requestId: theirRow.id });
    assert.equal(r.json.code, "not_your_connection");
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId: theirs.accountId, orderId: `alpaca:${theirs.accountId}:1` } });
    assert.equal(r.json.code, "not_your_connection");
    ws(h).owner_id = h.user;
    r = await preview(h, ticket(theirs.accountId));
    assert.equal(r.status, 200, "the workspace owner trades every login");
    assert.equal(state.calls.place, 0);
    assert.equal(state.calls.cancel, 0);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 4. ticket

test("ticket validation: each refusal with its sentence", async () => {
  const { h, state, accountId } = await setup();
  try {
    const priceRule = "Use a price above 0 with at most 2 decimals (4 below $1).";
    const geometry = "For a buy bracket, the stop-loss goes below the entry and the take-profit above it.";
    const bracket = { takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 95 } };
    /** @type {Array<[Record<string, unknown>, string]>} */
    const cases = [
      [{ side: "buy" }, "Pick Buy or Sell."],
      [{ quantity: 0 }, "Enter whole shares, from 1 to 10,000."],
      [{ quantity: 1.5 }, "Enter whole shares, from 1 to 10,000."],
      [{ quantity: 10_001 }, "Enter whole shares, from 1 to 10,000."],
      [{ quantity: "10" }, "Enter whole shares, from 1 to 10,000."],
      [{ symbol: "AAPL!" }, "Enter a US stock or ETF symbol."],
      [{ symbol: "" }, "Enter a US stock or ETF symbol."],
      [{ limitPrice: undefined }, "Enter a limit price."],
      [{ type: "MKT", limitPrice: 100 }, "A Market order has no limit price."],
      [{ limitPrice: 185.555 }, priceRule],
      [{ limitPrice: 0.12345 }, priceRule],
      [{ limitPrice: -1 }, priceRule],
      [{ type: "STP", limitPrice: undefined }, "Enter a stop price."],
      [{ tif: "IOC" }, "Pick Day or Good till cancelled."],
      [{ type: "LMT", bracket, side: "SELL", tif: "GTC" }, "Brackets are for buy orders: Nasscord does not open short positions."],
      [{ bracket, tif: "DAY" }, "A bracket is sent as Good till cancelled, so its stop-loss and take-profit stay after today's close. Pick Good till cancelled."],
      [{ bracket: { takeProfit: { limitPrice: 100.5 }, stopLoss: { stopPrice: 95 } }, tif: "GTC" }, geometry],
      [{ bracket: { takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 100.5 } }, tif: "GTC" }, geometry],
      [{ bracket: { takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 95, limitPrice: 96 } }, tif: "GTC" }, "The stop-loss limit goes at or below its stop price."],
      [{ positionId: `alpaca:${randomUUID()}:AAPL` }, "That position is not in this account."],
      [{ positionId: `ibkr:${accountId}:265598` }, "That position is not in this account."],
      [{ intent: "close" }, "Open Close from the Positions page."],
      [{ expectedPositionQty: 5 }, "Only a Close carries the position quantity."],
    ];
    for (const [over, sentence] of cases) {
      const body = ticket(accountId, over);
      for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[/** @type {keyof typeof body} */ (k)];
      const r = await preview(h, body);
      assert.equal(r.status, 400, JSON.stringify(over));
      assert.deepEqual(r.json, { error: sentence, code: "bad_ticket" }, JSON.stringify(over));
    }

    /** @type {any} */ (state.caps).marketGtc = false;
    let r = await preview(h, ticket(accountId, { type: "MKT", limitPrice: undefined, tif: "GTC" }));
    assert.deepEqual(r.json, { error: "Alpaca takes Market orders as Day orders only.", code: "bad_ticket" });
    /** @type {any} */ (state.caps).bracket = null;
    r = await preview(h, ticket(accountId, { bracket, tif: "GTC" }));
    assert.deepEqual(r.json, { error: "Alpaca does not take bracket orders from Nasscord for this account.", code: "bad_ticket" });
    /** @type {any} */ (state.caps).types = ["MKT", "LMT"];
    r = await preview(h, ticket(accountId, { type: "STP", limitPrice: undefined, stopPrice: 120 }));
    assert.deepEqual(r.json, { error: "Alpaca does not take Stop orders from Nasscord for this account.", code: "bad_ticket" });
    assert.equal(state.calls.preview, 0, "no refused ticket reaches the broker");

    const ok = await previewOk(h, ticket(accountId, { symbol: "brk b", limitPrice: 100.5 }));
    assert.equal(ok.ticket.symbol, "BRK.B");
    assert.equal(rowOf(h, ok.id).symbol, "BRK.B");
    assert.deepEqual(ok.ticket, { accountId, symbol: "BRK.B", side: "BUY", quantity: 10, type: "LMT", limitPrice: 100.5, tif: "DAY", intent: "trade" });
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 5. position rules

test("position rules: no short, working orders, close", async () => {
  const { h, state, accountId } = await setup();
  try {
    /** @param {Record<string, unknown>} ps */
    const hold = (ps) => (state.position.AAPL = /** @type {any} */ ({ qty: 0, workingSell: 0, workingBuy: 0, working: true, ...ps }));
    /** @param {Record<string, unknown>} over @param {number} code @param {string} c @param {string} sentence */
    const refuse = async (over, code, c, sentence) => {
      const r = await preview(h, ticket(accountId, over));
      assert.equal(r.status, code, JSON.stringify(over));
      assert.deepEqual(r.json, { error: sentence, code: c });
    };
    const sell = { side: "SELL", limitPrice: 100.5 };
    hold({ qty: 0 });
    await refuse(sell, 400, "no_short", "You hold no AAPL in this account. Nasscord does not sell short.");
    hold({ qty: 5 });
    await refuse(sell, 400, "no_short", "You hold 5 AAPL in this account. Nasscord sells at most what you hold and does not sell short.");
    hold({ qty: 100, workingSell: 100 });
    await refuse(
      { ...sell, quantity: 100 },
      400,
      "no_short",
      "You hold 100 AAPL in this account and working sell orders already cover 100. Nasscord sells at most the 0 shares they do not cover, and does not sell short.",
    );
    hold({ qty: 100, workingSell: 0, working: false });
    await refuse(sell, 409, "working_orders_unreadable", "Alpaca did not list your working orders, so Nasscord cannot check them against this order. Try again in a few seconds.");

    const close = { side: "SELL", quantity: 100, intent: "close", positionId: `alpaca:${accountId}:AAPL`, expectedPositionQty: 100 };
    hold({ qty: 100, workingSell: 30 });
    await refuse(close, 409, "working_sells", "You have working sell orders for 30 AAPL shares in this account. Cancel them first: after this order they would sell short.");
    hold({ qty: -50, workingBuy: 10 });
    await refuse(
      { side: "BUY", quantity: 50, intent: "close", positionId: `alpaca:${accountId}:AAPL`, expectedPositionQty: -50 },
      409,
      "working_buys",
      "You have working buy orders for 10 AAPL shares in this account. Cancel them first: after this order they would buy past zero.",
    );
    await refuse(
      { side: "BUY", quantity: 45 },
      400,
      "no_short",
      "This account is short 50 AAPL, and working buy orders already cover 10. Buy at most 40 shares to cover; buying past zero in one order is not available.",
    );
    hold({ qty: 80 });
    await refuse(close, 409, "position_changed", "Your AAPL position changed from 100 to 80 shares. Review the order and confirm again.");
    hold({ qty: 12.5 });
    await refuse({ ...close, quantity: 12, expectedPositionQty: 12.5 }, 409, "fractional_position", "This position holds a fractional share count (12.5). Nasscord sends whole shares only: close it in Alpaca.");
    hold({ qty: 0 });
    await refuse(close, 409, "no_position", "You no longer hold AAPL in this account.");

    // Allowed: a sell inside the free shares, a close of the whole position, a cover.
    hold({ qty: 100, workingSell: 40 });
    await previewOk(h, ticket(accountId, { ...sell, quantity: 60 }));
    hold({ qty: 100 });
    const closing = await previewOk(h, ticket(accountId, close));
    assert.deepEqual(closing.preview.position, { before: 100, after: 0 });

    // At place time each refusal is a rejected row, "Nothing was placed.", and no send.
    hold({ qty: 100, workingSell: 20 });
    let r = await place(h, { requestId: closing.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.request.status, "rejected");
    assert.equal(
      r.json.request.error,
      "You have working sell orders for 20 AAPL shares in this account. Cancel them first: after this order they would sell short. Nothing was placed.",
    );
    hold({ qty: 100 });
    const sale = await previewOk(h, ticket(accountId, { ...sell, symbol: "AAPL", quantity: 50 }));
    hold({ qty: 100, working: false });
    r = await place(h, { requestId: sale.id });
    assert.equal(r.json.request.status, "rejected");
    assert.equal(
      r.json.request.error,
      "Alpaca did not list your working orders, so Nasscord cannot check them against this order. Nothing was placed. Try again in a few seconds.",
    );
    hold({ qty: 100 });
    const sale2 = await previewOk(h, ticket(accountId, { ...sell, symbol: "AAPL", quantity: 50, limitPrice: 100.75 }));
    hold({ qty: 20 });
    r = await place(h, { requestId: sale2.id });
    assert.equal(r.json.request.status, "rejected");
    assert.equal(r.json.request.error, "You hold 20 AAPL in this account. Nasscord sells at most what you hold and does not sell short. Nothing was placed.");
    state.positionError = new Error("boom");
    hold({ qty: 100 });
    state.positionError = null;
    const sale3 = await previewOk(h, ticket(accountId, { ...sell, quantity: 1, limitPrice: 100.8 }));
    state.positionError = new Error("socket closed");
    r = await place(h, { requestId: sale3.id });
    assert.equal(r.json.request.status, "rejected");
    assert.equal(r.json.request.error, "Nasscord could not read your AAPL position at Alpaca. Nothing was placed.");
    assert.equal(state.sent.length, 0);
    assert.equal(state.calls.place, 0);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 6. prices and session

test("reference price, stop side, cap, band and the market session", async () => {
  const { h, state, accountId } = await setup();
  try {
    /** @param {Record<string, unknown>} over */
    const pv = (over) => preview(h, ticket(accountId, over));
    const bracket = { takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 95 } };
    state.referencePrice = null;
    for (const [over, what] of /** @type {Array<[Record<string, unknown>, string]>} */ ([
      [{ type: "MKT", limitPrice: undefined }, "Market"],
      [{ type: "STP", limitPrice: undefined, stopPrice: 101 }, "Stop"],
      [{ type: "STP_LMT", limitPrice: 102, stopPrice: 101 }, "Stop limit"],
      [{ bracket, tif: "GTC" }, "bracket"],
    ])) {
      const body = /** @type {Record<string, unknown>} */ (ticket(accountId, over));
      if ("limitPrice" in over && over.limitPrice === undefined) delete body.limitPrice;
      const r = await preview(h, body);
      assert.equal(r.status, 409, what);
      assert.deepEqual(r.json, {
        error: `Alpaca did not give Nasscord a market price for AAPL, so this ${what} order cannot be checked against your limits. Use a Limit order, or place it in Alpaca.`,
        code: "no_reference_price",
      });
    }
    let req = await previewOk(h, ticket(accountId));
    assert.ok(req.preview.warnings.some((/** @type {any} */ w) => w.code === "no_reference"));

    state.referencePrice = 100;
    let r = await pv({ type: "STP", limitPrice: undefined, stopPrice: 100 });
    assert.deepEqual(r.json, {
      error: "A buy stop at $100.00 is already at or below the market price $100.00, so it would trigger at once. Check the stop price.",
      code: "stop_wrong_side",
    });
    state.position.AAPL = { qty: 100, workingSell: 0, workingBuy: 0, working: true };
    r = await pv({ side: "SELL", type: "STP", limitPrice: undefined, stopPrice: 100.5 });
    assert.equal(r.json.code, "stop_wrong_side");
    assert.match(r.json.error, /^A sell stop at \$100\.50 is already at or above the market price \$100\.00/);
    r = await pv({ bracket: { takeProfit: { limitPrice: 110 }, stopLoss: { stopPrice: 100 } }, limitPrice: 105, tif: "GTC" });
    assert.deepEqual(r.json, { error: "The stop-loss at $100.00 is at or above the market price $100.00, so it would sell as soon as the entry fills.", code: "stop_wrong_side" });
    req = await previewOk(h, ticket(accountId, { bracket: { takeProfit: { limitPrice: 99.5 }, stopLoss: { stopPrice: 95 } }, limitPrice: 99, tif: "GTC" }));
    assert.ok(req.preview.warnings.some((/** @type {any} */ w) => w.code === "take_profit_below_market"));
    r = await pv({ type: "MKT", limitPrice: undefined, bracket: { takeProfit: { limitPrice: 100.005 }, stopLoss: { stopPrice: 95 } }, tif: "GTC" });
    assert.equal(r.status, 400);

    r = await pv({ quantity: 2_600, limitPrice: 100 });
    assert.deepEqual(r.json, { error: "This order is worth about $260,000, above the $250,000 Nasscord allows per order.", code: "notional_cap" });
    r = await pv({ limitPrice: 131 });
    assert.deepEqual(r.json, { error: "Limit price $131.00 is 31.0% away from the reference price $100.00. Check the price.", code: "price_band" });
    req = await previewOk(h, ticket(accountId, { limitPrice: 106 }));
    const far = req.preview.warnings.find((/** @type {any} */ w) => w.code === "far_from_market");
    assert.equal(far.text, "Limit price $106.00 is 6.0% away from the reference price $100.00.");
    req = await previewOk(h, ticket(accountId, { type: "STP_LMT", limitPrice: 101, stopPrice: 102 }));
    assert.ok(req.preview.warnings.some((/** @type {any} */ w) => w.code === "stop_limit_inverted"));

    // Session: the NYSE calendar when the broker gives no clock.
    state.marketOpen = undefined;
    /** @param {string} day @param {number} hh @param {number} mm */
    const at = (day, hh, mm) => {
      const [y, m, d] = day.split("-").map(Number);
      h.setTime(etToUtc(y, m, d, hh, mm));
    };
    /** @param {string} label @param {boolean} closed */
    const expect = async (label, closed) => {
      const mkt = await previewOk(h, ticket(accountId, { type: "MKT", limitPrice: undefined, quantity: 1 }));
      const lmt = await previewOk(h, ticket(accountId, { quantity: 1, limitPrice: 100.25 }));
      const codes = (/** @type {any} */ x) => x.preview.warnings.map((/** @type {any} */ w) => w.code);
      assert.equal(codes(mkt).includes("market_closed_market"), closed, label);
      assert.equal(codes(lmt).includes("market_closed"), closed, label);
      assert.equal(mkt.preview.marketOpen, !closed, label);
      if (closed) {
        const w = mkt.preview.warnings.find((/** @type {any} */ x) => x.code === "market_closed_market");
        assert.equal(w.text, "The market is closed. This Market order waits for the next session and fills at the opening price, which can be far from $100.00.");
      }
    };
    at("2026-11-21", 12, 0);
    await expect("Saturday noon", true);
    at("2026-11-23", 8, 0);
    await expect("08:00 on a weekday", true);
    at("2026-11-26", 12, 0);
    await expect("Thanksgiving", true);
    at("2026-11-27", 13, 30);
    await expect("after the early close", true);
    at("2026-11-27", 12, 30);
    await expect("before the early close", false);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 7, 8. happy path and double submit

test("happy path: one preview row, one send, an audited place, an idempotent replay", async () => {
  const { h, state, accountId, connectionId, externalId } = await setup();
  try {
    const req = await previewOk(h, ticket(accountId));
    assert.equal(req.status, "preview");
    assert.match(req.clientOrderId, /^nc[0-9a-f]{18}$/);
    assert.equal(req.accountId, accountId);
    assert.equal(req.connectionId, connectionId);
    assert.equal(req.environment, "paper");
    assert.equal(req.preview.instrument.name, "Fake Instrument Inc");
    assert.deepEqual(req.preview.position, { before: 0, after: 10 });
    assert.equal(req.brokerMessages.length, 0);
    assert.equal(req.autoChecking, false);
    // expires_at is computed just before the insert stamps created_at, so a millisecond may pass between them.
    const ttl = Date.parse(req.expiresAt) - Date.parse(req.createdAt);
    assert.ok(ttl > 119_900 && ttl <= 120_000, String(ttl));
    assert.equal(rowOf(h, req.id).status, "preview");
    assert.equal(h.rows("order_requests").length, 1);
    assert.equal(rowOf(h, req.id).broker_state.fake, true);
    assert.equal(req.broker_state, undefined, "broker_state is never sent");
    await sleep(30);
    assert.equal(audits(h, "broker.order.preview").length, 0, "a successful preview writes no audit row");

    const r = await place(h, { requestId: req.id, acknowledged: [] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.request.status, "placed");
    assert.equal(r.json.request.brokerOrderId, "fake-1");
    assert.ok(r.json.request.placedAt);
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0].clientOrderId, req.clientOrderId);
    assert.equal(state.sent[0].ticket.symbol, "AAPL");
    await sleep(30);
    const [a] = audits(h, "broker.order.place");
    assert.equal(a.result, "ok");
    assert.match(a.target, /^Alpaca Paper PA[0-9]•••[0-9]{2} · BUY 10 AAPL$/);
    assert.ok(!a.target.includes(externalId));
    assert.deepEqual(a.meta, { requestId: req.id, clientOrderId: req.clientOrderId, attempt: 1, outcome: "placed", brokerOrderId: "fake-1" });

    const again = await place(h, { requestId: req.id });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.request, r.json.request);
    assert.equal(state.sent.length, 1);
    await sleep(20);
    assert.equal(audits(h, "broker.order.place").length, 1, "a replay is not audited");

    // Only the request id travels: order fields in the place body are ignored.
    const other = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    await place(h, { requestId: other.id, quantity: 9_999, symbol: "TSLA", side: "SELL" });
    assert.deepEqual([state.sent[1].ticket.symbol, state.sent[1].ticket.quantity, state.sent[1].ticket.side], ["MSFT", 10, "BUY"]);
  } finally {
    await h.close();
  }
});

test("double submit: two concurrent places of one request send once", async () => {
  const { h, state, accountId } = await setup({ state: { slowPlaceMs: 200 } });
  try {
    const req = await previewOk(h, ticket(accountId));
    const [a, b] = await Promise.all([place(h, { requestId: req.id }), place(h, { requestId: req.id })]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(a.json.request.id, req.id);
    assert.equal(b.json.request.id, req.id);
    assert.equal(state.sent.length, 1);
    assert.equal(rowOf(h, req.id).attempts, 1);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 9, 10. expiry and lock wait

test("expiry, another user's preview and a missing notice", async () => {
  const { h, state, accountId } = await setup({ state: { notices: [{ key: "fake.notice", text: "Read this." }] } });
  try {
    const req = await previewOk(h, ticket(accountId));
    let r = await place(h, { requestId: req.id });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "Confirm the order from the dialog that shows its notices.", code: "notices_not_acknowledged" });

    const other = addMember(h);
    r = await place(h, { requestId: req.id, acknowledged: ["fake.notice"] }, other.token());
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Only the person who previewed this order can place it.", code: "not_your_preview" });

    h.advance(121_000);
    r = await place(h, { requestId: req.id, acknowledged: ["fake.notice"] });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "This preview is more than 2 minutes old. Preview the order again.", code: "preview_expired" });
    assert.equal((await status(h, req.id)).json.request.status, "expired");
    assert.equal(rowOf(h, req.id).status, "preview", "expired is computed, never stored");
    assert.equal(state.sent.length, 0);
  } finally {
    await h.close();
  }
});

test("a place that waited for the lock past the preview's expiry sends nothing", async () => {
  const { h, state, accountId } = await setup({ state: { slowPlaceMs: 1_000 } });
  try {
    const first = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    const second = await previewOk(h, ticket(accountId));
    const a = place(h, { requestId: first.id });
    await until(() => state.calls.place === 1);
    const b = place(h, { requestId: second.id });
    await sleep(300);
    h.advance(121_000);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.json.request.status, "placed");
    assert.equal(rb.status, 409);
    assert.equal(rb.json.code, "preview_expired");
    assert.equal(state.sent.length, 1);
    assert.equal(rowOf(h, second.id).status, "preview");
  } finally {
    await h.close();
  }
});

test("lock wait: a place that cannot get the lock answers busy, sends nothing, and can be pressed again", { timeout: 60_000 }, async () => {
  const { h, state, accountId, connectionId } = await setup();
  try {
    const req = await previewOk(h, ticket(accountId));
    const held = h.svc.locks.run(`order:${connectionId}`, () => sleep(10_400));
    const r = await place(h, { requestId: req.id });
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { error: "Another order on this connection is still being sent. Nothing was placed. Try again in a moment.", code: "busy" });
    assert.equal(rowOf(h, req.id).status, "preview");
    assert.equal(state.sent.length, 0);
    await held;
    const again = await place(h, { requestId: req.id });
    assert.equal(again.json.request.status, "placed");
    assert.equal(state.sent.length, 1);
  } finally {
    await h.close();
  }
});

test("lock wait: order entry turned off or the workspace suspended while a place or preview waits for the lock stops it", { timeout: 60_000 }, async () => {
  const { h, state, accountId, connectionId } = await setup();
  try {
    // Off while a place is queued behind the lock: refused before the claim, nothing sent.
    const req = await previewOk(h, ticket(accountId));
    let held = h.svc.locks.run(`order:${connectionId}`, () => sleep(600));
    let pending = place(h, { requestId: req.id });
    await sleep(150);
    ws(h).orders_enabled = false;
    let r = await pending;
    await held;
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Order entry is not switched on for this workspace.", code: "order_entry_off" });
    assert.equal(rowOf(h, req.id).status, "preview", "the row is never claimed");
    assert.equal(rowOf(h, req.id).attempts, 0);
    assert.equal(state.sent.length, 0);
    assert.equal(state.calls.positionState, 0);

    // Suspended while queued: the same.
    ws(h).orders_enabled = true;
    const req2 = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    held = h.svc.locks.run(`order:${connectionId}`, () => sleep(600));
    pending = place(h, { requestId: req2.id });
    await sleep(150);
    ws(h).status = "suspended";
    r = await pending;
    await held;
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "workspace_suspended");
    assert.equal(rowOf(h, req2.id).status, "preview");
    assert.equal(state.sent.length, 0);

    // A preview queued behind the lock calls no broker once the switch is off.
    ws(h).status = "active";
    const previews = state.calls.preview;
    held = h.svc.locks.run(`order:${connectionId}`, () => sleep(600));
    const pv = preview(h, ticket(accountId, { symbol: "NVDA" }));
    await sleep(150);
    ws(h).orders_enabled = false;
    r = await pv;
    await held;
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "order_entry_off");
    assert.equal(state.calls.preview, previews);

    // Back on: the first preview still places (it was never claimed).
    ws(h).orders_enabled = true;
    const again = await place(h, { requestId: req.id });
    assert.equal(again.json.request.status, "placed");
    assert.equal(state.sent.length, 1);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 11. similar since preview

test("similar_since_preview: a second ticket for the same account, symbol and side is not sent", async () => {
  const { h, state, accountId, externalId } = await setup();
  try {
    const a = await previewOk(h, ticket(accountId));
    const b = await previewOk(h, ticket(accountId, { limitPrice: 100.25 }));
    assert.equal((await place(h, { requestId: a.id })).json.request.status, "placed");
    const r = await place(h, { requestId: b.id });
    assert.equal(r.status, 200);
    assert.equal(r.json.request.status, "rejected");
    assert.equal(r.json.request.error, "Another Buy order for AAPL went out from Nasscord after this preview. Nothing was placed. Preview again if you want a second one.");
    assert.equal(state.sent.length, 1);

    // The same broker account under another connection counts too.
    const twin = await seedTradingAccount(h, { externalId });
    const c = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    const d = await previewOk(h, ticket(twin.accountId, { symbol: "MSFT" }));
    assert.equal((await place(h, { requestId: c.id })).json.request.status, "placed");
    const rd = await place(h, { requestId: d.id });
    assert.equal(rd.json.request.status, "rejected");
    assert.match(rd.json.request.error, /^Another Buy order for MSFT went out from Nasscord after this preview/);
    assert.equal(state.sent.length, 2);

    // And a preview after a send warns.
    const e = await previewOk(h, ticket(twin.accountId, { symbol: "MSFT" }));
    const w = e.preview.warnings.find((/** @type {any} */ x) => x.code === "recent_similar");
    assert.equal(w.text, "You sent a Buy order for MSFT from Nasscord 1 min ago. Check Orders so you do not place it twice.");
  } finally {
    await h.close();
  }
});

test("similar_since_preview: the window starts at the preview's duplicate check, on the service clock, and leaves out what that check warned about", async () => {
  const { h, state, accountId } = await setup();
  try {
    // A send the preview saw (and warned about) does not block the place: the warning covers it.
    const a = await previewOk(h, ticket(accountId));
    assert.equal((await place(h, { requestId: a.id })).json.request.status, "placed");
    const b = await previewOk(h, ticket(accountId, { quantity: 3 }));
    assert.ok(b.preview.warnings.some((/** @type {any} */ x) => x.code === "recent_similar"));
    assert.deepEqual(rowOf(h, b.id).preview.similarSeen, [a.id]);
    const bChecked = Date.parse(rowOf(h, b.id).preview.checkedAt);
    assert.ok(bChecked <= h.now() && bChecked > h.now() - 2_000, "service time of the check");
    assert.equal((await place(h, { requestId: b.id })).json.request.status, "placed");
    assert.equal(state.sent.length, 2);

    // A claim stamped just before the check but written just after it (the preview could not see it),
    // with a row created later than that stamp: refused at place.
    const c = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    const checked = Date.parse(rowOf(h, c.id).preview.checkedAt);
    assert.equal(c.preview.warnings.some((/** @type {any} */ x) => x.code === "recent_similar"), false);
    await insertRow(h, { connectionId: rowOf(h, c.id).connection_id, accountId }, {
      symbol: "MSFT",
      status: "placed",
      sent_at: new Date(checked - 2_000).toISOString(),
      created_at: new Date(checked + 1_000).toISOString(),
    });
    const r = await place(h, { requestId: c.id });
    assert.equal(r.json.request.status, "rejected");
    assert.match(r.json.request.error, /^Another Buy order for MSFT went out from Nasscord after this preview/);
    assert.equal(state.sent.length, 2);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 12, 13, 14. unknown outcomes

test("unknown: reconciled by status reads, never resent, never read as not placed", async () => {
  const { h, state, accountId } = await setup({
    state: { place: [{ status: "unknown", error: "Nasscord could not confirm whether Alpaca received this order. Check Orders before you place it again." }], reconcile: [{ found: false }, { found: false }, { found: true, brokerOrderId: "fake-9", brokerOrderIds: [{ id: "fake-9", role: "entry" }] }] },
  });
  try {
    const req = await previewOk(h, ticket(accountId));
    let r = await place(h, { requestId: req.id });
    assert.equal(r.json.request.status, "unknown");
    assert.equal(state.calls.reconcile, 1, "one reconcile right after the unknown outcome");
    assert.equal(r.json.request.error, "Alpaca does not list this order yet. That does not mean it was not placed. Check Alpaca before you place it again.");
    assert.equal(r.json.request.autoChecking, true);

    r = await h.req("/v1/orders/requests");
    assert.deepEqual(r.json.requests.map((/** @type {any} */ x) => x.id), [req.id]);
    r = await status(h, req.id);
    assert.equal(state.calls.reconcile, 1, "at most every 5 s");

    h.advance(6_000);
    r = await status(h, req.id);
    assert.equal(r.json.request.status, "unknown");
    assert.equal(state.calls.reconcile, 2);
    assert.deepEqual(state.lastReconcileInput.clientOrderIds, [req.clientOrderId]);

    h.advance(6_000);
    r = await status(h, req.id);
    assert.equal(r.json.request.status, "placed");
    assert.equal(r.json.request.brokerOrderId, "fake-9");
    assert.deepEqual(r.json.request.brokerOrderIds, [{ id: "fake-9", role: "entry" }]);
    assert.equal(r.json.request.error, undefined);
    assert.equal(state.sent.length, 1);
    await sleep(30);
    assert.equal(audits(h, "broker.order.reconcile").length, 1);
    assert.equal((await h.req("/v1/orders/requests")).json.requests.length, 0);
    r = await place(h, { requestId: req.id });
    assert.equal(r.json.request.status, "placed");
    assert.equal(state.sent.length, 1);
  } finally {
    await h.close();
  }
});

test("unknown: single-flight reconcile, the list answers at once, 30 minutes, Check again", async () => {
  const { h, state, accountId, connectionId } = await setup({ state: { place: ["throw"], slowReconcileMs: 300 } });
  try {
    const req = await previewOk(h, ticket(accountId));
    const r = await place(h, { requestId: req.id });
    assert.equal(r.json.request.status, "unknown");
    assert.match(r.json.request.error, /^Alpaca does not list this order yet\./);
    const before = state.calls.reconcile;
    h.advance(6_000);
    await Promise.all([status(h, req.id), status(h, req.id), status(h, req.id)]);
    assert.equal(state.calls.reconcile, before + 1, "three concurrent reads make one reconcile call");

    // The list starts at most 3 reconciles and does not wait for them.
    const seed = { connectionId, accountId };
    for (let i = 0; i < 4; i++) {
      await insertRow(h, seed, { status: "unknown", sent_at: new Date(h.now() - 60_000).toISOString(), symbol: `SYM${String.fromCharCode(65 + i)}`, attempts: 1 });
    }
    h.advance(6_000);
    state.slowReconcileMs = 700;
    const n = state.calls.reconcile;
    const t0 = Date.now();
    const list = await h.req("/v1/orders/requests");
    assert.ok(Date.now() - t0 < 500, "the list does not wait for the broker");
    assert.equal(list.json.requests.length, 5);
    // The reconciles of one connection share its order lock, so they run one after the other.
    await until(() => state.calls.reconcile - n === 3, 5_000);
    await sleep(900);
    assert.equal(state.calls.reconcile - n, 3, "at most 3 per list call");
    state.slowReconcileMs = 0;

    // 31 minutes after the send: status reads stop reconciling, Check again still does.
    h.advance(31 * 60_000);
    const m = state.calls.reconcile;
    const late = await status(h, req.id);
    assert.equal(late.json.request.autoChecking, false);
    assert.equal(state.calls.reconcile, m);
    const checked = await h.req(`/v1/orders/requests/${req.id}/check`, { method: "POST" });
    assert.equal(checked.status, 200);
    assert.equal(state.calls.reconcile, m + 1);
    assert.equal(state.sent.length, 1);
  } finally {
    await h.close();
  }
});

test("placeOrder throws: unknown; OrderNotSentError: rejected", async () => {
  const { h, state, accountId } = await setup({ state: { place: ["throw", "not_sent"] } });
  try {
    const a = await previewOk(h, ticket(accountId));
    const b = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    let r = await place(h, { requestId: a.id });
    assert.equal(r.json.request.status, "unknown");
    r = await place(h, { requestId: b.id });
    assert.equal(r.json.request.status, "rejected");
    assert.equal(r.json.request.error, "The fake broker did not take the order. Nothing was placed.");
    await sleep(30);
    const results = audits(h, "broker.order.place").map((x) => [x.meta.outcome, x.result]);
    assert.deepEqual(results, [
      ["unknown", "error"],
      ["rejected", "denied"],
    ]);
  } finally {
    await h.close();
  }
});

test("a row stuck in sending for 3 minutes shows and reconciles as unknown", async () => {
  const { h, state, accountId, connectionId } = await setup({ state: { reconcile: [{ found: null, reason: "Alpaca could not be asked right now." }] } });
  try {
    const row = await insertRow(h, { connectionId, accountId }, { status: "sending", sent_at: new Date(h.now() - 180_000).toISOString(), attempts: 1 });
    const list = await h.req("/v1/orders/requests");
    assert.equal(list.json.requests[0].status, "unknown");
    assert.equal(list.json.requests[0].error, "Nasscord could not confirm whether Alpaca received this order. Check Orders before you place it again.");
    await sleep(50);
    const r = await status(h, row.id);
    assert.equal(r.json.request.status, "unknown");
    assert.ok(state.calls.reconcile >= 1);
    assert.equal(rowOf(h, row.id).status, "unknown");
    assert.equal(rowOf(h, row.id).error, "Nasscord could not confirm whether Alpaca received this order. Check Orders before you place it again. Alpaca could not be asked right now.");
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 15. needs_confirmation

test("needs_confirmation: both fields, a new client order id, approved messages by hash, four rounds at most", async () => {
  const question = { status: /** @type {const} */ ("needs_confirmation"), messages: [{ id: "o354", text: "You are submitting an order without market data." }], brokerState: { conid: 265598 } };
  const { h, state, accountId } = await setup({ state: { notices: [{ key: "fake.market", text: "Market orders fill at the next price." }], place: [question] } });
  try {
    const req = await previewOk(h, ticket(accountId));
    let r = await place(h, { requestId: req.id, acknowledged: ["fake.market"] });
    assert.equal(r.json.request.status, "needs_confirmation");
    assert.deepEqual(r.json.request.brokerMessages, question.messages);
    const firstId = req.clientOrderId;
    assert.notEqual(r.json.request.clientOrderId, firstId, "a new client order id for the next attempt");

    r = await place(h, { requestId: req.id, confirmBrokerMessages: ["o354"] });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "notices_not_acknowledged");
    r = await place(h, { requestId: req.id, acknowledged: ["fake.market"], confirmBrokerMessages: ["o999"] });
    assert.deepEqual(r.json, { error: "IBKR's questions changed. Preview the order again.", code: "confirm_mismatch" });

    r = await place(h, { requestId: req.id, acknowledged: ["fake.market", "made.up"], confirmBrokerMessages: ["o354"] });
    assert.equal(r.json.request.status, "placed");
    assert.deepEqual(state.lastPlaceInput.previousClientOrderIds, [firstId]);
    assert.notEqual(state.lastPlaceInput.clientOrderId, firstId);
    assert.deepEqual(state.lastPlaceInput.approvedMessages, [{ id: "o354", textHash: messageTextHash("You are submitting an order without market data.") }]);
    assert.deepEqual(state.lastPlaceInput.acknowledged, ["fake.market"], "only the row's notice keys reach the adapter");
    assert.equal(rowOf(h, req.id).broker_state.conid, 265598);

    // A preview row refuses confirmBrokerMessages.
    const plain = await previewOk(h, ticket(accountId, { symbol: "MSFT" }));
    r = await place(h, { requestId: plain.id, acknowledged: ["fake.market"], confirmBrokerMessages: ["o354"] });
    assert.equal(r.status, 400);

    // The fourth round is rejected.
    state.place.push(question, question, question, question);
    const many = await previewOk(h, ticket(accountId, { symbol: "TSLA" }));
    for (let i = 1; i <= 3; i++) {
      r = await place(h, { requestId: many.id, acknowledged: ["fake.market"], ...(i > 1 ? { confirmBrokerMessages: ["o354"] } : {}) });
      assert.equal(r.json.request.status, "needs_confirmation", `round ${i}`);
    }
    r = await place(h, { requestId: many.id, acknowledged: ["fake.market"], confirmBrokerMessages: ["o354"] });
    assert.equal(r.json.request.status, "rejected");
    assert.equal(r.json.request.error, "IBKR kept asking for confirmations. Nothing was placed. Place this order in IBKR instead.");
    assert.equal(rowOf(h, many.id).attempts, 4);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 16. mark as checked

test("mark as checked: owner or sender, unconfirmed rows only, audited, works with the switch off", async () => {
  const { h, accountId, connectionId } = await setup();
  try {
    const seed = { connectionId, accountId };
    const unknown = await insertRow(h, seed, { status: "unknown", sent_at: new Date(h.now() - 60_000).toISOString(), attempts: 1 });
    const placed = await insertRow(h, seed, { status: "placed", sent_at: new Date(h.now() - 60_000).toISOString(), attempts: 1, broker_order_id: "x1" });
    let pv = await previewOk(h, ticket(accountId, { symbol: "NVDA" }));
    assert.ok(pv.preview.warnings.some((/** @type {any} */ w) => w.code === "unknown_outcome"));

    const other = addMember(h);
    let r = await h.req(`/v1/orders/requests/${unknown.id}/resolve`, { method: "POST", token: other.token() });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: "Only the person who sent this order, or the workspace owner, can mark it as checked.", code: "not_your_order" });
    r = await h.req(`/v1/orders/requests/${placed.id}/resolve`, { method: "POST" });
    assert.deepEqual(r.json, { error: "Only an unconfirmed order can be marked as checked.", code: "not_unconfirmed" });

    ws(h).orders_enabled = false;
    r = await h.req(`/v1/orders/requests/${unknown.id}/resolve`, { method: "POST" });
    assert.equal(r.status, 200);
    assert.ok(r.json.request.resolvedAt);
    assert.equal(r.json.request.status, "unknown");
    assert.equal(rowOf(h, unknown.id).resolved_by, h.user);
    await sleep(30);
    assert.equal(audits(h, "broker.order.resolve").length, 1);
    assert.equal((await h.req("/v1/orders/requests")).json.requests.length, 0);
    ws(h).orders_enabled = true;
    pv = await previewOk(h, ticket(accountId, { symbol: "NVDA", limitPrice: 100.75 }));
    assert.ok(!pv.preview.warnings.some((/** @type {any} */ w) => w.code === "unknown_outcome"));

    // Reads of another workspace's request look absent.
    const [foreign] = await h.db.insert("order_requests", { ...rowOf(h, unknown.id), id: randomUUID(), workspace_id: randomUUID(), client_order_id: newClientOrderId() });
    r = await status(h, foreign.id);
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: "That order request does not exist.", code: "not_found" });
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 17. cancel

test("cancel: the order id must belong to the account; success updates the row and is audited", async () => {
  const { h, state, accountId, connectionId } = await setup({ state: { cancel: { status: "cancelled", message: "The fake broker cancelled it." } } });
  try {
    const placed = await insertRow(h, { connectionId, accountId }, { status: "placed", sent_at: new Date(h.now()).toISOString(), attempts: 1, broker_order_id: "b-77" });
    let r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `ibkr:${accountId}:b-77` } });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: "This order is not in this account.", code: "order_not_open" });
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `alpaca:${randomUUID()}:b-77` } });
    assert.equal(r.status, 404);
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId } });
    assert.deepEqual(r.json, { error: "Send the account and the order to cancel.", code: "bad_request" });
    assert.equal(state.calls.cancel, 0);

    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `alpaca:${accountId}:b-77` } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { status: "cancelled", message: "The fake broker cancelled it." });
    assert.deepEqual(state.cancelled, ["b-77"]);
    assert.equal(rowOf(h, placed.id).status, "cancelled");
    await sleep(30);
    const [a] = audits(h, "broker.order.cancel").filter((x) => x.result === "ok");
    assert.deepEqual(a.meta, { accountId, brokerOrderId: "b-77", outcome: "cancelled", requestId: placed.id });
    assert.match(a.target, / · cancel b-77$/);

    state.cancel = new HttpError(502, "Nasscord could not confirm the cancel with Alpaca. Check Orders: the order may still be working.", { code: "cancel_unknown" });
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `alpaca:${accountId}:b-78` } });
    assert.equal(r.status, 502);
    assert.equal(r.json.code, "cancel_unknown");

    const other = addMember(h);
    const theirs = await seedTradingAccount(h, { userId: other.id, ownerId: randomUUID() });
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId: theirs.accountId, orderId: `alpaca:${theirs.accountId}:1` } });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not_your_connection");
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 18. rate limits

test("rate limits: the eleventh place in a minute and one broker account across two connections", async () => {
  const { h, state, accountId, externalId } = await setup();
  try {
    const twin = await seedTradingAccount(h, { externalId });
    const symbols = ["A", "B", "C", "D", "E", "F", "G"];
    const reqs = [];
    for (const [i, sym] of symbols.entries()) reqs.push(await previewOk(h, ticket(i % 2 ? twin.accountId : accountId, { symbol: sym })));
    for (const req of reqs.slice(0, 6)) assert.equal((await place(h, { requestId: req.id })).json.request.status, "placed");
    const r = await place(h, { requestId: reqs[6].id });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, "rate_limited");
    assert.equal(r.json.error, "Too many orders from your login in a short time. Wait a minute and try again.");
    assert.ok(r.headers.get("retry-after"));
    assert.equal(state.sent.length, 6);
    assert.equal(rowOf(h, reqs[6].id).status, "preview");
  } finally {
    await h.close();
  }

  const s2 = await setup();
  try {
    const other = await seedTradingAccount(s2.h, {});
    const reqs = [];
    for (let i = 0; i < 11; i++) reqs.push(await previewOk(s2.h, ticket(i % 2 ? other.accountId : s2.accountId, { symbol: `S${String.fromCharCode(65 + i)}` })));
    for (const req of reqs.slice(0, 10)) assert.equal((await place(s2.h, { requestId: req.id })).json.request.status, "placed");
    const r = await place(s2.h, { requestId: reqs[10].id });
    assert.equal(r.status, 429);
    assert.equal(s2.state.sent.length, 10);
  } finally {
    await s2.h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 19, 20. drain and a failed outcome write

test("drain waits for a place in flight, which finishes and is stored", async () => {
  const { h, state, accountId } = await setup({ state: { slowPlaceMs: 600 } });
  try {
    const req = await previewOk(h, ticket(accountId));
    const p = place(h, { requestId: req.id });
    await until(() => state.calls.place === 1);
    let drained = false;
    const d = h.svc.orders.drain(10_000).then(() => (drained = true));
    await sleep(100);
    assert.equal(drained, false);
    const r = await p;
    assert.equal(r.json.request.status, "placed");
    await d;
    assert.equal(rowOf(h, req.id).status, "placed");
  } finally {
    await h.close();
  }
});

test("outcome write failure: 500 without a code, the row stays sending, and reads show it unknown later", async () => {
  const { h, state, accountId } = await setup({ state: { slowPlaceMs: 300 } });
  try {
    const req = await previewOk(h, ticket(accountId));
    const p = place(h, { requestId: req.id });
    await until(() => state.calls.place === 1);
    h.db.failNext.set("order_requests", Object.assign(new Error("database answered 503"), { code: "network" }));
    const r = await p;
    assert.equal(r.status, 500);
    assert.equal(r.json.code, undefined);
    assert.equal(rowOf(h, req.id).status, "sending");
    assert.ok(h.logLines.some((l) => l.includes('"msg":"order outcome not stored"')));
    h.advance(121_000);
    const s = await status(h, req.id);
    assert.equal(s.json.request.status, "unknown");
    assert.equal(state.sent.length, 1);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 21. secrets

test("no account number or secret in the log or the audit rows", async () => {
  const { h, accountId, externalId } = await setup({ state: { place: ["throw"] } });
  try {
    const req = await previewOk(h, ticket(accountId));
    await place(h, { requestId: req.id });
    await preview(h, ticket(accountId, { quantity: 0 }));
    await h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `alpaca:${accountId}:z` } });
    await sleep(30);
    const text = [...h.logLines, JSON.stringify(h.rows("audit_events")), JSON.stringify(h.rows("order_requests"))].join("\n");
    assert.ok(!text.includes(externalId), "the full account number never appears");
    assert.ok(!h.logLines.join("\n").includes(String(h.svc.config.serviceSecret)));
    assert.ok(audits(h, "broker.order.preview").length >= 1);
  } finally {
    await h.close();
  }
});

// ─────────────────────────────────────────────────────────────── 21. fixes after review

test("checkNotional: only a buy that opens or adds to a long position, with the entry price of its type", () => {
  /** @param {Record<string, unknown>} [over] */
  const t = (over = {}) =>
    /** @type {import("../src/order-contract.mjs").Ticket} */ ({
      symbol: "AAPL",
      side: "BUY",
      quantity: 1_000,
      type: "LMT",
      limitPrice: 300,
      stopPrice: null,
      tif: "DAY",
      bracket: null,
      intent: "trade",
      positionId: null,
      expectedPositionQty: null,
      ...over,
    });
  const cap = { maxNotional: 250_000 };
  assert.throws(() => checkNotional(t(), null, { ...cap, pos: 0 }), (/** @type {any} */ e) => e.code === "notional_cap" && e.message.includes("about $300,000"));
  assert.doesNotThrow(() => checkNotional(t(), null, { ...cap, pos: -1_000 }), "a cover is bounded by the short");
  assert.doesNotThrow(() => checkNotional(t({ side: "SELL" }), null, { ...cap, pos: 2_000 }));
  assert.throws(() => checkNotional(t({ type: "MKT", limitPrice: null }), 260, { ...cap, pos: 5 }), (/** @type {any} */ e) => e.code === "notional_cap");
  assert.doesNotThrow(() => checkNotional(t({ type: "MKT", limitPrice: null }), 240, { ...cap, pos: 5 }));
  assert.throws(() => checkNotional(t({ type: "STP", limitPrice: null, stopPrice: 251 }), 100, { ...cap, pos: 0 }), (/** @type {any} */ e) => e.code === "notional_cap");
});

test("a cover previewed against a short is not sent once the short is gone (it would open an unchecked long)", async () => {
  const { h, state, accountId } = await setup({ state: { position: { AAPL: { qty: -3_000, workingSell: 0, workingBuy: 0, working: true } } } });
  try {
    // 3,000 x $100.50 = $301,500: above the $250,000 cap, allowed at preview only because it covers a short.
    const req = await previewOk(h, ticket(accountId, { quantity: 3_000 }));
    // The short was closed elsewhere before Place.
    state.position.AAPL = { qty: 0, workingSell: 0, workingBuy: 0, working: true };
    const r = await place(h, { requestId: req.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.request.status, "rejected");
    assert.equal(r.json.request.error, "Your AAPL position is now 0 shares. Review the order and confirm again. Nothing was placed.");
    assert.equal(state.sent.length, 0);
    assert.equal(state.calls.place, 0);

    // A cover that is still a cover goes out.
    state.position.AAPL = { qty: -3_000, workingSell: 0, workingBuy: 0, working: true };
    const again = await previewOk(h, ticket(accountId, { quantity: 3_000 }));
    assert.equal((await place(h, { requestId: again.id })).json.request.status, "placed");
    assert.equal(state.sent.length, 1);
  } finally {
    await h.close();
  }
});

test("a confirmation queued behind another round of the same request is refused, not sent with the old questions", async () => {
  const question = { status: /** @type {const} */ ("needs_confirmation"), messages: [{ id: "o354", text: "You are submitting an order without market data." }] };
  const { h, state, accountId, connectionId } = await setup({ state: { place: [question, question] } });
  try {
    const req = await previewOk(h, ticket(accountId));
    const first = await place(h, { requestId: req.id });
    assert.equal(first.json.request.status, "needs_confirmation");
    // Two confirmations of the same round both pass the checks while the lock is busy.
    const held = h.svc.locks.run(`order:${connectionId}`, () => sleep(300));
    const a = place(h, { requestId: req.id, confirmBrokerMessages: ["o354"] });
    await sleep(100);
    const b = place(h, { requestId: req.id, confirmBrokerMessages: ["o354"] });
    await held;
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.json.request.status, "needs_confirmation", "the first one asked again and got a new round");
    assert.equal(rb.status, 409, JSON.stringify(rb.json));
    assert.deepEqual(rb.json, { error: "IBKR's questions changed. Preview the order again.", code: "confirm_mismatch" });
    assert.equal(state.calls.place, 2, "the queued one sent nothing");
    assert.equal(rowOf(h, req.id).attempts, 2);
    assert.equal(rowOf(h, req.id).status, "needs_confirmation");
  } finally {
    await h.close();
  }
});

test("drain: a place, preview or cancel still waiting for the lock is refused and sends nothing", async () => {
  const { h, state, accountId, connectionId } = await setup();
  try {
    const req = await previewOk(h, ticket(accountId));
    const held = h.svc.locks.run(`order:${connectionId}`, () => sleep(400));
    const p = place(h, { requestId: req.id });
    const v = preview(h, ticket(accountId, { symbol: "MSFT" }));
    const c = h.req("/v1/orders/cancel", { method: "POST", body: { accountId, orderId: `alpaca:${accountId}:b-1` } });
    await sleep(150);
    const d = h.svc.orders.drain(5_000);
    await held;
    const [rp, rv, rc] = await Promise.all([p, v, c]);
    for (const r of [rp, rv, rc]) {
      assert.equal(r.status, 503, JSON.stringify(r.json));
      assert.equal(r.json.code, "shutting_down");
    }
    assert.equal(rp.json.error, "The broker service is restarting. Nothing was placed. Try again in a minute.");
    assert.equal(rc.json.error, "The broker service is restarting. Nothing was cancelled. Try again in a minute.");
    assert.equal(rowOf(h, req.id).status, "preview", "the row was never claimed");
    assert.deepEqual([state.calls.preview, state.calls.place, state.calls.cancel], [1, 0, 0]);
    await d;
  } finally {
    await h.close();
  }
});

test("a disconnect keeps the duplicate checks, reconcile and cancel on the broker account (account_key)", async () => {
  const unknown = { status: /** @type {const} */ ("unknown"), error: "Nasscord could not confirm whether Alpaca received this order. Check Orders before you place it again." };
  const { h, state, accountId, connectionId, externalId } = await setup({ state: { place: [unknown], reconcile: [{ found: false }] } });
  /** @param {string} id @param {string} to */
  const setStatus = (id, to) => {
    /** @type {any} */ (h.rows("broker_connections").find((x) => x.id === id)).status = to;
  };
  try {
    // The same broker account under a second login of the workspace.
    const twin = await seedTradingAccount(h, { externalId });
    const a = await previewOk(h, ticket(accountId));
    const b = await previewOk(h, ticket(twin.accountId, { limitPrice: 100.25 }));
    assert.equal((await place(h, { requestId: a.id })).json.request.status, "unknown");
    assert.equal(rowOf(h, a.id).account_key, accountKey({ broker_id: "alpaca", external_id: externalId }));

    // Disconnect the first login: its broker_accounts rows go, the order row keeps its record.
    await h.db.remove("broker_accounts", { connection_id: connectionId });
    setStatus(connectionId, "disconnected");
    assert.equal(rowOf(h, a.id).account_id, null);

    // Another ticket of the same account, symbol and side previewed before the send is still not sent.
    const rb = await place(h, { requestId: b.id });
    assert.equal(rb.json.request.status, "rejected");
    assert.match(rb.json.request.error, /^Another Buy order for AAPL went out from Nasscord after this preview/);
    assert.equal(state.sent.length, 1);

    // A new preview still warns about the unconfirmed order.
    const c = await previewOk(h, ticket(twin.accountId));
    const codes = c.preview.warnings.map((/** @type {any} */ w) => w.code);
    assert.ok(codes.includes("unknown_outcome") && codes.includes("recent_similar"), codes.join(","));

    // No active login reaches the account: nothing checks it, and the view says so.
    setStatus(twin.connectionId, "expired");
    h.advance(6_000);
    const calls = state.calls.reconcile;
    let r = await status(h, a.id);
    assert.equal(r.json.request.status, "unknown");
    assert.equal(r.json.request.autoChecking, false);
    assert.equal(state.calls.reconcile, calls);
    r = await h.req("/v1/orders/requests");
    assert.equal(r.json.requests.find((/** @type {any} */ x) => x.id === a.id).autoChecking, false);

    // The login is back: reconcile reaches the row through it, and a cancel there updates the row.
    setStatus(twin.connectionId, "active");
    state.reconcile = [{ found: true, brokerOrderId: "fake-9" }];
    h.advance(6_000);
    r = await status(h, a.id);
    assert.equal(r.json.request.status, "placed");
    assert.equal(r.json.request.brokerOrderId, "fake-9");
    r = await h.req("/v1/orders/cancel", { method: "POST", body: { accountId: twin.accountId, orderId: `alpaca:${twin.accountId}:fake-9` } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(rowOf(h, a.id).status, "cancel_requested");
  } finally {
    await h.close();
  }
});

test("before the order_entry migration the unconfirmed list is empty, not an error", async () => {
  const { DbError } = await import("../src/db.mjs");
  for (const [table, code] of [
    ["workspaces", "42703"],
    ["order_requests", "PGRST205"],
  ]) {
    const { h } = await setup();
    try {
      const select = h.db.select.bind(h.db);
      h.db.select = async (/** @type {string} */ t, /** @type {any} */ opts) => {
        if (t === table) throw new DbError("missing", { status: 400, code });
        return select(t, opts);
      };
      const r = await h.req("/v1/orders/requests");
      assert.equal(r.status, 200, `${table}: ${JSON.stringify(r.json)}`);
      assert.deepEqual(r.json.requests, []);
    } finally {
      await h.close();
    }
  }
});
