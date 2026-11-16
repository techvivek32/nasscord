import { randomBytes } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake Tradier Brokerage on two local ports, close to what Tradier does:
 *
 * Live (`live`): the OAuth endpoints and the API. Sandbox (`sandbox`): the API only (Tradier
 * documents OAuth for Live only). Tokens of one host answer 401 on the other.
 *
 * OAuth (partners only, Live host)
 * - GET /v1/oauth/authorize?client_id&scope&state: a redirect_uri parameter is refused (Tradier
 *   uses the URI registered with the client), as is an unknown client. Otherwise 302 to the
 *   registered callback with code and state. `deny` answers error=access_denied.
 * - POST /v1/oauth/accesstoken: HTTP Basic with the client id and secret, form body
 *   grant_type=authorization_code&code. A redirect_uri in the body is refused. Codes are single use
 *   and live 10 minutes on the fake clock. Access tokens live 24 hours (expires_in 86399); a
 *   refresh_token is sent only with `refreshTokens`.
 * - POST /v1/oauth/refreshtoken: HTTP Basic, grant_type=refresh_token. Without `refreshTokens` it
 *   answers 401. Refresh tokens do not expire; the same one comes back.
 *
 * API (Bearer token, Accept: application/json; XML otherwise, as Tradier does)
 * - GET /v1/user/profile, /v1/accounts/{n}/balances|positions|orders|history, /v1/markets/quotes.
 * - /orders and /history page as Tradier does: `limit` items a page (25 when no limit is sent),
 *   `page` from 1.
 * - Collections are collapsed as Tradier's XML-to-JSON does: one item is a bare object, none is
 *   the string "null".
 * - `quota`: the next matching calls answer HTTP 400 "Quota Violation: Expires <ms>" (plain/text)
 *   with X-Ratelimit-Expiry, before the token is even looked at.
 * - `failQuotes`: the next quotes calls answer 503.
 * - `forbid`: paths that answer 403 for a working token (a scope or one account refused).
 * - Anything else is 404 and stays in `calls`.
 *
 * Every request is recorded with its host, method, path and query (test memory only).
 */

const DAY = 24 * 3_600_000;
export const CLIENT = Object.freeze({ id: "tradier-partner-client-id", secret: "tradier-partner-client-secret" });
export const CALLBACK = "http://localhost:3000/api/broker/callback/tradier";

/**
 * @typedef {{
 *   number: string,
 *   classification: string,
 *   type: "margin" | "cash" | "pdt",
 *   status: "active" | "closed",
 *   balances: Record<string, unknown>,
 *   positions: any[],
 *   orders: (now: number) => any[],
 *   history: (now: number) => any[],
 * }} FakeAccount
 * @typedef {{ id: string, name: string, accounts: FakeAccount[] }} FakeLogin
 * @typedef {"live" | "sandbox"} Host
 */

/** "YYYY-MM-DDT00:00:00Z" of the New York date `days` from `now` (as Tradier writes history dates). */
function nyDate(/** @type {number} */ now, /** @type {number} */ days) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The default Live login: a margin account with stock and options, a Roth IRA, and a closed account. */
export function defaultLogin() {
  /** @type {FakeLogin} */
  const login = {
    id: "id-tradier-owner",
    name: "Pat Example",
    accounts: [
      {
        number: "6YA00001",
        classification: "individual",
        type: "margin",
        status: "active",
        balances: {
          account_number: "6YA00001",
          account_type: "margin",
          total_equity: 25_340.5,
          total_cash: 10_000.25,
          market_value: 15_340.25,
          open_pl: 12.5,
          close_pl: 0,
          margin: { stock_buying_power: 40_000, option_buying_power: 20_000, fed_call: 0, maintenance_call: 0 },
        },
        positions: [
          { id: 101, symbol: "AAPL", quantity: 10, cost_basis: 1_502.5, date_acquired: "2026-10-01T14:00:00.000Z" },
          { id: 102, symbol: "SPY261218C00600000", quantity: -2, cost_basis: -620, date_acquired: "2026-10-02T14:00:00.000Z" },
        ],
        orders: (now) => {
          const at = (/** @type {number} */ ms) => new Date(now - ms).toISOString();
          return [
            {
              id: 1001,
              type: "limit",
              symbol: "AAPL",
              side: "buy",
              quantity: 10,
              status: "filled",
              duration: "day",
              price: 150,
              avg_fill_price: 149.96,
              exec_quantity: 10,
              last_fill_price: 149.96,
              last_fill_quantity: 10,
              remaining_quantity: 0,
              create_date: at(2 * 3_600_000),
              transaction_date: at(2 * 3_600_000 - 1_000),
              class: "equity",
              tag: "my-tag",
            },
            {
              id: 1002,
              type: "stop",
              symbol: "AAPL",
              side: "sell",
              quantity: 5,
              status: "open",
              duration: "gtc",
              stop_price: 140,
              avg_fill_price: 0,
              exec_quantity: 0,
              remaining_quantity: 5,
              create_date: at(3_600_000),
              transaction_date: at(3_600_000),
              class: "equity",
            },
            {
              id: 1003,
              type: "market",
              symbol: "SPY",
              option_symbol: "SPY261218C00600000",
              side: "sell_to_open",
              quantity: 2,
              status: "filled",
              duration: "day",
              avg_fill_price: 3.1,
              exec_quantity: 2,
              create_date: at(90 * 60_000),
              transaction_date: at(89 * 60_000),
              class: "option",
            },
            {
              id: 1004,
              type: "debit",
              symbol: "SPY",
              side: "buy",
              quantity: 1,
              status: "filled",
              duration: "day",
              price: 1.25,
              avg_fill_price: 1.25,
              exec_quantity: 1,
              create_date: at(30 * 60_000),
              transaction_date: at(29 * 60_000),
              class: "multileg",
              num_legs: 2,
              strategy: "spread",
              leg: [
                { id: 1005, type: "limit", symbol: "SPY", option_symbol: "SPY261218C00600000", side: "buy_to_open", quantity: 1, status: "filled", avg_fill_price: 3.5, exec_quantity: 1, class: "option" },
                { id: 1006, type: "limit", symbol: "SPY", option_symbol: "SPY261218C00610000", side: "sell_to_open", quantity: 1, status: "filled", avg_fill_price: 2.25, exec_quantity: 1, class: "option" },
              ],
            },
            { id: 1007, type: "limit", symbol: "MSFT", side: "buy", quantity: 3, status: "pending", duration: "pre", price: 400, exec_quantity: 0, create_date: at(10 * 60_000), class: "equity" },
          ];
        },
        history: (now) => [
          { amount: -1_502.5, date: nyDate(now, -3), type: "trade", trade: { commission: 0, description: "APPLE INC", price: 150.25, quantity: 10, symbol: "AAPL", trade_type: "Equity" } },
          { amount: 618.7, date: nyDate(now, -5), type: "trade", trade: { commission: 1.3, description: "CALL SPY 12/18/26 600", price: 3.1, quantity: -2, symbol: "SPY261218C00600000", trade_type: "Option" } },
          { amount: 12.34, date: nyDate(now, -4), type: "dividend", dividend: { description: "APPLE INC DIV", quantity: 0 } },
          // Today's fill is already in /orders: the history must not count it again.
          { amount: -1_499.6, date: nyDate(now, 0), type: "trade", trade: { commission: 0, price: 149.96, quantity: 10, symbol: "AAPL", trade_type: "Equity" } },
          // Older than the window Nasscord reads.
          { amount: -100, date: nyDate(now, -100), type: "trade", trade: { commission: 0, price: 10, quantity: 10, symbol: "OLD", trade_type: "Equity" } },
        ],
      },
      {
        number: "6YA00002",
        classification: "roth_ira",
        type: "cash",
        status: "active",
        balances: { account_number: "6YA00002", account_type: "cash", total_equity: 5_000, total_cash: 2_950, cash: { cash_available: 2_900, unsettled_funds: 50 } },
        // One position: Tradier sends it as a bare object.
        positions: [{ id: 201, symbol: "MSFT", quantity: 5, cost_basis: 2_000, date_acquired: "2026-09-01T14:00:00.000Z" }],
        orders: () => [],
        // One event: a bare object too.
        history: (now) => [{ amount: -2_000, date: nyDate(now, -7), type: "trade", trade: { commission: 0, price: 400, quantity: 5, symbol: "MSFT", trade_type: "Equity" } }],
      },
      {
        number: "6YA00003",
        classification: "individual",
        type: "cash",
        status: "closed",
        balances: {},
        positions: [],
        orders: () => [],
        history: () => [],
      },
    ],
  };
  return login;
}

/**
 * The Sandbox login of the same person: one paper account, nothing held.
 * @returns {FakeLogin}
 */
export function sandboxLogin() {
  return {
    id: "id-tradier-owner",
    name: "Pat Example",
    accounts: [
      {
        number: "VA00000001",
        classification: "individual",
        type: "margin",
        status: "active",
        balances: { account_type: "margin", total_equity: 100_000, total_cash: 100_000, margin: { stock_buying_power: 200_000 } },
        positions: [],
        orders: () => [],
        history: () => [],
      },
    ],
  };
}

/** Quotes Tradier knows. The second option has not traded today: its price is the previous close. */
export function defaultQuotes() {
  return new Map(
    Object.entries({
      AAPL: { symbol: "AAPL", type: "stock", last: 151.5, prevclose: 150, change: 1.5 },
      MSFT: { symbol: "MSFT", type: "stock", last: 410, prevclose: 405, change: 5 },
      SPY261218C00600000: { symbol: "SPY261218C00600000", type: "option", last: 3.5, prevclose: 3.2, contract_size: 100, underlying: "SPY" },
      SPY261218C00610000: { symbol: "SPY261218C00610000", type: "option", last: null, prevclose: 2.2, contract_size: 100, underlying: "SPY" },
    }),
  );
}

/** @param {any[]} list Tradier's collapsed collection: none -> "null", one -> the object */
const collapse = (list) => (list.length === 0 ? "null" : list.length === 1 ? list[0] : list);

/**
 * @param {{
 *   now?: () => number,
 *   refreshTokens?: boolean,
 *   login?: FakeLogin,
 * }} [opts]
 */
export async function startFakeTradier(opts = {}) {
  const clock = opts.now ?? Date.now;
  const state = {
    /** The Tradier login the next OAuth approval signs in as. */
    login: opts.login ?? defaultLogin(),
    refreshTokens: opts.refreshTokens ?? false,
    /** @type {Map<string, { host: Host, login: FakeLogin }>} personal tokens */
    personal: new Map(),
    /** @type {Map<string, { issuedAt: number, used: boolean, login: FakeLogin }>} */
    codes: new Map(),
    /** @type {Map<string, { issuedAt: number, login: FakeLogin }>} */
    access: new Map(),
    /** @type {Map<string, { login: FakeLogin }>} */
    refresh: new Map(),
    quotes: defaultQuotes(),
    /** @type {Array<{ host: Host, method: string, path: string, query: Record<string, string> }>} */
    calls: [],
    /** @type {Array<{ path: string, grant: string, status: number }>} */
    tokenCalls: [],
    /** Every token and code issued (for leak checks). @type {string[]} */
    issued: [],
    deny: false,
    /** @type {Array<{ host: Host, path?: RegExp, expiresInMs: number }>} */
    quota: [],
    failQuotes: 0,
    /** @type {Array<{ host: Host, path: RegExp }>} */
    forbid: [],
  };
  const token = (/** @type {string} */ prefix) => {
    const t = `${prefix}${randomBytes(15).toString("base64url")}`;
    state.issued.push(t);
    return t;
  };

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} text */
  const plain = (res, status, text, type = "text/plain") => {
    res.writeHead(status, { "content-type": type });
    res.end(text);
  };

  /** @param {FakeLogin} login */
  function issue(login) {
    const access = token("TA.");
    state.access.set(access, { issuedAt: clock(), login });
    /** @type {Record<string, unknown>} */
    const out = { access_token: access, expires_in: 86_399, issued_at: new Date(clock()).toISOString(), scope: "read market", status: "approved" };
    if (state.refreshTokens) {
      const r = token("TR.");
      state.refresh.set(r, { login });
      out.refresh_token = r;
    }
    return out;
  }

  /** @param {import("node:http").IncomingMessage} req */
  function basicOk(req) {
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ""));
    if (!m) return false;
    const raw = Buffer.from(m[1], "base64").toString("utf8");
    const i = raw.indexOf(":");
    return raw.slice(0, i) === CLIENT.id && raw.slice(i + 1) === CLIENT.secret;
  }

  /**
   * @param {Host} host
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {URL} url
   * @param {string} text
   */
  function handle(host, req, res, url, text) {
    const t = clock();
    const path = url.pathname;

    if (host === "live" && req.method === "GET" && path === "/v1/oauth/authorize") {
      if (url.searchParams.has("redirect_uri")) return plain(res, 400, "<html><body>redirect_uri is not a parameter of this endpoint</body></html>", "text/html");
      if (url.searchParams.get("client_id") !== CLIENT.id) return plain(res, 400, "<html><body>Invalid client</body></html>", "text/html");
      const back = new URL(CALLBACK);
      if (state.deny) {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = token("TC.");
        state.codes.set(code, { issuedAt: t, used: false, login: state.login });
        back.searchParams.set("code", code);
      }
      const st = url.searchParams.get("state");
      if (st) back.searchParams.set("state", st);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (host === "live" && req.method === "POST" && (path === "/v1/oauth/accesstoken" || path === "/v1/oauth/refreshtoken")) {
      const fields = Object.fromEntries(new URLSearchParams(text));
      /** @param {number} status @param {unknown} body */
      const answer = (status, body) => {
        state.tokenCalls.push({ path, grant: String(fields.grant_type ?? ""), status });
        return send(res, status, body);
      };
      if (!basicOk(req)) return answer(401, { error: "invalid_client" });
      if (path === "/v1/oauth/accesstoken") {
        if (fields.grant_type !== "authorization_code") return answer(400, { error: "unsupported_grant_type" });
        if ("redirect_uri" in fields) return answer(400, { error: "invalid_request", error_description: "redirect_uri is registered with the client" });
        const c = state.codes.get(fields.code ?? "");
        if (!c || c.used) return answer(400, { error: "invalid_grant" });
        c.used = true;
        if (t - c.issuedAt > 10 * 60_000) return answer(400, { error: "invalid_grant", error_description: "code expired" });
        return answer(200, issue(c.login));
      }
      if (!state.refreshTokens) return answer(401, { error: "unauthorized_client", error_description: "refresh tokens are not enabled" });
      if (fields.grant_type !== "refresh_token") return answer(400, { error: "unsupported_grant_type" });
      const r = state.refresh.get(fields.refresh_token ?? "");
      if (!r) return answer(400, { error: "invalid_grant" });
      const access = token("TA.");
      state.access.set(access, { issuedAt: t, login: r.login });
      return answer(200, { access_token: access, expires_in: 86_399, issued_at: new Date(t).toISOString(), refresh_token: fields.refresh_token, scope: "read market", status: "approved" });
    }

    const quota = state.quota.findIndex((q) => q.host === host && (!q.path || q.path.test(path)));
    if (quota >= 0) {
      const [q] = state.quota.splice(quota, 1);
      const expires = t + q.expiresInMs;
      res.writeHead(400, { "content-type": "plain/text", "x-ratelimit-expiry": String(expires), "x-ratelimit-available": "0" });
      return res.end(`Quota Violation: Expires ${expires}`);
    }

    if (!path.startsWith("/v1/") || path.startsWith("/v1/oauth/")) return send(res, 404, { error: "not found" });
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
    const personal = state.personal.get(bearer);
    const oauth = host === "live" ? state.access.get(bearer) : undefined;
    /** @type {FakeLogin | null} */
    let login = null;
    if (personal && personal.host === host) login = personal.login;
    else if (oauth && t - oauth.issuedAt < DAY) login = oauth.login;
    if (!login) return plain(res, 401, "Invalid Access Token");
    if (!String(req.headers.accept ?? "").includes("application/json")) return plain(res, 200, "<response/>", "application/xml");
    if (req.method !== "GET") return send(res, 404, { error: "not found" });
    if (state.forbid.some((f) => f.host === host && f.path.test(path))) return plain(res, 403, "Forbidden");

    if (path === "/v1/user/profile") {
      return send(res, 200, {
        profile: {
          id: login.id,
          name: login.name,
          account: collapse(
            login.accounts.map((a) => ({
              account_number: a.number,
              classification: a.classification,
              date_created: "2020-01-01T00:00:00.000Z",
              day_trader: false,
              option_level: 3,
              status: a.status,
              type: a.type,
              last_update_date: "2026-01-01T00:00:00.000Z",
            })),
          ),
        },
      });
    }
    if (path === "/v1/markets/quotes") {
      if (state.failQuotes > 0) {
        state.failQuotes -= 1;
        return plain(res, 503, "Service Unavailable");
      }
      const symbols = String(url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      const found = symbols.map((s) => state.quotes.get(s)).filter(Boolean);
      const missing = symbols.filter((s) => !state.quotes.has(s));
      return send(res, 200, { quotes: { ...(found.length ? { quote: collapse(found) } : {}), ...(missing.length ? { unmatched_symbols: { symbol: collapse(missing) } } : {}) } });
    }
    const m = /^\/v1\/accounts\/([^/]+)\/(balances|positions|orders|history)$/.exec(path);
    if (m) {
      const account = login.accounts.find((a) => a.number === m[1] && a.status !== "closed");
      if (!account) return plain(res, 400, "Invalid account number");
      if (m[2] === "balances") return send(res, 200, { balances: account.balances });
      if (m[2] === "positions") return send(res, 200, { positions: account.positions.length ? { position: collapse(account.positions) } : "null" });
      if (m[2] === "orders") {
        // As Tradier: 25 orders without a limit, `page` counts from 1.
        const limit = Number(url.searchParams.get("limit") ?? 25);
        const page = Number(url.searchParams.get("page") ?? 1);
        const list = account.orders(t).slice((page - 1) * limit, page * limit);
        return send(res, 200, { orders: list.length ? { order: collapse(list) } : "null" });
      }
      const type = url.searchParams.get("type");
      const start = url.searchParams.get("start") ?? "";
      const end = url.searchParams.get("end") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return plain(res, 400, "start and end must be YYYY-MM-DD");
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const page = Number(url.searchParams.get("page") ?? 1);
      const events = account
        .history(t)
        .filter((e) => (!type || e.type === type) && e.date.slice(0, 10) >= start && e.date.slice(0, 10) <= end)
        .slice((page - 1) * limit, page * limit);
      return send(res, 200, { history: events.length ? { event: collapse(events) } : "null" });
    }
    return send(res, 404, { error: "not found" });
  }

  /** @param {Host} host */
  const serve = (host) =>
    listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://fake.invalid");
      state.calls.push({ host, method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams) });
      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handle(host, req, res, url, Buffer.concat(chunks).toString("utf8")));
    });

  const live = await serve("live");
  const sandbox = await serve("sandbox");

  return {
    state,
    live,
    sandbox,
    urls: { live: live.url, sandbox: sandbox.url },
    /**
     * A personal API token for `login` on `host` (what the API Access page shows).
     * @param {Host} host @param {FakeLogin} [login]
     */
    addToken(host, login) {
      const t = token(host === "live" ? "TP." : "TS.");
      state.personal.set(t, { host, login: login ?? (host === "live" ? state.login : sandboxLogin()) });
      return t;
    },
    /** Regenerating a token on Tradier's page: the old one stops working. @param {string} old */
    regenerate(old) {
      const p = state.personal.get(old);
      state.personal.delete(old);
      const t = token("TP.");
      if (p) state.personal.set(t, p);
      return t;
    },
    /** Forget every OAuth access token (Tradier ended them, or the user revoked Nasscord). */
    revokeAccess() {
      state.access.clear();
    },
    /** Calls the service made (the browser's authorize visits left out). */
    serviceCalls() {
      return state.calls.filter((c) => c.path !== "/v1/oauth/authorize");
    },
    /** @param {string} path @param {Host} [host] */
    count(path, host) {
      return state.calls.filter((c) => c.path === path && (!host || c.host === host)).length;
    },
    async close() {
      await live.close();
      await sandbox.close();
    },
  };
}
