import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

/**
 * A stand-in for the IBKR Client Portal Gateway, started by a fake `spawn` so the real gateway
 * manager, keepalive, adapter and login proxy all run against it. It reads its port from the
 * conf.yaml the manager rendered, like the real JVM does.
 *
 * For order entry it also answers the order path (contract lookup, rules, snapshot, what-if, the
 * order POST and its reply questions from state.placeQueue, order status, cancel) and keeps an
 * order book in state.liveOrders. It never talks to IBKR: everything stays on 127.0.0.1.
 */

export const GATEWAY_TEMPLATE = `    ip2loc: "US"
    proxyRemoteHost: "https://api.ibkr.com"
    listenPort: 5000
    listenSsl: true
    sslCert: "vertx.jks"
    sslPwd: "test-only-password"
    ips:
      allow:
        - 192.*
        - 127.0.0.1
      deny:
        - 212.90.324.10
`;

/** A folder shaped like the gateway bundle (no real jars needed with the fake spawn). */
export function fakeBundle() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nasscord-bundle-"));
  mkdirSync(path.join(dir, "root"));
  mkdirSync(path.join(dir, "dist"));
  mkdirSync(path.join(dir, "build", "lib", "runtime"), { recursive: true });
  writeFileSync(path.join(dir, "root", "conf.yaml"), GATEWAY_TEMPLATE);
  writeFileSync(path.join(dir, "dist", "ibgroup.web.core.iblink.router.clientportal.gw.jar"), "");
  return dir;
}

/** @param {number} n @param {string} acct */
const positions = (n, acct, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    acctId: acct,
    conid: 1000 + offset + i,
    contractDesc: `SYM${offset + i}`,
    ticker: `SYM${offset + i}`,
    position: 10,
    mktPrice: 50,
    mktValue: 500,
    currency: "USD",
    avgCost: 45,
    avgPrice: 45,
    unrealizedPnl: 50,
    assetClass: "STK",
  }));

/** The two default orders of the live orders list (the read path tests rely on them). */
const BASE_ORDERS = () => [
  { acct: "U1234567", orderId: 1290035, ticker: "AVGO", side: "SELL", totalSize: 12, filledQuantity: 0, remainingQuantity: 12, orderType: "Limit", price: "189.9", timeInForce: "GTC", status: "Submitted", lastExecutionTime_r: Date.parse("2026-11-03T14:30:00Z") },
  { acct: "U9999999", orderId: 1, ticker: "XYZ", side: "BUY", totalSize: 1, orderType: "Market", status: "Filled" },
];

/** The two default trades (the read path tests rely on them). */
const BASE_TRADES = () => [
  { execution_id: "0000e0d5.6543.01.01", symbol: "AVGO", side: "B", size: 12, price: "172.77", commission: "1.00", net_amount: 2073.24, account: "U1234567", trade_time_r: Date.parse("2026-11-03T14:20:00Z") },
  { execution_id: "other", symbol: "XYZ", side: "S", size: 1, price: "1", account: "U9999999", trade_time_r: 1 },
];

/** IBKR's words for the question ids the tests use. */
export const IBKR_MESSAGE_TEXT = Object.freeze({
  o354: "You are submitting an order without market data. We strongly recommend against this as it may result in erroneous and unexpected trades. Are you sure you want to submit this order?",
  o10151: "You are about to submit a market order. Market orders can fill at prices far from the last price.",
  o10153: "Confirm Mandatory Cap Price. To avoid trading at a price that is not consistent with a fair and orderly market, IB may set a cap.",
  o10152: "You are about to submit a stop order. Please be aware of the risks of stop orders once they become active.",
  o10331: "You are about to submit a stop order. Please be aware of the various stop order types available and the risks associated with each one.",
  o10334: "This order will be placed into current omnibus account instead of currently selected global account.",
  o163: "The following order exceeds the price percentage limit.",
});

export function createGatewayState() {
  return {
    /** the user finished the IBKR login page */
    loggedIn: false,
    competing: false,
    /** ssodh/init has opened the brokerage session */
    bridge: false,
    /** @type {Array<{ method: string, path: string, body: string, bodyLength: number, at: number, headers: http.IncomingHttpHeaders }>} */
    requests: [],
    /** @type {any[]} */
    procs: [],
    accounts: ["U1234567", "U7654321"],
    /** accounts whose /portfolio/{acct}/summary answers 500 */
    /** @type {Set<string>} */
    failSummary: new Set(),
    /** how long a killed JVM takes to exit (a real one can take seconds) */
    exitDelayMs: 0,

    // ─────────────────────────── order entry (test/ibkr-orders.test.mjs)
    /** the fake's clock (pacing check, request times) */
    now: () => Date.now(),
    /** a second call of a paced path within 5 s answers 429 (it is always counted) */
    enforcePacing: false,
    pacingViolations: 0,
    /** @type {Record<string, number>} when each paced path was last called, per gateway port ("<port>:orders") */
    pacedAt: {},
    /** the first /iserver/account/orders call after ssodh/init answers IBKR's empty pre-flight */
    preflight: false,
    /** @type {Set<string>} gateway ports whose next orders call is the pre-flight */
    preflightPending: new Set(),
    /** answers for the next /iserver/account/orders calls, before anything else: { status?, body? } */
    /** @type {Array<{ status?: number, body?: unknown }>} */
    ordersQueue: [],
    /** /iserver/accounts isPaper; undefined leaves the field out */
    /** @type {boolean | undefined} */
    isPaper: false,
    /** @type {Record<string, Record<string, unknown>>} */
    acctProps: {},
    /** /trsrv/stocks groups per symbol */
    /** @type {Record<string, any[]>} */
    contracts: {
      AAPL: [
        { name: "APPLE INC", assetClass: "STK", contracts: [{ conid: 265598, exchange: "NASDAQ", isUS: true }, { conid: 38708077, exchange: "MEXI", isUS: false }] },
        { name: "APPLE INC-CDR", assetClass: "STK", contracts: [{ conid: 532640894, exchange: "AEQLIT", isUS: false }] },
      ],
      SPY: [{ name: "SPDR S&P 500 ETF TRUST", assetClass: "STK", contracts: [{ conid: 756733, exchange: "ARCA", isUS: true }] }],
    },
    /** /iserver/contract/{conid}/info per conid */
    /** @type {Record<string, Record<string, unknown>>} */
    contractInfo: {
      265598: { con_id: 265598, symbol: "AAPL", company_name: "APPLE INC", exchange: "NASDAQ", currency: "USD", instrument_type: "STK" },
      756733: { con_id: 756733, symbol: "SPY", company_name: "SPDR S&P 500 ETF TRUST", exchange: "ARCA", currency: "USD", instrument_type: "STK" },
      72063691: { con_id: 72063691, symbol: "BRK B", company_name: "BERKSHIRE HATHAWAY INC-CL B", exchange: "NYSE", currency: "USD", instrument_type: "STK" },
    },
    /** fields merged into every /iserver/contract/rules answer */
    /** @type {Record<string, unknown>} */
    rulesPatch: {},
    /** snapshot fields per conid (the first call per conid answers the empty pre-flight) */
    /** @type {Record<string, Record<string, string>>} */
    snapshot: {
      265598: { 31: "185.20", 84: "185.10", 86: "185.14" },
      756733: { 31: "590.00", 84: "589.98", 86: "590.02" },
      72063691: { 31: "C480.00", 84: "479.90", 86: "480.10" },
    },
    /** @type {Set<string>} */
    snapshotSeen: new Set(),
    /** the what-if amount's price for a ticket without one */
    lastPrice: 185.12,
    /** @type {string | null} */
    whatifWarn: null,
    /** @type {string | null} */
    whatifError: null,
    /** /portfolio2/{acct}/positions per account */
    /** @type {Record<string, any[]>} */
    positions2: {},
    /** every accepted order: { acct, orderId, conid, side, totalSize, remainingQuantity, status, order_ref, parentId, ... } */
    /** @type {any[]} */
    liveOrders: [],
    /** extra /iserver/account/trades rows */
    /** @type {any[]} */
    trades: [],
    /**
     * How the next order POST (and each reply after it) answers, in order: "ok", "pending",
     * { reply: [ids] }, { replies: [[ids], [ids]] }, { partial: { ok, reply } }, { error }, "drop",
     * "hang", { status }, { prompt: true }, { promptObject: true }, "okObject" (one bare object). An empty
     * queue answers "ok".
     */
    /** @type {any[]} */
    placeQueue: [],
    /** fields merged into the order status answer of an order id */
    /** @type {Record<string, Record<string, unknown>>} */
    statusOverride: {},
    /** IBKR's text per question id, over IBKR_MESSAGE_TEXT */
    /** @type {Record<string, string>} */
    messageText: {},
    /** the answer of the next DELETE, instead of the order book's: { status?, body } */
    /** @type {{ status?: number, body: unknown } | null} */
    cancelAnswer: null,
    /** the next order POST is answered this much later (a test can act while it waits) */
    delayNextOrderMs: 0,
    /** called with every request as it arrives */
    /** @type {((r: { method: string, path: string, body: string }) => void) | null} */
    onRequest: null,
    /** @type {Map<string, { acct: string, tickets: any[] }>} */
    pendingReplies: new Map(),
    /** every question object the fake asked, in order */
    /** @type {Array<{ id: string, messageIds: string[] }>} */
    questions: [],
    /** @type {Map<string, number>} cOID -> orderId */
    coids: new Map(),
    nextOrderId: 1370093000,
  };
}

/** @typedef {ReturnType<typeof createGatewayState>} GatewayState */

/** @param {number} n */
const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LIVE_TYPE = /** @type {Record<string, string>} */ ({ MKT: "Market", LMT: "Limit", STP: "Stop", STOP_LIMIT: "Stop Limit" });
const STATUS_TYPE = /** @type {Record<string, string>} */ ({ MKT: "MARKET", LMT: "LIMIT", STP: "STOP", STOP_LIMIT: "STOP_LIMIT" });

/**
 * Records accepted tickets as live orders, like IBKR's book.
 * @param {GatewayState} state @param {string} acct @param {any[]} tickets @param {string} status
 * @returns {any[]} the success items
 */
function accept(state, acct, tickets, status) {
  return tickets.map((t) => {
    const orderId = ++state.nextOrderId;
    if (t.cOID) state.coids.set(String(t.cOID), orderId);
    const parent = t.parentId ? state.coids.get(String(t.parentId)) : undefined;
    state.liveOrders.push({
      acct,
      orderId,
      conid: t.conid,
      ticker: String(state.contractInfo[t.conid]?.symbol ?? t.conid),
      side: t.side,
      totalSize: t.quantity,
      filledQuantity: 0,
      remainingQuantity: t.quantity,
      orderType: LIVE_TYPE[t.orderType] ?? t.orderType,
      price: t.price,
      auxPrice: t.auxPrice,
      timeInForce: t.tif,
      status,
      ...(t.cOID ? { order_ref: t.cOID } : {}),
      ...(parent !== undefined ? { parentId: parent } : {}),
      ticket: t,
      lastExecutionTime_r: state.now(),
    });
    return { order_id: String(orderId), order_status: status, encrypt_message: "1" };
  });
}

/** @param {GatewayState} state @param {string[]} ids */
function question(state, ids) {
  const id = randomUUID();
  state.questions.push({ id, messageIds: ids });
  const message = ids.map((m) => state.messageText[m] ?? IBKR_MESSAGE_TEXT[/** @type {keyof typeof IBKR_MESSAGE_TEXT} */ (m)] ?? `IBKR message ${m}`);
  return { id, message, isSuppressed: false, messageIds: ids };
}

/**
 * Answers one queue entry for the tickets of an order POST (or of a reply).
 * @param {GatewayState} state @param {any} entry @param {string} acct @param {any[]} tickets
 * @param {(status: number, json: unknown) => void} send
 * @param {http.IncomingMessage} req
 */
function respondOrder(state, entry, acct, tickets, send, req) {
  /** @param {string[]} ids @param {any[]} covered */
  const ask = (ids, covered) => {
    const q = question(state, ids);
    state.pendingReplies.set(q.id, { acct, tickets: covered });
    return q;
  };
  if (entry === "ok" || entry === "pending") {
    const items = accept(state, acct, tickets, entry === "ok" ? "Submitted" : "PendingSubmit");
    return send(200, items.length > 1 ? [...items].reverse() : items);
  }
  if (entry === "okObject") {
    // IBKR's reply acknowledgement as its guide shows it: one bare object, not an array.
    const items = accept(state, acct, tickets, "Submitted");
    return send(200, items[0]);
  }
  if (entry === "drop") {
    accept(state, acct, tickets, "Submitted");
    req.socket.destroy();
    return;
  }
  if (entry === "hang") return;
  if (entry?.status) return send(entry.status, { error: "Service Unavailable" });
  if (entry?.error) return send(200, { error: entry.error });
  if (entry?.reply) return send(200, [ask(entry.reply, tickets)]);
  if (entry?.replies) {
    const list = /** @type {string[][]} */ (entry.replies);
    return send(
      200,
      list.map((ids, i) => ask(ids, i === list.length - 1 ? tickets.slice(i) : tickets.slice(i, i + 1))),
    );
  }
  if (entry?.partial) {
    const items = accept(state, acct, tickets.slice(0, entry.partial.ok), "Submitted");
    return send(200, [...items, ask(entry.partial.reply, tickets.slice(entry.partial.ok))]);
  }
  if (entry?.prompt || entry?.promptObject) {
    const items = accept(state, acct, tickets, "PendingSubmit");
    const p = {
      orderId: Number(items[0].order_id),
      reqId: "22170",
      prompt: true,
      messageId: "p12",
      options: ["Use on this order", "Always use", "Do not use"],
      text: "Your order is subject to the price management algo.",
      type: "M",
      dismissable: false,
    };
    return send(200, entry.prompt ? [p] : p);
  }
  return send(500, { error: `fake: unknown queue entry ${JSON.stringify(entry)}` });
}

/**
 * The pacing check of the two paced paths, per gateway (IBKR paces per session). Counts every
 * violation; refuses it when enforcePacing.
 * @param {GatewayState} state @param {string} key
 */
function pacingRefused(state, key) {
  const t = state.now();
  const last = state.pacedAt[key];
  if (last !== undefined && t - last < 5_000) {
    state.pacingViolations += 1;
    if (state.enforcePacing) return true;
  }
  state.pacedAt[key] = t;
  return false;
}

/**
 * @param {GatewayState} state
 * @param {number} port this gateway's port
 * @returns {http.RequestListener}
 */
function handler(state, port) {
  return (req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://gw.invalid");
      const p = url.pathname;
      const raw = Buffer.concat(chunks);
      const body = raw.toString();
      state.requests.push({ method: req.method ?? "", path: `${p}${url.search}`, body, bodyLength: raw.length, at: state.now(), headers: req.headers });
      state.onRequest?.({ method: req.method ?? "", path: `${p}${url.search}`, body });
      /** @param {number} status @param {unknown} json */
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      /** @type {any} */
      let parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        parsed = null;
      }
      if (req.method === "POST" && req.headers["content-length"] === undefined) {
        res.writeHead(411, { "content-type": "text/html" });
        return res.end("<HTML><TITLE>Bad Request</TITLE></HTML>");
      }
      if (p === "/") {
        res.writeHead(302, { location: "/sso/Login?forwardTo=22&RL=1&ip2loc=US" });
        return res.end();
      }
      if (p === "/sso/Login") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "JSESSIONID=J; Path=/sso; HttpOnly;Secure;SameSite=None" });
        return res.end('<html><title>Login</title><div class="loginformWrapper"></div></html>');
      }
      if (!p.startsWith("/v1/api/")) return send(404, { error: "no" });
      const api = p.slice("/v1/api".length);
      if (api === "/tickle") return send(state.loggedIn ? 200 : 401, state.loggedIn ? { session: "x", iserver: { authStatus: { authenticated: state.bridge } } } : undefined);
      if (api === "/iserver/auth/status") {
        if (!state.loggedIn) return send(401, undefined);
        return send(200, { authenticated: !state.competing, competing: state.competing, connected: true, message: "", MAC: "00:00", serverInfo: {} });
      }
      if (!state.loggedIn) return send(401, undefined);
      if (api === "/iserver/auth/ssodh/init") {
        state.bridge = true;
        if (state.preflight) state.preflightPending.add(String(port));
        return send(200, { authenticated: true, competing: false, connected: true });
      }
      if (api === "/logout") {
        state.loggedIn = false;
        state.bridge = false;
        return send(200, { status: true });
      }
      if (api === "/iserver/accounts") {
        if (!state.bridge) return send(400, { error: "no bridge" });
        return send(200, {
          accounts: state.accounts,
          aliases: { U7654321: "Swing" },
          selectedAccount: state.accounts[0],
          acctProps: Object.fromEntries(state.accounts.map((a) => [a, { hasChildAccounts: false, supportsCashQty: true, supportsFractions: false, allowCustomerTime: false, ...(state.acctProps[a] ?? {}) }])),
          ...(state.isPaper === undefined ? {} : { isPaper: state.isPaper }),
        });
      }
      if (api === "/portfolio/accounts") {
        return send(200, state.accounts.map((id) => ({ id, accountId: id, accountAlias: null, desc: id, type: "INDIVIDUAL", tradingType: id === "U1234567" ? "STKMRGN" : "STKCASH", currency: "USD" })));
      }
      let m = /^\/portfolio\/([^/]+)\/summary$/.exec(api);
      if (m) {
        if (state.failSummary.has(m[1])) return send(500, { error: "internal" });
        return send(200, {
          netliquidation: { amount: m[1] === "U1234567" ? 250000.5 : 10000, currency: "USD" },
          buyingpower: { amount: 1000000 },
          totalcashvalue: { amount: 50000 },
        });
      }
      m = /^\/portfolio\/([^/]+)\/positions\/(\d+)$/.exec(api);
      if (m) {
        if (m[1] !== "U1234567") return send(200, []);
        const page = Number(m[2]);
        return send(200, page === 0 ? positions(30, m[1]) : page === 1 ? positions(2, m[1], 30) : []);
      }
      m = /^\/portfolio2\/([^/]+)\/positions$/.exec(api);
      if (m) return send(200, state.positions2[m[1]] ?? []);
      if (api === "/iserver/account/pnl/partitioned") return send(200, { upnl: { "U1234567.Core": { rowType: 1, dpl: 812.5, nl: 250000.5, upl: 1500 } } });
      if (api === "/iserver/account/orders") {
        if (!state.bridge) return send(400, { error: "no bridge" });
        if (pacingRefused(state, `${port}:orders`)) return send(429, { error: "Too Many Requests" });
        const forced = state.ordersQueue.shift();
        if (forced) return send(forced.status ?? 200, forced.body ?? { orders: [] });
        if (state.preflightPending.delete(String(port))) return send(200, { orders: [] });
        return send(200, {
          orders: [...BASE_ORDERS(), ...state.liveOrders.map(({ ticket: _t, ...o }) => o)],
          snapshot: true,
        });
      }
      if (api === "/iserver/account/trades") {
        if (pacingRefused(state, `${port}:trades`)) return send(429, { error: "Too Many Requests" });
        return send(200, [...BASE_TRADES(), ...state.trades]);
      }
      if (api === "/trsrv/stocks") {
        const sym = url.searchParams.get("symbols") ?? "";
        return send(200, { [sym]: state.contracts[sym] ?? [] });
      }
      m = /^\/iserver\/contract\/(\d+)\/info$/.exec(api);
      if (m) {
        const info = state.contractInfo[m[1]];
        return info ? send(200, info) : send(400, { error: "Bad Request: no such contract" });
      }
      if (api === "/iserver/contract/rules") {
        return send(200, {
          algoEligible: true,
          canTradeAcctIds: state.accounts,
          orderTypes: ["limit", "midprice", "market", "stop", "stop_limit", "mit", "lit", "trailing_stop", "trailing_stop_limit", "relative"],
          orderTypesOutside: ["limit", "stop_limit", "lit", "trailing_stop_limit", "relative"],
          tifTypes: ["DAY/o,a", "GTC/o,a"],
          increment: 0.01,
          incrementDigits: 2,
          incrementRules: [{ lowerEdge: 0, increment: 0.01 }],
          sizeIncrement: 1,
          forceOrderPreview: false,
          error: null,
          ...state.rulesPatch,
        });
      }
      if (api === "/iserver/marketdata/snapshot") {
        const conid = url.searchParams.get("conids") ?? "";
        if (!state.snapshotSeen.has(conid)) {
          state.snapshotSeen.add(conid);
          return send(200, [{ conid: Number(conid), conidEx: conid }]);
        }
        return send(200, [{ conid: Number(conid), conidEx: conid, ...(state.snapshot[conid] ?? {}) }]);
      }
      m = /^\/iserver\/account\/([^/]+)\/orders\/whatif$/.exec(api);
      if (m) {
        const t = parsed?.orders?.[0] ?? {};
        const price = typeof t.price === "number" && t.orderType === "LMT" ? t.price : state.lastPrice;
        const amount = price * Number(t.quantity ?? 0);
        return send(200, {
          amount: { amount: `${money(amount)} USD (${t.quantity} Shares)`, commission: "1 USD", total: `${money(amount + 1)} USD` },
          equity: { current: "215,415,594", change: "-1", after: "215,415,593" },
          position: { current: "0", change: String(t.quantity), after: String(t.quantity) },
          warn: state.whatifWarn,
          error: state.whatifError,
        });
      }
      m = /^\/iserver\/account\/([^/]+)\/orders$/.exec(api);
      if (m && req.method === "POST") {
        const entry = state.placeQueue.length ? state.placeQueue.shift() : "ok";
        const acct = m[1];
        const tickets = Array.isArray(parsed?.orders) ? parsed.orders : [];
        const delay = state.delayNextOrderMs;
        state.delayNextOrderMs = 0;
        if (delay > 0) return void setTimeout(() => respondOrder(state, entry, acct, tickets, send, req), delay);
        return respondOrder(state, entry, acct, tickets, send, req);
      }
      m = /^\/iserver\/reply\/([0-9a-fA-F-]+)$/.exec(api);
      if (m && req.method === "POST") {
        const pending = state.pendingReplies.get(m[1]);
        if (!pending) return send(200, { error: `reply id not found: '${m[1]}'` });
        state.pendingReplies.delete(m[1]);
        if (parsed?.confirmed !== true) return send(200, { error: "Order not confirmed " });
        const entry = state.placeQueue.length ? state.placeQueue.shift() : "ok";
        return respondOrder(state, entry, pending.acct, pending.tickets, send, req);
      }
      m = /^\/iserver\/account\/order\/status\/(\d+)$/.exec(api);
      if (m) {
        const o = state.liveOrders.find((x) => String(x.orderId) === m?.[1]);
        if (!o) return send(503, { error: "Service Unavailable" });
        const t = o.ticket;
        /** @type {Record<string, unknown>} */
        const out = {
          order_id: o.orderId,
          conid: o.conid,
          symbol: o.ticker,
          side: o.side === "BUY" ? "B" : "S",
          total_size: String(o.totalSize),
          order_type: STATUS_TYPE[t.orderType] ?? t.orderType,
          order_status: o.status,
          account: o.acct,
          tif: t.tif,
        };
        if (t.orderType === "LMT" || t.orderType === "STOP_LIMIT") out.limit_price = String(t.price);
        if (t.orderType === "STP") out.stop_price = String(t.price);
        if (t.orderType === "STOP_LIMIT") out.stop_price = String(t.auxPrice);
        return send(200, { ...out, ...(state.statusOverride[m[1]] ?? {}) });
      }
      m = /^\/iserver\/account\/([^/]+)\/order\/(-?\d+)$/.exec(api);
      if (m && req.method === "DELETE") {
        if (state.cancelAnswer) {
          const a = state.cancelAnswer;
          state.cancelAnswer = null;
          return send(a.status ?? 200, a.body);
        }
        const o = state.liveOrders.find((x) => String(x.orderId) === m?.[2] && x.acct === m?.[1]);
        if (!o) return send(200, { error: `OrderID ${m[2]} doesn't exist` });
        o.status = "PendingCancel";
        return send(200, { msg: "Request was submitted", order_id: o.orderId, conid: o.conid, account: o.acct });
      }
      return send(404, { error: `no route ${api}` });
    });
  };
}

/**
 * `spawn` replacement: listens on the port from <cwd>/conf.yaml and behaves like a gateway.
 * @param {ReturnType<typeof createGatewayState>} state
 */
export function fakeGatewaySpawner(state) {
  let pid = 5000;
  /** @param {string} _cmd @param {string[]} _args @param {{ cwd: string }} opts */
  return (_cmd, _args, opts) => {
    const conf = readFileSync(path.join(opts.cwd, "conf.yaml"), "utf8");
    const port = Number(/listenPort:\s*(\d+)/.exec(conf)?.[1]);
    const p = /** @type {any} */ (new EventEmitter());
    p.pid = ++pid;
    p.port = port;
    p.exitCode = null;
    p.signalCode = null;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    const server = http.createServer(handler(state, port));
    server.on("error", (e) => p.emit("error", e));
    server.listen(port, "127.0.0.1", () => p.emit("spawn"));
    /** @param {number | null} code @param {string | null} sig */
    const exit = (code, sig) => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      server.closeAllConnections();
      server.close(() => {
        p.exitCode = code;
        p.signalCode = sig;
        p.emit("exit", code, sig);
      });
    };
    p.kill = (/** @type {string} */ sig = "SIGTERM") => {
      if (state.exitDelayMs) setTimeout(() => exit(null, sig), state.exitDelayMs);
      else exit(null, sig);
      return true;
    };
    p.crash = () => exit(1, null);
    state.procs.push(p);
    return p;
  };
}

/**
 * Two adjacent free ports for the slot range.
 * @returns {Promise<number[]>}
 */
export async function freePorts(count = 2) {
  const net = await import("node:net");
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const ports = Array.from({ length: count }, (_, i) => base + i);
    const ok = await Promise.all(
      ports.map(
        (port) =>
          new Promise((resolve) => {
            const s = net.createServer();
            s.once("error", () => resolve(false));
            s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
          }),
      ),
    );
    if (ok.every(Boolean)) return ports;
  }
  throw new Error("no free ports");
}
