import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake Alpaca for tests: three listeners, `live` and `paper` like api.alpaca.markets and
 * paper-api.alpaca.markets, and `data` like data.alpaca.markets (quotes, for live and paper keys).
 * Each account belongs to one trading host and has one key pair, sent in the APCA-API-KEY-ID and
 * APCA-API-SECRET-KEY headers.
 *
 * - An unknown pair answers 401; a pair of the other host answers 403 (`wrongHostStatus`).
 * - Money and quantities are JSON strings, as Alpaca sends them. Account numbers start with "PA" on
 *   paper accounts and are digits on live ones.
 * - GET /v2/orders: status (open | closed | all, default open), symbols (comma list), limit (default
 *   50, max 500), direction, after / until (exclusive, on submitted_at), nested (legs under the parent).
 * - GET /v2/account/activities/FILL: direction, after, page_size (max 100), page_token (the id of
 *   the last activity of the previous page).
 * - Order entry: POST /v2/orders (Alpaca's 422 messages for a bad body, client_order_id unique among
 *   every order ever, 403 for buying power and for a sell above the free quantity, brackets with two
 *   `held` legs and group_role), GET /v2/orders/{id}, GET /v2/orders:by_client_order_id,
 *   DELETE /v2/orders/{id} (204, or 422 when the order is not cancelable; a bracket cancels as a group),
 *   GET /v2/assets/{sym} (from the account's `assets`), GET /v2/clock (`state.clock`),
 *   GET /v2/positions/{asset_id} (404 when there is none), and on the data host
 *   GET /v2/stocks/{sym}/quotes/latest (`state.quotes`; feed=sip answers Alpaca's 403 for the plan).
 * - Knobs: regenerate() (the old pair answers 401), setStatus(), forbid() a path for one account,
 *   failNext (an answer for the next matching request: { status } such as a 429 with
 *   X-Ratelimit-Reset or a 503; { accept: true, status } does the request and then answers the status;
 *   { drop: true } does the request and destroys the socket without an answer), `echo` (fields merged
 *   into the next POST /v2/orders answer only, not into the stored order).
 * Every request is recorded (host, method, path, query: no header, so no key); a request that is
 * not a GET is counted in `nonGet`, and every POST /v2/orders body is kept in `posts`.
 */

/**
 * @typedef {"live" | "paper"} Host
 * @typedef {"live" | "paper" | "data"} Listener
 * @typedef {{
 *   id: string, accountNumber: string, host: Host, keyId: string, secret: string, status: string,
 *   multiplier: string, cash: string, equity: string, lastEquity: string, buyingPower: string,
 *   positions: any[], orders: any[], fills: any[], assets: any[], flags: Record<string, unknown>,
 *   forbidden: Set<string>,
 * }} FakeAccount
 *   assets: GET /v2/assets/{symbol} answers (with id, symbol, name, exchange, class, tradable, status).
 *   flags: fields merged into GET /v2/account (trading_blocked, account_blocked, trade_suspended_by_user).
 * @typedef {{
 *   host?: Listener, path?: string, method?: string, status?: number, resetInSec?: number, body?: unknown,
 *   drop?: boolean, accept?: boolean,
 * }} FailRule
 *   method: default "GET".
 * @typedef {{ status: number, body?: unknown, headers?: Record<string, string> }} Answer
 */

const OPEN = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding", "pending_replace", "pending_cancel", "stopped", "calculated", "suspended"]);
const DAY = 24 * 3_600_000;

/** A key pair shaped like Alpaca's (live "AK…", paper "PK…"). @param {Host} host */
export function newKeyPair(host) {
  return {
    keyId: `${host === "paper" ? "PK" : "AK"}${randomBytes(9).toString("hex").toUpperCase()}`,
    secret: randomBytes(30).toString("base64url"),
  };
}

/**
 * An asset record as GET /v2/assets/{symbol} answers it (a tradable NASDAQ stock unless `over` says
 * otherwise).
 * @param {string} symbol
 * @param {Record<string, unknown>} [over]
 */
export function fakeAsset(symbol, over = {}) {
  return {
    id: randomUUID(),
    class: "us_equity",
    exchange: "NASDAQ",
    symbol,
    name: `${symbol} Inc. Common Stock`,
    status: "active",
    tradable: true,
    marginable: true,
    shortable: true,
    easy_to_borrow: true,
    fractionable: true,
    attributes: [],
    ...over,
  };
}

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} v */
const n = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
/** @param {number} p */
const subPenny = (p) => Math.abs(Math.round(p * (p >= 1 ? 100 : 10_000)) - p * (p >= 1 ? 100 : 10_000)) > 1e-6;

export async function startFakeAlpaca() {
  /** @type {FakeAccount[]} */
  const accounts = [];
  const state = {
    accounts,
    /** @type {Array<{ host: Listener, method: string, path: string, query: Record<string, string> }>} */
    calls: [],
    nonGet: 0,
    wrongHostStatus: 403,
    /** The clock X-Ratelimit-Reset and order times are measured on (set it to the service's test clock). */
    now: () => Date.now(),
    /** @type {FailRule[]} */
    failNext: [],
    /** GET /v2/clock */
    clock: { timestamp: "", is_open: true, next_open: "2026-11-23T14:30:00Z", next_close: "2026-11-20T21:00:00Z" },
    /** @type {Record<string, { bp?: number, ap?: number, t?: string }>} symbol -> latest IEX quote */
    quotes: {},
    /** @type {Array<{ host: Listener, body: any }>} every POST /v2/orders body, as sent */
    posts: [],
    /** @type {Record<string, unknown> | null} merged into the next POST /v2/orders answer only */
    echo: null,
    /** Every client_order_id ever used (Alpaca refuses a second order with one). */
    clientIds: new Set(),
    /**
     * Called with every request as it arrives, before it is answered (a test can change the account).
     * @type {((r: { host: Listener, method: string, path: string, query: Record<string, string> }) => void) | null}
     */
    onRequest: /** @type {((r: { host: Listener, method: string, path: string, query: Record<string, string> }) => void) | null} */ (null),
  };

  /** @param {import("node:http").ServerResponse} res @param {Answer} a */
  const send = (res, a) => {
    if (a.status === 204) {
      res.writeHead(204, a.headers ?? {});
      res.end();
      return;
    }
    res.writeHead(a.status, { "content-type": "application/json", "x-request-id": randomBytes(8).toString("hex"), ...(a.headers ?? {}) });
    res.end(JSON.stringify(a.body ?? null));
  };

  /** @param {FakeAccount} a */
  const accountJson = (a) => ({
    id: a.id,
    account_number: a.accountNumber,
    status: a.status,
    crypto_status: "ACTIVE",
    currency: "USD",
    buying_power: a.buyingPower,
    regt_buying_power: a.buyingPower,
    cash: a.cash,
    portfolio_value: a.equity,
    equity: a.equity,
    last_equity: a.lastEquity,
    multiplier: a.multiplier,
    pattern_day_trader: false,
    trading_blocked: false,
    transfers_blocked: false,
    account_blocked: false,
    trade_suspended_by_user: false,
    shorting_enabled: true,
    created_at: "2024-01-02T15:00:00.000Z",
    ...a.flags,
  });

  /** @param {any} o */
  const flatten = (o) => [o, ...(Array.isArray(o.legs) ? o.legs : [])];
  /** Every order of an account, legs on their own (the stored objects). @param {FakeAccount} a */
  const allOrders = (a) => a.orders.flatMap(flatten);

  /**
   * @param {FakeAccount} a
   * @param {URLSearchParams} q
   */
  function listOrders(a, q) {
    const status = q.get("status") ?? "open";
    const limit = Math.min(500, Number(q.get("limit") ?? 50) || 50);
    const after = q.get("after") ? Date.parse(String(q.get("after"))) : null;
    const until = q.get("until") ? Date.parse(String(q.get("until"))) : null;
    const asc = q.get("direction") === "asc";
    const nested = q.get("nested") === "true";
    const symbols = q.get("symbols") ? new Set(String(q.get("symbols")).split(",").map((s) => s.trim().toUpperCase())) : null;
    let list = nested ? a.orders : a.orders.flatMap(flatten).map((o) => ({ ...o, legs: null }));
    list = list.filter((o) => {
      const t = Date.parse(o.submitted_at);
      if (after !== null && !(t > after)) return false;
      if (until !== null && !(t < until)) return false;
      if (symbols && !symbols.has(String(o.symbol).toUpperCase())) return false;
      if (status === "open") return OPEN.has(o.status);
      if (status === "closed") return !OPEN.has(o.status);
      return true;
    });
    list.sort((x, y) => (Date.parse(y.submitted_at) - Date.parse(x.submitted_at)) * (asc ? -1 : 1) || (x.id < y.id ? 1 : -1));
    return list.slice(0, limit);
  }

  /**
   * @param {FakeAccount} a
   * @param {URLSearchParams} q
   */
  function listFills(a, q) {
    const size = Math.min(100, Number(q.get("page_size") ?? 100) || 100);
    const after = q.get("after") ? Date.parse(String(q.get("after"))) : null;
    let list = a.fills.filter((f) => after === null || Date.parse(f.transaction_time) > after);
    list.sort((x, y) => Date.parse(y.transaction_time) - Date.parse(x.transaction_time) || (x.id < y.id ? 1 : -1));
    const token = q.get("page_token");
    if (token) {
      const i = list.findIndex((f) => f.id === token);
      list = i >= 0 ? list.slice(i + 1) : [];
    }
    return list.slice(0, size);
  }

  /** @param {string} message @returns {Answer} */
  const unprocessable = (message) => ({ status: 422, body: { code: 40010001, message } });

  /**
   * POST /v2/orders, with Alpaca's checks in Alpaca's words.
   * @param {FakeAccount} a
   * @param {any} b
   * @returns {Answer}
   */
  function createOrder(a, b) {
    if (!isObj(b)) return unprocessable("request body format is invalid");
    const symbol = String(b.symbol ?? "").toUpperCase();
    const asset = a.assets.find((x) => x.symbol === symbol);
    if (!asset) return unprocessable(`asset "${symbol}" not found`);
    if (b.qty === undefined && b.notional === undefined) return unprocessable("qty or notional is required");
    const qty = n(b.qty);
    if (!(qty > 0)) return unprocessable("qty must be > 0");
    const side = String(b.side ?? "");
    if (side !== "buy" && side !== "sell") return unprocessable("invalid side");
    const type = String(b.type ?? "");
    if (!["market", "limit", "stop", "stop_limit"].includes(type)) return unprocessable("invalid order type");
    const tif = String(b.time_in_force ?? "");
    if (!["day", "gtc", "opg", "cls", "ioc", "fok"].includes(tif)) return unprocessable("invalid time_in_force");
    const limit = n(b.limit_price);
    const stop = n(b.stop_price);
    if (type === "market" && (!Number.isNaN(limit) || !Number.isNaN(stop))) return unprocessable("market orders require no stop or limit price");
    if (type === "limit" && Number.isNaN(limit)) return unprocessable("limit orders require a limit price");
    if (type === "stop" && Number.isNaN(stop)) return unprocessable("stop orders require a stop price");
    if (type === "stop_limit" && (Number.isNaN(stop) || Number.isNaN(limit))) return unprocessable("stop limit orders require both stop and limit price");
    for (const [name, p] of /** @type {Array<[string, number]>} */ ([["limit_price", limit], ["stop_price", stop]])) {
      if (!Number.isNaN(p) && subPenny(p)) return unprocessable(`invalid ${name} ${p}. sub-penny increment does not fulfill minimum pricing criteria`);
    }
    const cid = b.client_order_id === undefined ? randomUUID() : String(b.client_order_id);
    if (cid.length > 128) return unprocessable("client_order_id must be no more than 128 characters");
    if (state.clientIds.has(cid)) return unprocessable("client_order_id must be unique");

    const quote = state.quotes[symbol];
    const market = quote ? (quote.bp && quote.ap ? (quote.bp + quote.ap) / 2 : quote.ap ?? quote.bp ?? NaN) : NaN;
    const bracket = b.order_class === "bracket";
    const tp = n(b.take_profit?.limit_price);
    const sl = n(b.stop_loss?.stop_price);
    const slLimit = n(b.stop_loss?.limit_price);
    if (bracket) {
      if (Number.isNaN(tp) || Number.isNaN(sl)) return unprocessable("bracket orders require take_profit.limit_price and stop_loss.stop_price");
      if (b.extended_hours === true) return unprocessable("extended hours order must be DAY or GTC limit orders, not bracket orders");
      if (type !== "market" && type !== "limit") return unprocessable("invalid order type for bracket orders");
      const base = type === "limit" ? limit : market;
      if (side === "buy") {
        if (!(tp > sl)) return unprocessable("take_profit.limit_price must be higher than stop_loss.stop_price");
        if (!Number.isNaN(base) && sl > base - 0.01 + 1e-9) return unprocessable("stop_loss.stop_price must be <= base_price - 0.01");
        if (!Number.isNaN(base) && tp < base + 0.01 - 1e-9) return unprocessable("take_profit.limit_price must be >= base_price + 0.01");
      }
    }

    if (side === "buy") {
      const price = !Number.isNaN(limit) ? limit : !Number.isNaN(stop) ? stop : Number.isNaN(market) ? 0 : quote?.ap ?? market;
      const cost = qty * price;
      if (cost > Number(a.buyingPower)) {
        return { status: 403, body: { code: 40310000, message: "insufficient buying power", buying_power: a.buyingPower, cost_basis: cost.toFixed(2) } };
      }
    } else {
      const pos = a.positions.find((p) => String(p.symbol).toUpperCase() === symbol);
      const long = pos && String(pos.side).toLowerCase() !== "short" ? Math.abs(Number(pos.qty)) : 0;
      const held = allOrders(a)
        .filter((o) => OPEN.has(o.status) && String(o.symbol).toUpperCase() === symbol && o.side === "sell")
        .reduce((s, o) => s + Math.max(0, Number(o.qty) - Number(o.filled_qty ?? 0)), 0);
      const free = Math.max(0, long - held);
      if (qty > free) {
        return {
          status: 403,
          body: { code: 40310000, message: `insufficient qty available for order (requested: ${qty}, available: ${free})`, available: String(free), existing_qty: String(long), held_for_orders: String(held), symbol },
        };
      }
    }

    const t = state.now();
    const at = new Date(t).toISOString();
    const base = {
      created_at: at,
      updated_at: at,
      submitted_at: at,
      filled_at: null,
      expired_at: null,
      canceled_at: null,
      failed_at: null,
      replaced_at: null,
      replaced_by: null,
      replaces: null,
      expires_at: tif === "gtc" ? new Date(t + 90 * DAY).toISOString() : new Date(t + DAY).toISOString(),
      asset_id: asset.id,
      symbol,
      asset_class: "us_equity",
      notional: null,
      qty: String(qty),
      filled_qty: "0",
      filled_avg_price: null,
      time_in_force: tif,
      extended_hours: b.extended_hours === true,
      trail_percent: null,
      trail_price: null,
      hwm: null,
      legs: null,
    };
    /** @type {any} */
    const order = {
      ...base,
      id: randomUUID(),
      client_order_id: cid,
      order_class: bracket ? "bracket" : "",
      order_type: type,
      type,
      side,
      position_intent: side === "buy" ? "buy_to_open" : "sell_to_close",
      limit_price: Number.isNaN(limit) ? null : String(b.limit_price),
      stop_price: Number.isNaN(stop) ? null : String(b.stop_price),
      status: "accepted",
    };
    if (bracket) {
      const group = randomUUID();
      const exit = side === "buy" ? "sell" : "buy";
      order.group_id = group;
      order.group_role = "entry";
      order.legs = [
        { ...base, id: randomUUID(), client_order_id: randomUUID(), order_class: "bracket", order_type: "limit", type: "limit", side: exit, position_intent: "sell_to_close", limit_price: String(b.take_profit.limit_price), stop_price: null, status: "held", group_id: group, group_role: "take_profit" },
        {
          ...base,
          id: randomUUID(),
          client_order_id: randomUUID(),
          order_class: "bracket",
          order_type: Number.isNaN(slLimit) ? "stop" : "stop_limit",
          type: Number.isNaN(slLimit) ? "stop" : "stop_limit",
          side: exit,
          position_intent: "sell_to_close",
          limit_price: Number.isNaN(slLimit) ? null : String(b.stop_loss.limit_price),
          stop_price: String(b.stop_loss.stop_price),
          status: "held",
          group_id: group,
          group_role: "stop_loss",
        },
      ];
    }
    for (const o of flatten(order)) state.clientIds.add(o.client_order_id);
    a.orders.push(order);
    const answer = { ...structuredClone(order), ...(state.echo ?? {}) };
    state.echo = null;
    return { status: 200, body: answer };
  }

  /**
   * DELETE /v2/orders/{id}: 204 when it can be cancelled (the rest of its bracket goes with it).
   * @param {FakeAccount} a @param {string} id
   * @returns {Answer}
   */
  function cancelOrder(a, id) {
    const o = allOrders(a).find((x) => x.id === id);
    if (!o) return { status: 404, body: { code: 40410000, message: "order not found" } };
    if (!OPEN.has(o.status) || o.status === "pending_replace" || o.status === "pending_cancel") return { status: 422, body: { code: 42210000, message: "order is not cancelable" } };
    const at = new Date(state.now()).toISOString();
    const group = o.group_id ? allOrders(a).filter((x) => x.group_id === o.group_id && OPEN.has(x.status)) : [o];
    for (const x of group) {
      x.status = "canceled";
      x.canceled_at = at;
      x.updated_at = at;
    }
    return { status: 204 };
  }

  /**
   * The answer of a trading host for one request of a known account.
   * @param {FakeAccount} a @param {string} method @param {URL} url @param {any} body
   * @returns {Answer}
   */
  function trading(a, method, url, body) {
    const path = url.pathname;
    const q = url.searchParams;
    if (method === "GET") {
      if (path === "/v2/account") return { status: 200, body: accountJson(a) };
      if (path === "/v2/positions") return { status: 200, body: a.positions };
      if (path === "/v2/orders") return { status: 200, body: listOrders(a, q) };
      if (path === "/v2/account/activities/FILL") return { status: 200, body: listFills(a, q) };
      if (path === "/v2/clock") return { status: 200, body: { ...state.clock, timestamp: state.clock.timestamp || new Date(state.now()).toISOString() } };
      if (path === "/v2/orders:by_client_order_id") {
        const cid = q.get("client_order_id") ?? "";
        const o = a.orders.find((x) => x.client_order_id === cid) ?? allOrders(a).find((x) => x.client_order_id === cid);
        return o ? { status: 200, body: o } : { status: 404, body: { code: 40410000, message: `order not found for ${cid}` } };
      }
      let m = /^\/v2\/orders\/([^/]+)$/.exec(path);
      if (m) {
        const id = m[1];
        const o = a.orders.find((x) => x.id === id) ?? allOrders(a).find((x) => x.id === id);
        return o ? { status: 200, body: o } : { status: 404, body: { code: 40410000, message: "order not found" } };
      }
      m = /^\/v2\/positions\/([^/]+)$/.exec(path);
      if (m) {
        const key = m[1];
        const p = a.positions.find((x) => x.asset_id === key || x.symbol === key);
        return p ? { status: 200, body: p } : { status: 404, body: { code: 40410000, message: "position does not exist" } };
      }
      m = /^\/v2\/assets\/([^/]+)$/.exec(path);
      if (m) {
        const key = m[1];
        const asset = a.assets.find((x) => x.symbol === key || x.id === key);
        return asset ? { status: 200, body: asset } : { status: 404, body: { code: 40410000, message: "asset not found" } };
      }
      return { status: 404, body: { code: 40410000, message: "endpoint not found" } };
    }
    if (method === "POST" && path === "/v2/orders") return createOrder(a, body);
    const del = /^\/v2\/orders\/([^/]+)$/.exec(path);
    if (method === "DELETE" && del) return cancelOrder(a, del[1]);
    return { status: 405, body: { code: 40510000, message: "method not allowed" } };
  }

  /**
   * The data host: the latest IEX quote of one symbol (feed=sip needs a paid plan).
   * @param {URL} url
   * @returns {Answer}
   */
  function data(url) {
    const m = /^\/v2\/stocks\/([^/]+)\/quotes\/latest$/.exec(url.pathname);
    if (!m) return { status: 404, body: { code: 40410000, message: "endpoint not found" } };
    if ((url.searchParams.get("feed") ?? "sip") === "sip") return { status: 403, body: { code: 42210000, message: "subscription does not permit querying recent SIP data" } };
    const sym = m[1];
    const q = state.quotes[sym];
    if (!q) return { status: 404, body: { code: 40410000, message: "no quote found" } };
    return {
      status: 200,
      body: { symbol: sym, quote: { ap: q.ap ?? 0, as: 1, ax: "V", bp: q.bp ?? 0, bs: 1, bx: "V", c: ["R"], t: q.t ?? new Date(state.now()).toISOString(), z: "C" } },
    };
  }

  /** @param {import("node:http").IncomingMessage} req @returns {Promise<any>} */
  const readBody = async (req) => {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const c of req) chunks.push(/** @type {Buffer} */ (c));
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  /** @param {Listener} host @returns {import("node:http").RequestListener} */
  const handler = (host) => async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const method = req.method ?? "GET";
    const call = { host, method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
    state.calls.push(call);
    state.onRequest?.(call);
    if (method !== "GET") state.nonGet += 1;
    const body = method === "GET" ? null : await readBody(req);
    if (method === "POST" && url.pathname === "/v2/orders" && host !== "data") state.posts.push({ host, body });

    const i = state.failNext.findIndex((r) => (!r.host || r.host === host) && (!r.path || r.path === url.pathname) && (r.method ?? "GET").toUpperCase() === method);
    const rule = i >= 0 ? state.failNext.splice(i, 1)[0] : null;
    /** @type {Answer | null} */
    let failure = null;
    if (rule) {
      /** @type {Record<string, string>} */
      const headers = {};
      if (rule.resetInSec !== undefined) headers["x-ratelimit-reset"] = String(Math.floor(state.now() / 1000) + rule.resetInSec);
      const status = rule.status ?? 500;
      failure = { status, headers, body: rule.body ?? { code: status * 100000, message: status === 429 ? "too many requests" : "internal error" } };
      if (!rule.drop && !rule.accept) return send(res, failure);
    }

    const keyId = String(req.headers["apca-api-key-id"] ?? "");
    const secret = String(req.headers["apca-api-secret-key"] ?? "");
    const a = accounts.find((x) => x.keyId === keyId && x.secret === secret);
    /** @type {Answer} */
    let answer;
    if (!a) answer = { status: 401, body: { code: 40110000, message: "request is not authorized" } };
    else if (host === "data") answer = data(url);
    else if (a.host !== host) answer = { status: state.wrongHostStatus, body: { code: 40310000, message: "forbidden" } };
    else if (a.forbidden.has(url.pathname)) answer = { status: 403, body: { code: 40310000, message: "forbidden" } };
    else answer = trading(a, method, url, body);

    if (rule?.drop) {
      req.socket.destroy();
      return;
    }
    send(res, failure ?? answer);
  };

  const live = await listen(handler("live"));
  const paper = await listen(handler("paper"));
  const dataHost = await listen(handler("data"));

  return {
    state,
    urls: { live: live.url, paper: paper.url, data: dataHost.url },

    /**
     * @param {Partial<Omit<FakeAccount, "forbidden">> & { host: Host }} o
     * @returns {FakeAccount}
     */
    addAccount(o) {
      const pair = newKeyPair(o.host);
      /** @type {FakeAccount} */
      const a = {
        id: randomUUID(),
        accountNumber: o.host === "paper" ? `PA${randomBytes(5).toString("hex").toUpperCase()}` : String(randomInt(100_000_000, 999_999_999)),
        status: "ACTIVE",
        multiplier: "1",
        cash: "1000.00",
        equity: "1000.00",
        lastEquity: "1000.00",
        buyingPower: "1000.00",
        positions: [],
        orders: [],
        fills: [],
        assets: [],
        flags: {},
        ...pair,
        ...o,
        forbidden: new Set(),
      };
      accounts.push(a);
      for (const x of a.orders.flatMap(flatten)) if (x.client_order_id) state.clientIds.add(x.client_order_id);
      return a;
    },

    /** The user regenerated the key pair: the old one answers 401. @param {FakeAccount} a */
    regenerate(a) {
      const pair = newKeyPair(a.host);
      a.keyId = pair.keyId;
      a.secret = pair.secret;
      return pair;
    },

    /** @param {FakeAccount} a @param {string} status */
    setStatus(a, status) {
      a.status = status;
    },

    /** @param {FakeAccount} a @param {string} path @param {boolean} [on] */
    forbid(a, path, on = true) {
      if (on) a.forbidden.add(path);
      else a.forbidden.delete(path);
    },

    /** Calls to one path (optionally one listener) so far. @param {string} path @param {Listener} [host] */
    count(path, host) {
      return state.calls.filter((c) => c.path === path && (!host || c.host === host)).length;
    },

    /** Every order of an account, bracket legs on their own. @param {FakeAccount} a */
    orders(a) {
      return allOrders(a);
    },

    async close() {
      await Promise.all([live.close(), paper.close(), dataHost.close()]);
    },
  };
}
