import { randomBytes, randomUUID } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake Alpaca Trading API v2 for tests: two listeners, `live` and `paper`, like
 * api.alpaca.markets and paper-api.alpaca.markets. Each account belongs to one host and has one
 * key pair, sent in the APCA-API-KEY-ID and APCA-API-SECRET-KEY headers.
 *
 * - An unknown pair answers 401; a pair of the other host answers 403 (`wrongHostStatus`).
 * - Money and quantities are JSON strings, as Alpaca sends them.
 * - GET /v2/orders: status (open | closed | all, default open), limit (default 50, max 500),
 *   direction, after / until (exclusive, on submitted_at), nested (legs under the parent).
 * - GET /v2/account/activities/FILL: direction, after, page_size (max 100), page_token (the id of
 *   the last activity of the previous page).
 * - Knobs: regenerate() (the old pair answers 401), setStatus(), forbid() a path for one account,
 *   failNext (an answer for the next matching request: a 429 with X-Ratelimit-Reset, a 503).
 * Every request is recorded (host, method, path, query: no header, so no key); a request that is
 * not a GET is counted in `nonGet`.
 */

/**
 * @typedef {"live" | "paper"} Host
 * @typedef {{
 *   id: string, accountNumber: string, host: Host, keyId: string, secret: string, status: string,
 *   multiplier: string, cash: string, equity: string, lastEquity: string, buyingPower: string,
 *   positions: any[], orders: any[], fills: any[], forbidden: Set<string>,
 * }} FakeAccount
 * @typedef {{ host?: Host, path?: string, status: number, resetInSec?: number, body?: unknown }} FailRule
 */

const OPEN = new Set(["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding", "pending_replace", "pending_cancel", "stopped", "calculated", "suspended"]);

/** A key pair shaped like Alpaca's (live "AK…", paper "PK…"). @param {Host} host */
export function newKeyPair(host) {
  return {
    keyId: `${host === "paper" ? "PK" : "AK"}${randomBytes(9).toString("hex").toUpperCase()}`,
    secret: randomBytes(30).toString("base64url"),
  };
}

export async function startFakeAlpaca() {
  /** @type {FakeAccount[]} */
  const accounts = [];
  const state = {
    accounts,
    /** @type {Array<{ host: Host, method: string, path: string, query: Record<string, string> }>} */
    calls: [],
    nonGet: 0,
    wrongHostStatus: 403,
    /** The clock X-Ratelimit-Reset is measured on (set it to the service's test clock). */
    now: () => Date.now(),
    /** @type {FailRule[]} */
    failNext: [],
  };

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
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
    account_blocked: false,
    created_at: "2024-01-02T15:00:00.000Z",
  });

  /** @param {any} o */
  const flatten = (o) => [o, ...(Array.isArray(o.legs) ? o.legs : [])];

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
    let list = nested ? a.orders : a.orders.flatMap(flatten).map((o) => ({ ...o, legs: null }));
    list = list.filter((o) => {
      const t = Date.parse(o.submitted_at);
      if (after !== null && !(t > after)) return false;
      if (until !== null && !(t < until)) return false;
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

  /** @param {Host} host @returns {import("node:http").RequestListener} */
  const handler = (host) => (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const method = req.method ?? "GET";
    state.calls.push({ host, method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (method !== "GET") {
      state.nonGet += 1;
      return send(res, 405, { code: 40510000, message: "method not allowed" });
    }
    const rule = state.failNext.findIndex((r) => (!r.host || r.host === host) && (!r.path || r.path === url.pathname));
    if (rule >= 0) {
      const [r] = state.failNext.splice(rule, 1);
      /** @type {Record<string, string>} */
      const headers = {};
      if (r.resetInSec !== undefined) headers["x-ratelimit-reset"] = String(Math.floor(state.now() / 1000) + r.resetInSec);
      return send(res, r.status, r.body ?? { code: r.status * 100000, message: r.status === 429 ? "too many requests" : "internal error" }, headers);
    }
    const keyId = String(req.headers["apca-api-key-id"] ?? "");
    const secret = String(req.headers["apca-api-secret-key"] ?? "");
    const a = accounts.find((x) => x.keyId === keyId && x.secret === secret);
    if (!a) return send(res, 401, { code: 40110000, message: "request is not authorized" });
    if (a.host !== host) return send(res, state.wrongHostStatus, { code: 40310000, message: "forbidden" });
    if (a.forbidden.has(url.pathname)) return send(res, 403, { code: 40310000, message: "forbidden" });

    switch (url.pathname) {
      case "/v2/account":
        return send(res, 200, accountJson(a));
      case "/v2/positions":
        return send(res, 200, a.positions);
      case "/v2/orders":
        return send(res, 200, listOrders(a, url.searchParams));
      case "/v2/account/activities/FILL":
        return send(res, 200, listFills(a, url.searchParams));
      default:
        return send(res, 404, { code: 40410000, message: "endpoint not found" });
    }
  };

  const live = await listen(handler("live"));
  const paper = await listen(handler("paper"));

  return {
    state,
    urls: { live: live.url, paper: paper.url },

    /**
     * @param {Partial<Omit<FakeAccount, "forbidden">> & { host: Host }} o
     * @returns {FakeAccount}
     */
    addAccount(o) {
      const pair = newKeyPair(o.host);
      /** @type {FakeAccount} */
      const a = {
        id: randomUUID(),
        accountNumber: `${o.host === "paper" ? "PA" : ""}${randomBytes(5).toString("hex").toUpperCase()}`,
        status: "ACTIVE",
        multiplier: "1",
        cash: "1000.00",
        equity: "1000.00",
        lastEquity: "1000.00",
        buyingPower: "1000.00",
        positions: [],
        orders: [],
        fills: [],
        ...pair,
        ...o,
        forbidden: new Set(),
      };
      accounts.push(a);
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

    /** Calls to one path (optionally one host) so far. @param {string} path @param {Host} [host] */
    count(path, host) {
      return state.calls.filter((c) => c.path === path && (!host || c.host === host)).length;
    },

    async close() {
      await Promise.all([live.close(), paper.close()]);
    },
  };
}
