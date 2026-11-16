import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../src/errors.mjs";
import { quotaAwareFetch } from "../src/tradier/client.mjs";
import {
  collection,
  historyDate,
  listOf,
  quotaExpiry,
  tradierAccountRows,
  tradierAccountSummary,
  tradierAccountType,
  tradierHistoryFills,
  tradierOrderFills,
  tradierOrders,
  tradierOrderStatus,
  tradierOrderType,
  tradierPosition,
  tradierProfile,
  tradierProfileId,
  tradierQuoteMap,
  tradierTokenError,
} from "../src/tradier/mapping.mjs";

const ACCT = { id: "11111111-2222-4333-8444-555555555555" };
const FETCHED = Date.parse("2026-11-16T15:00:00Z");

test("collections: an array, one bare object, and the empty forms all become arrays", () => {
  assert.deepEqual(listOf([{ a: 1 }, { a: 2 }]), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(listOf({ a: 1 }), [{ a: 1 }]);
  for (const empty of ["null", null, undefined, "", 7]) assert.deepEqual(listOf(empty), []);
  assert.deepEqual(listOf([{ a: 1 }, null, "null"]), [{ a: 1 }]);

  assert.deepEqual(collection({ positions: { position: { symbol: "AAPL" } } }, "positions", "position"), [{ symbol: "AAPL" }]);
  assert.deepEqual(collection({ positions: { position: [{ symbol: "A" }, { symbol: "B" }] } }, "positions", "position").length, 2);
  assert.deepEqual(collection({ positions: "null" }, "positions", "position"), []);
  assert.deepEqual(collection({ orders: null }, "orders", "order"), []);
  assert.deepEqual(collection({ quotes: { unmatched_symbols: { symbol: "ZZZZ" } } }, "quotes", "quote"), [], "only unknown symbols");
  for (const bad of [null, "null", [], { other: 1 }, { positions: 5 }, { positions: [] }]) {
    assert.throws(() => collection(bad, "positions", "position"), (e) => e instanceof HttpError && e.code === "broker_reply", JSON.stringify(bad));
  }
});

test("accounts: types, closed accounts left out, the profile id names the login", () => {
  assert.equal(tradierAccountType({ classification: "roth_ira", type: "cash" }, "production"), "roth");
  for (const c of ["traditional_ira", "rollover_ira", "sep_ira", "ira", "simple_ira"]) assert.equal(tradierAccountType({ classification: c, type: "cash" }, "production"), "ira", c);
  assert.equal(tradierAccountType({ classification: "individual", type: "margin" }, "production"), "margin");
  assert.equal(tradierAccountType({ classification: "joint_survivor", type: "cash" }, "production"), "individual");
  assert.equal(tradierAccountType({ classification: "individual", type: "pdt" }, "production"), "individual");
  assert.equal(tradierAccountType({ classification: "roth_ira", type: "margin" }, "paper"), "paper", "a sandbox account is Paper");

  const profile = tradierProfile({
    profile: {
      id: "id-pat",
      name: "Pat Example",
      account: [
        { account_number: "6YA00001", classification: "individual", type: "margin", status: "active" },
        { account_number: "6YA00002", classification: "roth_ira", type: "cash", status: "active" },
        { account_number: "6YA00003", classification: "individual", type: "cash", status: "closed" },
        { account_number: "6YA00001", classification: "individual", type: "margin", status: "active" },
        { account_number: "6YA/../1", classification: "individual", type: "cash", status: "active" },
        { classification: "individual", type: "cash", status: "active" },
      ],
    },
  });
  assert.deepEqual(tradierAccountRows(profile, "production"), [
    { broker_id: "tradier", external_id: "6YA00001", display_number: "6YA•••01", label: "Tradier Margin", type: "margin" },
    { broker_id: "tradier", external_id: "6YA00002", display_number: "6YA•••02", label: "Tradier Roth IRA", type: "roth" },
  ]);
  const one = tradierProfile({ profile: { id: 42, account: { account_number: "VA00000001", classification: "individual", type: "margin", status: "active" } } });
  assert.deepEqual(
    tradierAccountRows(one, "paper").map((r) => [r.external_id, r.label, r.type]),
    [["VA00000001", "Tradier Paper", "paper"]],
  );
  assert.equal(tradierProfileId(profile), "id-pat");
  assert.equal(tradierProfileId(one), "42");
  assert.equal(tradierProfileId({ id: "" }), null);
  assert.equal(tradierProfileId({ id: "x".repeat(191) }), null);
  assert.throws(() => tradierProfile({ profile: "null" }), (e) => e instanceof HttpError && e.code === "broker_reply");
});

test("balances: buying power by account type; a value Tradier did not send is left out", () => {
  const acct = { id: "a" };
  assert.deepEqual(
    tradierAccountSummary({ balances: { account_type: "margin", total_equity: 100.123, total_cash: 50, margin: { stock_buying_power: 200, option_buying_power: 100 } } }, acct),
    { accountId: "a", netLiq: 100.12, cash: 50, buyingPower: 200, currency: "USD" },
  );
  assert.deepEqual(tradierAccountSummary({ balances: { account_type: "cash", total_equity: 10, total_cash: 10, cash: { cash_available: 9 } } }, acct), {
    accountId: "a",
    netLiq: 10,
    cash: 10,
    buyingPower: 9,
    currency: "USD",
  });
  assert.deepEqual(tradierAccountSummary({ balances: { account_type: "pdt", total_equity: 30_000, pdt: { stock_buying_power: 120_000 } } }, acct), {
    accountId: "a",
    netLiq: 30_000,
    buyingPower: 120_000,
    currency: "USD",
  });
  assert.deepEqual(tradierAccountSummary({ balances: { account_type: "margin" } }, acct), { accountId: "a", currency: "USD" }, "nothing reported, nothing invented");
  assert.throws(() => tradierAccountSummary({ balances: "null" }, acct), (e) => e instanceof HttpError && e.code === "broker_reply");
});

test("positions: valued from the quote with the option multiplier; no quote, no value", () => {
  const quotes = tradierQuoteMap([
    { symbol: "aapl", last: 151.5, prevclose: 150 },
    { symbol: "SPY261218C00600000", last: 3.5, contract_size: 100 },
    { symbol: "SPY261218C00610000", last: null, prevclose: 2.2 },
    { symbol: "XYZ", last: 0, prevclose: 0, close: 0 },
    { symbol: "MINI261218C00010000", last: 1, contract_size: 10 },
  ]);
  assert.deepEqual(quotes.get("AAPL"), { price: 151.5, multiplier: 1 });
  assert.deepEqual(quotes.get("SPY261218C00600000"), { price: 3.5, multiplier: 100 });
  assert.deepEqual(quotes.get("SPY261218C00610000"), { price: 2.2, multiplier: 100 }, "no trade today: the previous close");
  assert.deepEqual(quotes.get("XYZ"), { price: undefined, multiplier: 1 }, "a zero is not a price");
  assert.equal(quotes.get("MINI261218C00010000")?.multiplier, 10, "the contract size Tradier sends wins");

  assert.deepEqual(tradierPosition({ id: 7, symbol: "AAPL", quantity: 10, cost_basis: 1_502.5 }, ACCT, quotes.get("AAPL")), {
    id: `tradier:${ACCT.id}:7`,
    accountId: ACCT.id,
    brokerId: "tradier",
    symbol: "AAPL",
    qty: 10,
    avgCost: 150.25,
    last: 151.5,
    currency: "USD",
    secType: "STK",
    marketValue: 1_515,
    unrealizedPnl: 12.5,
  });
  const short = tradierPosition({ symbol: "SPY261218C00600000", quantity: -2, cost_basis: -620 }, ACCT, quotes.get("SPY261218C00600000"));
  assert.deepEqual([short.id, short.qty, short.avgCost, short.marketValue, short.unrealizedPnl, short.secType], [`tradier:${ACCT.id}:SPY261218C00600000`, -2, 3.1, -700, -80, "OPT"]);
  const shortPositiveBasis = tradierPosition({ symbol: "SPY261218C00600000", quantity: -2, cost_basis: 620 }, ACCT, quotes.get("SPY261218C00600000"));
  assert.equal(shortPositiveBasis.unrealizedPnl, -80, "a short's basis is its proceeds whatever its sign");
  const unpriced = tradierPosition({ symbol: "XYZ", quantity: 3, cost_basis: 30 }, ACCT, quotes.get("XYZ"));
  assert.deepEqual([unpriced.last, "last" in unpriced, unpriced.avgCost, "marketValue" in unpriced, "unrealizedPnl" in unpriced], [undefined, false, 10, false, false], "no price: no last price either");
  const noQuote = tradierPosition({ symbol: "SPY261218P00500000", quantity: 1, cost_basis: 250 }, ACCT, undefined);
  assert.deepEqual([noQuote.avgCost, noQuote.secType, "marketValue" in noQuote], [2.5, "OPT", false], "an option without a quote still uses 100 a contract for its cost");
});

test("orders: status, type, time in force, extended hours, legs and the OTO parent", () => {
  assert.deepEqual(
    ["pending", "open", "partially_filled", "filled", "canceled", "expired", "pending_cancel", "rejected", "error", "calculated", "held", "accepted_for_bidding"].map(tradierOrderStatus),
    ["submitted", "working", "working", "filled", "cancelled", "cancelled", "cancelled", "rejected", "rejected", "working", "working", "working"],
  );
  assert.deepEqual(
    [
      ["market", false],
      ["limit", true],
      ["stop", true],
      ["stop_limit", true],
      ["debit", true],
      ["credit", true],
      ["even", true],
      ["", true],
      ["", false],
    ].map(([t, p]) => tradierOrderType(t, /** @type {boolean} */ (p))),
    ["MKT", "LMT", "STP", "STP", "LMT", "LMT", "LMT", "LMT", "MKT"],
  );

  const single = tradierOrders(
    /** @type {any} */ (listOf({ id: 1, type: "stop_limit", symbol: "aapl", side: "sell_short", quantity: 5, status: "open", duration: "gtc", price: 139, stop_price: 140, exec_quantity: 0 })),
    ACCT,
    FETCHED,
  );
  assert.deepEqual(single, [
    {
      id: `tradier:${ACCT.id}:1`,
      clientId: "tradier-1",
      accountId: ACCT.id,
      brokerId: "tradier",
      symbol: "AAPL",
      side: "SELL",
      qty: 5,
      type: "STP",
      tif: "GTC",
      status: "working",
      placedAt: new Date(FETCHED).toISOString(),
      brokerRef: "1",
      price: 140,
      filledQty: 0,
      outsideRth: false,
    },
  ]);
  const post = tradierOrders([{ id: 2, type: "limit", symbol: "MSFT", side: "buy_to_cover", quantity: 1, status: "filled", duration: "post", price: 400, avg_fill_price: 399.5, exec_quantity: 1, create_date: "2026-11-16T21:00:00.000Z" }], ACCT, FETCHED)[0];
  assert.deepEqual([post.side, post.tif, post.outsideRth, post.avgFill, post.placedAt], ["BUY", "DAY", true, 399.5, "2026-11-16T21:00:00.000Z"]);

  const oto = tradierOrders(
    [
      {
        id: 10,
        class: "otoco",
        duration: "gtc",
        status: "open",
        create_date: "2026-11-16T14:00:00.000Z",
        leg: [
          { id: 11, type: "limit", symbol: "AAPL", side: "buy", quantity: 10, price: 150, status: "filled", exec_quantity: 10, avg_fill_price: 150 },
          { id: 12, type: "limit", symbol: "AAPL", side: "sell", quantity: 10, price: 160 },
          { id: 13, type: "stop", symbol: "AAPL", side: "sell", quantity: 10, stop_price: 140 },
        ],
      },
    ],
    ACCT,
    FETCHED,
  );
  assert.deepEqual(
    oto.map((o) => [o.id.split(":").slice(2).join(":"), o.type, o.price, o.tif, o.status, o.parentId?.split(":").slice(2).join(":"), o.placedAt]),
    [
      ["10:11", "LMT", 150, "GTC", "filled", undefined, "2026-11-16T14:00:00.000Z"],
      ["10:12", "LMT", 160, "GTC", "working", "10:11", "2026-11-16T14:00:00.000Z"],
      ["10:13", "STP", 140, "GTC", "working", "10:11", "2026-11-16T14:00:00.000Z"],
    ],
    "legs take the order's duration, status and time when they send none; OTO legs wait on the first",
  );
  const oco = tradierOrders([{ id: 20, class: "oco", leg: [{ id: 21, type: "limit", symbol: "A", side: "sell", quantity: 1, price: 2 }, { id: 22, type: "stop", symbol: "A", side: "sell", quantity: 1, stop_price: 1 }] }], ACCT, FETCHED);
  assert.ok(oco.every((o) => o.parentId === undefined), "OCO legs are siblings");
  assert.deepEqual(tradierOrders([{ type: "limit" }, null], ACCT, FETCHED), [], "an order without an id is left out");
});

test("fills from today's orders: each filled order or leg once, provisional", () => {
  const fills = tradierOrderFills(
    [
      { id: 1, symbol: "AAPL", side: "buy", exec_quantity: 4, avg_fill_price: 150, transaction_date: "2026-11-16T15:00:01.000Z", status: "partially_filled" },
      { id: 2, symbol: "AAPL", side: "sell", exec_quantity: 0, avg_fill_price: 0, status: "open" },
      {
        id: 3,
        class: "multileg",
        exec_quantity: 1,
        avg_fill_price: 1.25,
        transaction_date: "2026-11-16T15:30:00.000Z",
        leg: [
          { id: 4, option_symbol: "SPY261218C00600000", side: "buy_to_open", exec_quantity: 1, avg_fill_price: 3.5 },
          { id: 5, option_symbol: "SPY261218C00610000", side: "sell_to_open", exec_quantity: 1, avg_fill_price: 2.25 },
        ],
      },
    ],
    ACCT,
    FETCHED,
  );
  assert.deepEqual(
    fills.map((f) => [f.id.split(":").slice(2).join(":"), f.symbol, f.side, f.qty, f.price, f.net, f.commission, f.provisional, f.tradedAt]),
    [
      ["o:1", "AAPL", "BUY", 4, 150, -600, 0, true, "2026-11-16T15:00:01.000Z"],
      ["o:3:4", "SPY261218C00600000", "BUY", 1, 3.5, -350, 0, true, "2026-11-16T15:30:00.000Z"],
      ["o:3:5", "SPY261218C00610000", "SELL", 1, 2.25, 225, 0, true, "2026-11-16T15:30:00.000Z"],
    ],
    "the multileg order is its legs, never counted twice",
  );
});

test("fills from the history: nested or flat, side from quantity or cash, the day's close, stable ids", () => {
  const events = [
    { amount: -1_502.5, date: "2026-07-01T00:00:00Z", type: "trade", trade: { commission: 0, price: 150.25, quantity: 10, symbol: "AAPL", trade_type: "Equity" } },
    { amount: 618.7, date: "2025-12-01T00:00:00Z", type: "trade", trade: { commission: 1.3, price: 3.1, quantity: -2, symbol: "SPY261218C00600000", trade_type: "Option" } },
    // Flat fields, a sale written with a positive quantity: the cash coming in says it is a sale.
    { amount: 999, date: "2026-11-02", type: "trade", symbol: "MSFT", quantity: 2, price: 500, commission: 1 },
    // No amount: net from price, quantity, multiplier and commission.
    { date: "2026-11-03T00:00:00Z", type: "trade", trade: { price: 2, quantity: 3, symbol: "XYZ123", commission: 0.5, trade_type: "Option" } },
    { amount: 12.34, date: "2026-11-04T00:00:00Z", type: "dividend", dividend: { description: "DIV" } },
    { amount: -1, date: "2026-11-05T00:00:00Z", type: "trade", trade: { price: 0, quantity: 1, symbol: "ZERO" } },
    { amount: -10, type: "trade", trade: { price: 1, quantity: 10, symbol: "NODATE" } },
    // Two identical events (two fills at the same price on the same day) stay two.
    { amount: -100, date: "2026-11-06T00:00:00Z", type: "trade", trade: { price: 10, quantity: 10, symbol: "DUP" } },
    { amount: -100, date: "2026-11-06T00:00:00Z", type: "trade", trade: { price: 10, quantity: 10, symbol: "DUP" } },
    { amount: -100, date: "2026-11-16T00:00:00Z", type: "trade", trade: { price: 10, quantity: 10, symbol: "TODAY" } },
  ];
  const fills = tradierHistoryFills(events, ACCT, { before: "2026-11-16" });
  const by = (/** @type {string} */ s) => fills.filter((f) => f.symbol === s);
  assert.deepEqual(
    fills.map((f) => f.symbol),
    ["AAPL", "SPY261218C00600000", "MSFT", "XYZ123", "DUP", "DUP"],
    "no dividend, no zero price, no event without a date, nothing from today",
  );
  assert.deepEqual(
    (({ side, qty, price, commission, net, provisional, tradedAt }) => ({ side, qty, price, commission, net, provisional, tradedAt }))(by("AAPL")[0]),
    { side: "BUY", qty: 10, price: 150.25, commission: 0, net: -1_502.5, provisional: true, tradedAt: "2026-07-01T20:00:00.000Z" },
    "16:00 New York in summer",
  );
  assert.deepEqual([by("SPY261218C00600000")[0].side, by("SPY261218C00600000")[0].qty, by("SPY261218C00600000")[0].commission, by("SPY261218C00600000")[0].tradedAt], ["SELL", 2, 1.3, "2025-12-01T21:00:00.000Z"]);
  assert.deepEqual([by("MSFT")[0].side, by("MSFT")[0].net], ["SELL", 999]);
  assert.deepEqual([by("XYZ123")[0].side, by("XYZ123")[0].net], ["BUY", -600.5], "an option trade counts 100 a contract");
  const [a, b] = by("DUP");
  assert.notEqual(a.id, b.id);
  assert.match(b.id, /:2$/);
  assert.deepEqual(
    tradierHistoryFills(events, ACCT, { before: "2026-11-16" }).map((f) => f.id),
    fills.map((f) => f.id),
    "the same events give the same ids on every read",
  );
  assert.ok(fills.every((f) => f.id.startsWith(`tradier:${ACCT.id}:h:`) && !f.id.includes("AAPL")));
  assert.equal(historyDate({ date: "2026-11-02" }), "2026-11-02");
  assert.equal(historyDate({ date: "Nov 2" }), null);
  assert.equal(tradierHistoryFills(listOf({ amount: -5, date: "2026-11-01T00:00:00Z", type: "trade", trade: { price: 5, quantity: 1, symbol: "ONE" } }), ACCT).length, 1, "one event arrives as a bare object");
});

test("token errors: a refused code or refresh token is the user's own; a refused client is the platform's", () => {
  assert.equal(tradierTokenError(400, { error: "invalid_grant" }), "invalid_grant");
  assert.equal(tradierTokenError(400, { error: "invalid_request", error_description: "code expired" }), "invalid_grant");
  assert.equal(tradierTokenError(401, { error: "invalid_client" }), "invalid_client");
  assert.equal(tradierTokenError(401, { error: "unauthorized_client" }), "invalid_client");
  assert.equal(tradierTokenError(401, { fault: { faultstring: "Invalid client identifier {0}", detail: { errorcode: "oauth.v2.InvalidClientIdentifier" } } }), "invalid_client");
  assert.equal(tradierTokenError(400, { fault: { faultstring: "Invalid Refresh Token", detail: { errorcode: "oauth.v2.InvalidRefreshToken" } } }), "invalid_grant");
  assert.equal(tradierTokenError(401, {}), "invalid_client");
  assert.equal(tradierTokenError(400, null), "invalid_grant");
  assert.equal(tradierTokenError(500, { error: "server_error" }), "other");
  assert.equal(tradierTokenError(503, null), "other");
});

test("Quota Violation: the end comes from X-Ratelimit-Expiry or the body; the fetch adds Retry-After", async () => {
  const now = Date.parse("2026-11-16T15:00:00Z");
  assert.equal(quotaExpiry("Quota Violation", new Headers({ "x-ratelimit-expiry": String(now + 30_000) })), now + 30_000);
  assert.equal(quotaExpiry(`Quota Violation: Expires ${now + 12_000}`, new Headers()), now + 12_000);
  assert.equal(quotaExpiry(`Quota Violation: Expires ${Math.floor((now + 9_000) / 1000)}`, new Headers()), Math.floor((now + 9_000) / 1000) * 1000, "seconds are read too");
  assert.equal(quotaExpiry("Quota Violation", new Headers()), null);

  /** @type {Response[]} */
  const answers = [
    new Response(`Quota Violation: Expires ${now + 30_000}`, { status: 400, headers: { "content-type": "plain/text" } }),
    new Response("Invalid account number", { status: 400 }),
    new Response('{"ok":true}', { status: 200 }),
  ];
  const ok = answers[2];
  const f = quotaAwareFetch(/** @type {typeof fetch} */ (async () => /** @type {Response} */ (answers.shift())), () => now);
  const quota = await f("https://api.tradier.com/v1/user/profile");
  assert.equal(quota.status, 400);
  assert.equal(quota.headers.get("retry-after"), "30");
  assert.match(await quota.text(), /^Quota Violation/);
  const other = await f("https://api.tradier.com/v1/user/profile");
  assert.equal(other.headers.get("retry-after"), null);
  assert.equal(await other.text(), "Invalid account number", "other 400s pass through with their body");
  assert.equal(await f("https://api.tradier.com/v1/user/profile"), ok, "everything else is the same response");
});
