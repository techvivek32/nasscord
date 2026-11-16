import { randomBytes } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake tastytrade (OAuth + Open API) on one local port, close to what tastytrade does:
 *
 * OAuth
 * - GET /auth.html (the login page): client_id, redirect_uri and response_type=code are required;
 *   an unknown client or a redirect URI that is not exactly the app's registered one answers an
 *   HTML error page. Otherwise 302 back with state and a code (single use, 5 minutes on the fake
 *   clock). `deny` answers error=access_denied.
 * - POST /oauth/token: a JSON body only. authorization_code needs code, client_id, client_secret
 *   and the same redirect_uri; refresh_token needs refresh_token and client_secret (client_id is
 *   optional and must match when sent). Access tokens live 15 minutes (expires_in 900). A refresh
 *   answers a new access token and NO refresh token: the grant's refresh token never rotates and
 *   never expires. A deleted grant answers 401. Errors are { error: { code, message } }.
 *   `failToken` answers the next calls with a set status (an outage).
 *
 * API (Bearer access token required; 401 with a JSON error otherwise)
 * - Every request without a "<product>/<version>" User-Agent gets 401 with an HTML body, as
 *   tastytrade does. The Accept-Version of each call is recorded.
 * - /customers/me (with names, a masked tax number and a birth date, to prove none is stored),
 *   /customers/me/accounts (one closed account), /accounts/{n}/balances, /positions (marks only
 *   with include-marks=true), /orders/live (as tastytrade's spec says: the orders created or
 *   updated today, flagged `live` here, in any status, plus every older order still working),
 *   /orders (start-date or start-at required, else 400; status[] filter), /transactions (type /
 *   types[] and start-date filters).
 * - `refuseReads` answers every API read 401 even with a token the token endpoint just issued
 *   (the token endpoint stays healthy): a cause on tastytrade's side that is not the grant.
 *   Lists are { data: { items }, pagination } and honour per-page and page-offset; `pageSize`
 *   caps per-page so a test can force several pages.
 * - Anything else is 404 and stays in `calls`, so a test can prove nothing outside the read set was
 *   asked for.
 *
 * Every request is recorded with its method, path and query (test memory only).
 */

export const CLIENT = Object.freeze({ id: "tt-client-0d8f", secret: "tt-secret-Zq81LmKw" });
export const CALLBACK = "http://localhost:3000/api/broker/callback/tastytrade";
export const CUSTOMER_REF = "C0000037211";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Order statuses that are still working (any age shows in /orders/live). */
const WORKING = new Set(["Received", "Routed", "In Flight", "Live", "Contingent", "Cancel Requested", "Replace Requested"]);
/** tastytrade's timestamp style. @param {number} ms */
const ts = (ms) => new Date(ms).toISOString().replace("Z", "+00:00");
/** @param {number} ms */
const date = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @typedef {{
 *   number: string,
 *   account: Record<string, unknown>,
 *   balances: Record<string, unknown>,
 *   positions: Array<Record<string, unknown>>,
 *   orders: (now: number) => Array<Record<string, unknown> & { live?: boolean }>,
 *   transactions: (now: number) => Array<Record<string, unknown>>,
 * }} FakeAccount
 */

/** The default login: a margin account with stock, an option and a future, a Roth IRA, a closed account. */
export function defaultAccounts() {
  /** @type {FakeAccount[]} */
  const accounts = [
    {
      number: "5WT00001",
      account: { "account-number": "5WT00001", "account-type-name": "Individual", nickname: "Main", "margin-or-cash": "Margin", "is-closed": false, "external-id": "A0000196557" },
      balances: { "account-number": "5WT00001", currency: "USD", "net-liquidating-value": "25340.50", "cash-balance": "10000.25", "equity-buying-power": "40000.00", "derivative-buying-power": "20000.00" },
      positions: [
        {
          symbol: "AAPL",
          "instrument-type": "Equity",
          quantity: "10",
          "quantity-direction": "Long",
          "average-open-price": "150.25",
          "close-price": "149.00",
          "average-daily-market-close-price": "149.00",
          mark: "151.50",
          "mark-price": "151.50",
          multiplier: 1,
        },
        {
          symbol: "SPY   261218C00600000",
          "instrument-type": "Equity Option",
          "underlying-symbol": "SPY",
          quantity: "2",
          "quantity-direction": "Short",
          "average-open-price": "3.10",
          "close-price": "3.30",
          "average-daily-market-close-price": "3.30",
          mark: "3.50",
          "mark-price": "3.50",
          multiplier: 100,
        },
        {
          symbol: "/ESZ6",
          "instrument-type": "Future",
          quantity: "1",
          "quantity-direction": "Long",
          "average-open-price": "6000.00",
          "close-price": "6010.00",
          "average-daily-market-close-price": "6010.00",
          mark: "6020.00",
          "mark-price": "6020.00",
          multiplier: 50,
        },
        { symbol: "ZERO", "instrument-type": "Equity", quantity: "0", "quantity-direction": "Zero", "average-open-price": "10", "close-price": "10", multiplier: 1 },
      ],
      orders: (now) => [
        {
          id: "101",
          live: true,
          "account-number": "5WT00001",
          "order-type": "Limit",
          "time-in-force": "Day",
          price: "150.00",
          "price-effect": "Debit",
          size: "10",
          status: "Filled",
          "underlying-symbol": "AAPL",
          "received-at": ts(now - 2 * HOUR),
          "updated-at": ts(now - 2 * HOUR + 5_000),
          legs: [
            {
              "instrument-type": "Equity",
              symbol: "AAPL",
              quantity: "10",
              "remaining-quantity": "0",
              action: "Buy to Open",
              fills: [
                { "fill-id": "f1", "ext-exec-id": "x1", quantity: "4", "fill-price": "149.90", "filled-at": ts(now - 2 * HOUR + 1_000) },
                { "fill-id": "f2", "ext-exec-id": "x2", quantity: "6", "fill-price": "150.00", "filled-at": ts(now - 2 * HOUR + 2_000) },
              ],
            },
          ],
        },
        {
          // A GTC stop placed three months ago and still resting: outside the 30-day search, so only
          // /orders/live (which holds every order still working, whatever its age) has it.
          id: "102",
          "order-type": "Stop",
          "time-in-force": "GTC",
          "stop-trigger": "140.00",
          size: "5",
          status: "Live",
          "underlying-symbol": "AAPL",
          "received-at": ts(now - 90 * DAY),
          "updated-at": ts(now - 90 * DAY),
          legs: [{ "instrument-type": "Equity", symbol: "AAPL", quantity: "5", "remaining-quantity": "5", action: "Sell to Close", fills: [] }],
        },
        {
          id: "103",
          "order-type": "Limit",
          "time-in-force": "Day",
          price: "1.25",
          "price-effect": "Credit",
          size: "2",
          status: "Cancelled",
          "underlying-symbol": "SPY",
          "received-at": ts(now - 3 * DAY),
          "updated-at": ts(now - 3 * DAY + 60_000),
          legs: [
            { "instrument-type": "Equity Option", symbol: "SPY   261218C00600000", quantity: "2", "remaining-quantity": "2", action: "Sell to Open", fills: [] },
            { "instrument-type": "Equity Option", symbol: "SPY   261218C00610000", quantity: "2", "remaining-quantity": "2", action: "Buy to Open", fills: [] },
          ],
        },
        {
          // Filled 45 days ago: outside the 30-day window and not working, so never asked for.
          id: "104",
          "order-type": "Market",
          "time-in-force": "Day",
          size: "3",
          status: "Filled",
          "underlying-symbol": "MSFT",
          "received-at": ts(now - 45 * DAY),
          "updated-at": ts(now - 45 * DAY),
          legs: [{ "instrument-type": "Equity", symbol: "MSFT", quantity: "3", "remaining-quantity": "0", action: "Buy to Open", fills: [{ "fill-id": "f9", quantity: "3", "fill-price": "400.00" }] }],
        },
        {
          // A GTC placed 40 days ago that filled this morning: only today's live orders have it.
          id: "105",
          live: true,
          "order-type": "Limit",
          "time-in-force": "GTC",
          price: "95.00",
          size: "20",
          status: "Filled",
          "underlying-symbol": "KO",
          "received-at": ts(now - 40 * DAY),
          "updated-at": ts(now - HOUR),
          legs: [{ "instrument-type": "Equity", symbol: "KO", quantity: "20", "remaining-quantity": "0", action: "Sell to Close", fills: [{ "fill-id": "f5", quantity: "20", "fill-price": "95.10" }] }],
        },
        {
          id: "106",
          live: true,
          "order-type": "Limit",
          "time-in-force": "Ext",
          price: "250.00",
          size: "1",
          status: "Received",
          "underlying-symbol": "TSLA",
          "received-at": ts(now - 10 * 60_000),
          "updated-at": ts(now - 10 * 60_000),
          legs: [{ "instrument-type": "Equity", symbol: "TSLA", quantity: "1", "remaining-quantity": "1", action: "Buy to Open", fills: [] }],
        },
      ],
      transactions: (now) => [
        {
          id: 9001,
          "transaction-type": "Trade",
          "transaction-sub-type": "Buy to Open",
          action: "Buy to Open",
          symbol: "AAPL",
          "instrument-type": "Equity",
          quantity: "4",
          price: "149.90",
          value: "599.60",
          "value-effect": "Debit",
          commission: "0.00",
          "commission-effect": "None",
          "clearing-fees": "0.02",
          "clearing-fees-effect": "Debit",
          "regulatory-fees": "0.01",
          "regulatory-fees-effect": "Debit",
          "net-value": "599.63",
          "net-value-effect": "Debit",
          "order-id": 101,
          "executed-at": ts(now - 2 * HOUR + 1_000),
          "transaction-date": date(now),
          "is-estimated-fee": false,
        },
        {
          id: 9002,
          "transaction-type": "Trade",
          "transaction-sub-type": "Buy to Open",
          action: "Buy to Open",
          symbol: "AAPL",
          "instrument-type": "Equity",
          quantity: "6",
          price: "150.00",
          value: "900.00",
          "value-effect": "Debit",
          "clearing-fees": "0.02",
          "clearing-fees-effect": "Debit",
          "regulatory-fees": "0.01",
          "regulatory-fees-effect": "Debit",
          "net-value": "900.03",
          "net-value-effect": "Debit",
          "executed-at": ts(now - 2 * HOUR + 2_000),
          "transaction-date": date(now),
          "is-estimated-fee": true,
        },
        {
          id: 9003,
          "transaction-type": "Trade",
          "transaction-sub-type": "Sell to Open",
          action: "Sell to Open",
          symbol: "SPY   261218C00600000",
          "underlying-symbol": "SPY",
          "instrument-type": "Equity Option",
          quantity: "2",
          price: "2.50",
          value: "500.00",
          "value-effect": "Credit",
          commission: "2.00",
          "commission-effect": "Debit",
          "clearing-fees": "0.20",
          "clearing-fees-effect": "Debit",
          "regulatory-fees": "0.05",
          "regulatory-fees-effect": "Debit",
          "net-value": "497.75",
          "net-value-effect": "Credit",
          "executed-at": ts(now - 3 * DAY),
          "transaction-date": date(now - 3 * DAY),
        },
        {
          id: 9004,
          "transaction-type": "Money Movement",
          "transaction-sub-type": "Deposit",
          value: "1000.00",
          "value-effect": "Credit",
          "net-value": "1000.00",
          "net-value-effect": "Credit",
          "executed-at": ts(now - 5 * DAY),
          "transaction-date": date(now - 5 * DAY),
        },
        {
          id: 9005,
          "transaction-type": "Trade",
          action: "Buy to Open",
          symbol: "MSFT",
          "instrument-type": "Equity",
          quantity: "3",
          price: "400.00",
          value: "1200.00",
          "value-effect": "Debit",
          "net-value": "1200.00",
          "net-value-effect": "Debit",
          "executed-at": ts(now - 45 * DAY),
          "transaction-date": date(now - 45 * DAY),
        },
      ],
    },
    {
      number: "5WT00002",
      account: { "account-number": "5WT00002", "account-type-name": "Roth IRA", nickname: "", "margin-or-cash": "Cash", "is-closed": false },
      balances: { "account-number": "5WT00002", currency: "USD", "net-liquidating-value": "5000.00", "cash-balance": "3700.00", "equity-buying-power": "3700.00" },
      positions: [
        {
          symbol: "VTI",
          "instrument-type": "Equity",
          quantity: "5",
          "quantity-direction": "Long",
          "average-open-price": "250.00",
          "close-price": "260.00",
          "average-daily-market-close-price": "260.00",
          mark: "262.00",
          "mark-price": "262.00",
          multiplier: 1,
        },
      ],
      orders: (now) => [
        {
          id: "201",
          "order-type": "Limit",
          "time-in-force": "Day",
          price: "10.00",
          size: "1",
          status: "Rejected",
          "reject-reason": "Not enough buying power",
          "underlying-symbol": "XYZ",
          "received-at": ts(now - 5 * DAY),
          "updated-at": ts(now - 5 * DAY),
          legs: [{ "instrument-type": "Equity", symbol: "XYZ", quantity: "1", "remaining-quantity": "1", action: "Buy to Open", fills: [] }],
        },
      ],
      transactions: () => [],
    },
    {
      number: "5WT00009",
      account: { "account-number": "5WT00009", "account-type-name": "Individual", nickname: "Old", "margin-or-cash": "Cash", "is-closed": true },
      balances: {},
      positions: [],
      orders: () => [],
      transactions: () => [],
    },
  ];
  return accounts;
}

/**
 * @param {{ now?: () => number, accounts?: FakeAccount[], customerRef?: string | null }} [opts]
 */
export async function startFakeTastytrade(opts = {}) {
  const clock = opts.now ?? Date.now;
  const state = {
    accounts: opts.accounts ?? defaultAccounts(),
    customer: {
      id: "me",
      "first-name": "Patricia",
      "last-name": "Quillfeather",
      email: "patricia.quillfeather@example.com",
      "birth-date": "1980-04-02",
      "tax-number": "*****6789",
      "tax-number-type": "SSN",
      "mobile-phone-number": "+15555550123",
      ...(opts.customerRef === null ? {} : { "external-id": opts.customerRef ?? CUSTOMER_REF }),
    },
    /** @type {Map<string, { issuedAt: number, used: boolean, redirectUri: string }>} */
    codes: new Map(),
    /** The grant's refresh tokens (one per approval); deleting the grant empties this. @type {Set<string>} */
    grants: new Set(),
    /** @type {Map<string, number>} access token -> expiry (fake clock) */
    access: new Map(),
    /** @type {Array<{ method: string, path: string, query: Record<string, string>, userAgent: string, version: string }>} */
    calls: [],
    /** @type {Array<{ grant: string, status: number, body: Record<string, unknown> }>} */
    tokenCalls: [],
    /** Every token and code issued (for leak checks). @type {string[]} */
    issued: [],
    /** The next `count` token calls answer `status` with `body`. */
    failToken: /** @type {{ count: number, status: number, body: unknown } | null} */ (null),
    deny: false,
    /** Cap per-page (forces several pages). */
    pageSize: /** @type {number | null} */ (null),
    /** Leave the marks out of positions even with include-marks=true. */
    noMarks: false,
    /** Answer every API read 401, whatever the token (the token endpoint still works). */
    refuseReads: false,
  };
  const token = (/** @type {string} */ prefix) => {
    const t = `${prefix}${randomBytes(18).toString("base64url")}`;
    state.issued.push(t);
    return t;
  };

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} html */
  const html = (res, status, html) => {
    res.writeHead(status, { "content-type": "text/html" });
    res.end(html);
  };
  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} code @param {string} message */
  const error = (res, status, code, message) => json(res, status, { error: { code, message } });

  /**
   * A paginated list answer.
   * @param {import("node:http").ServerResponse} res @param {URL} url @param {unknown[]} all @param {number} defaultPer @param {string} context
   */
  function list(res, url, all, defaultPer, context) {
    let per = Number(url.searchParams.get("per-page") ?? defaultPer) || defaultPer;
    if (state.pageSize) per = Math.min(per, state.pageSize);
    const offset = Number(url.searchParams.get("page-offset") ?? 0) || 0;
    const items = all.slice(offset * per, offset * per + per);
    json(res, 200, {
      data: { items },
      context,
      pagination: {
        "per-page": per,
        "page-offset": offset,
        "item-offset": offset * per,
        "total-items": all.length,
        "total-pages": Math.ceil(all.length / per),
        "current-item-count": items.length,
      },
    });
  }

  /** The start of a search: start-date (a New York date; midnight there is about 05:00 UTC) or start-at. @param {URL} url */
  function startOf(url) {
    const d = url.searchParams.get("start-date");
    const at = url.searchParams.get("start-at");
    if (d) return Date.parse(`${d}T00:00:00Z`) + 5 * HOUR;
    if (at) return Date.parse(at);
    return null;
  }

  /** @param {Record<string, any>} o */
  const strip = (o) => {
    const { live, ...rest } = o;
    void live;
    return rest;
  };

  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const path = url.pathname;
    const userAgent = String(req.headers["user-agent"] ?? "");
    const version = String(req.headers["accept-version"] ?? "");
    state.calls.push({ method: req.method ?? "GET", path, query: Object.fromEntries(url.searchParams), userAgent, version });
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const t = clock();

      // The login page (the user's browser, not the service).
      if (req.method === "GET" && path === "/auth.html") {
        if (url.searchParams.get("client_id") !== CLIENT.id) return html(res, 400, "<html><body>Unknown application</body></html>");
        if (url.searchParams.get("response_type") !== "code") return html(res, 400, "<html><body>response_type must be code</body></html>");
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (redirectUri !== CALLBACK) return html(res, 400, "<html><body>The redirect URI is not registered for this application</body></html>");
        const back = new URL(redirectUri);
        if (state.deny) {
          back.searchParams.set("error", "access_denied");
        } else {
          const code = token("ttc_");
          state.codes.set(code, { issuedAt: t, used: false, redirectUri });
          back.searchParams.set("code", code);
        }
        const st = url.searchParams.get("state");
        if (st) back.searchParams.set("state", st);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      // tastytrade answers a missing or bare User-Agent with an HTML 401, on every endpoint.
      if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(userAgent)) return html(res, 401, "<html><body><h1>401 Unauthorized</h1></body></html>");

      if (req.method === "POST" && path === "/oauth/token") {
        /** @type {Record<string, unknown>} */
        let body = {};
        /** @param {number} status @param {unknown} out */
        const answer = (status, out) => {
          state.tokenCalls.push({ grant: String(body.grant_type ?? ""), status, body: { ...body } });
          json(res, status, out);
        };
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return answer(400, { error: { code: "invalid_request", message: "JSON body required" } });
        try {
          body = JSON.parse(text);
        } catch {
          return answer(400, { error: { code: "invalid_request", message: "JSON body required" } });
        }
        if (state.failToken && state.failToken.count > 0) {
          state.failToken.count -= 1;
          return answer(state.failToken.status, state.failToken.body);
        }
        if (body.client_secret !== CLIENT.secret || (body.client_id !== undefined && body.client_id !== CLIENT.id)) {
          return answer(401, { error: { code: "invalid_client", message: "Client authentication failed" } });
        }
        if (body.grant_type === "authorization_code") {
          if (body.client_id !== CLIENT.id) return answer(401, { error: { code: "invalid_client", message: "client_id is required" } });
          const c = state.codes.get(String(body.code ?? ""));
          if (!c || c.used || t - c.issuedAt > 5 * 60_000) return answer(400, { error: { code: "invalid_grant", message: "Invalid authorization code" } });
          c.used = true;
          if (body.redirect_uri !== c.redirectUri) return answer(400, { error: { code: "invalid_grant", message: "redirect_uri mismatch" } });
          const access = token("tta_");
          const refresh = token("ttr_");
          state.access.set(access, t + 900_000);
          state.grants.add(refresh);
          return answer(200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 900 });
        }
        if (body.grant_type === "refresh_token") {
          if (!state.grants.has(String(body.refresh_token ?? ""))) return answer(401, { error: { code: "unauthorized", message: "The grant was removed" } });
          const access = token("tta_");
          state.access.set(access, t + 900_000);
          // No refresh_token: tastytrade does not rotate it.
          return answer(200, { access_token: access, token_type: "Bearer", expires_in: 900 });
        }
        return answer(400, { error: { code: "unsupported_grant_type", message: "Unsupported grant type" } });
      }

      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      const until = state.access.get(bearer);
      if (until === undefined || until <= t || state.refuseReads) return error(res, 401, "unauthorized", "Token is invalid or expired");
      if (req.method !== "GET") return error(res, 404, "not_found", "Not found");

      if (path === "/customers/me") return json(res, 200, { data: state.customer, context: "/customers/me" });
      if (path === "/customers/me/accounts") {
        return list(res, url, state.accounts.map((a) => ({ account: a.account, "authority-level": "owner" })), 100, "/customers/me/accounts");
      }
      const m = /^\/accounts\/([^/]+)\/(balances|positions|orders\/live|orders|transactions)$/.exec(path);
      const acct = m ? state.accounts.find((a) => a.number === m[1]) : null;
      if (!m || !acct) return error(res, 404, "not_found", "Not found");
      const what = m[2];
      if (what === "balances") return json(res, 200, { data: acct.balances, context: path });
      if (what === "positions") {
        const marks = url.searchParams.get("include-marks") === "true" && !state.noMarks;
        const items = acct.positions.map((p) => {
          if (marks) return p;
          const { mark, "mark-price": markPrice, ...rest } = p;
          void mark;
          void markPrice;
          return rest;
        });
        return json(res, 200, { data: { items }, context: path });
      }
      if (what === "orders/live") {
        const items = acct
          .orders(t)
          .filter((o) => o.live || WORKING.has(String(o.status)))
          .map(strip);
        return list(res, url, items, 100, path);
      }
      if (what === "orders") {
        const start = startOf(url);
        if (start === null) return error(res, 400, "validation_error", "start-date or start-at is required");
        const status = url.searchParams.getAll("status[]");
        const items = acct
          .orders(t)
          .filter((o) => Date.parse(String(o["received-at"])) >= start)
          .filter((o) => status.length === 0 || status.includes(String(o.status)))
          .sort((a, b) => Date.parse(String(b["received-at"])) - Date.parse(String(a["received-at"])))
          .map(strip);
        return list(res, url, items, 100, path);
      }
      // transactions
      const start = startOf(url);
      const types = [...url.searchParams.getAll("types[]"), ...url.searchParams.getAll("type")];
      const items = acct
        .transactions(t)
        .filter((x) => start === null || Date.parse(String(x["executed-at"])) >= start)
        .filter((x) => types.length === 0 || types.includes(String(x["transaction-type"])))
        .sort((a, b) => Date.parse(String(b["executed-at"])) - Date.parse(String(a["executed-at"])));
      return list(res, url, items, 250, path);
    });
  });

  return {
    ...server,
    state,
    urls: { api: server.url, authorize: `${server.url}/auth.html` },
    /** The user deleted the grant at my.tastytrade.com: its refresh token and access tokens stop working. */
    deleteGrant() {
      state.grants.clear();
      state.access.clear();
    },
    /** tastytrade ended every access token early (the refresh token still works). */
    revokeAccess() {
      state.access.clear();
    },
    /** Calls the service made (the browser's login page visits left out). */
    serviceCalls() {
      return state.calls.filter((c) => c.path !== "/auth.html");
    },
    /** Successful refreshes so far. */
    refreshes() {
      return state.tokenCalls.filter((c) => c.grant === "refresh_token" && c.status === 200).length;
    },
  };
}
