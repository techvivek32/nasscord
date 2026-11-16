import { randomBytes } from "node:crypto";
import { computeSignature, WEBULL_ALGORITHMS } from "../../src/webull/signer.mjs";
import { listen } from "./common.mjs";

/**
 * A fake Webull Connect API (OAuth + trading reads) on one local port, close to what Webull
 * documents (developer.webull.com/apis/docs/connect-api):
 *
 * OAuth
 * - GET /oauth2/auth-codes/get: response_type=code, the client id, a scope, a state and a
 *   redirect_uri on the whitelist are required (anything else: 417 INVALID_PARAMETER). Then 302 back
 *   with code and state (the user approved on passport.webull.com). `deny` answers error=access_denied.
 * - POST /oauth2/tokens/create: form body (client_id, client_secret, grant_type, code or
 *   refresh_token), and Webull's HMAC headers verified against the app secret: x-app-key,
 *   x-timestamp (within 5 minutes), x-signature-algorithm, x-signature-version 1.0, a nonce never
 *   seen before, x-version v2 and x-signature over path, host and the body's digest. An
 *   x-app-secret header is refused outright. Codes work once and for 60 seconds. Access tokens live
 *   30 minutes. Refresh tokens rotate: each refresh answers a new one and kills the old one. Their
 *   life is 15 days from the approval (`refreshMode: "fixed"`, rt_expires_in counts down) or from
 *   each refresh (`"sliding"`).
 * - Errors are only the three Webull documents for the token endpoint, with its neutral messages:
 *   401 UNAUTHORIZED (signature, timestamp, nonce, app key or client), 417 INVALID_PARAMETER (a
 *   dead, used or late code or refresh token, a bad grant or body) and 500 SYSTEM_ERROR. The real
 *   reason stays in `tokenCalls[].why` for the tests; it is never sent.
 * - The token answer has Webull's fields: expires_in and rt_expires_in as strings, created_at and
 *   identity_id.
 *
 * Trading reads (/trading/*): "Authorization: Bearer <access token>" (401 UNAUTHORIZED otherwise).
 * Signed headers, when a request carries them, are verified too. Each endpoint allows 2 calls per
 * 2 seconds per user (10 per 30 seconds for the account list, 600 per 60 seconds for cash
 * activities, as in production), answering 429 otherwise; every 429 is kept in `limited`. Lists are
 * paged (`pageSize` groups per page). Order history needs start_time and end_time; cash activities
 * refuse a range that crosses a calendar year. `refuseReads` makes chosen reads answer a status
 * (one account's 401, a 500), and `readDelayMs` makes an endpoint slow.
 *
 * Everything else is 404 and stays in `calls`, so a test can prove nothing outside the read set was
 * asked for. The clock is the test's (`now`).
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const FAKE_WEBULL_APP = Object.freeze({
  clientId: "wb-client-id-0001",
  clientSecret: "wb-client-secret-0001",
  appKey: "776da210ab4a452795d74e726ebd74b6",
  appSecret: "0f50a2e853334a9aae1a783bee120c1f",
});

/**
 * @typedef {{
 *   identityId: string,
 *   accounts: any[],
 *   balances: Record<string, any>,
 *   positions: Record<string, any[]>,
 *   openOrders: Record<string, (now: number) => any[]>,
 *   history: Record<string, (now: number) => any[]>,
 *   activities: Record<string, (now: number) => any[]>,
 * }} FakeLogin
 */

/** @param {number} ms */
const isoAt = (ms) => new Date(ms).toISOString();

/**
 * The default login: a margin account (stock, a single option, a vertical spread, a bracket order
 * and fills), a Roth IRA, and an event-contract account.
 * @returns {FakeLogin}
 */
export function defaultLogin() {
  return {
    identityId: "a0920c03dcba35a56a33a7f4a0df6275",
    accounts: [
      { user_id: "1010046954", account_id: "MARGINACCT01", account_number: "5MW12345", account_type: "MARGIN", account_label: "Individual Margin", account_class: "INDIVIDUAL_MARGIN" },
      { user_id: "1010046954", account_id: "ROTHACCT0002", account_number: "5MW67890", account_type: "CASH", account_label: "Roth IRA", account_class: "ROTH_IRA" },
      { user_id: "1010046954", account_id: "EVENTSACCT03", account_number: "5MW24680", account_type: "CASH", account_label: "Events Cash", account_class: "EVENTS_CASH" },
    ],
    balances: {
      MARGINACCT01: {
        total_asset_currency: "USD",
        total_cash_balance: "10000.25",
        total_market_value: "15340.25",
        total_unrealized_profit_loss: "120.5",
        total_net_liquidation_value: "25340.5",
        total_day_profit_loss: "-7.5",
        day_trades_left: "UNLIMITED",
        account_currency_assets: [{ currency: "USD", cash_balance: "10000.25", buying_power: "40000", net_liquidation_value: "25340.5", day_profit_loss: "-7.5" }],
      },
      ROTHACCT0002: {
        total_asset_currency: "USD",
        total_cash_balance: "5000",
        total_net_liquidation_value: "5000",
        total_day_profit_loss: "0",
        account_currency_assets: [{ currency: "USD", cash_balance: "5000", buying_power: "4900" }],
      },
      // Webull leaves cash and net value empty for event-contract accounts.
      EVENTSACCT03: { total_asset_currency: "USD", total_cash_balance: "", total_net_liquidation_value: "", total_day_profit_loss: "1.25", account_currency_assets: [{ currency: "USD", buying_power: "50" }] },
    },
    positions: {
      MARGINACCT01: [
        { position_id: "POS1", symbol: "AAPL", instrument_type: "EQUITY", quantity: "10", cost_price: "150.25", last_price: "151.5", unrealized_profit_loss: "12.5", currency: "USD" },
        {
          position_id: "POS2",
          symbol: "SPY",
          instrument_type: "OPTION",
          option_strategy: "SINGLE",
          quantity: "-2",
          cost_price: "3.1",
          last_price: "3.5",
          unrealized_profit_loss: "-80",
          currency: "USD",
          legs: [{ leg_id: "L1", symbol: "SPY", quantity: "-2", option_type: "CALL", option_expire_date: "2026-12-18", option_exercise_price: "600", option_contract_multiplier: "100" }],
        },
        {
          position_id: "POS3",
          symbol: "TSLA",
          instrument_type: "OPTION",
          option_strategy: "VERTICAL",
          quantity: "1",
          cost_price: "2.4",
          last_price: "2.9",
          unrealized_profit_loss: "50",
          currency: "USD",
          legs: [
            { leg_id: "L2", symbol: "TSLA", quantity: "1", option_type: "CALL", option_expire_date: "2026-12-18", option_exercise_price: "400" },
            { leg_id: "L3", symbol: "TSLA", quantity: "-1", option_type: "CALL", option_expire_date: "2026-12-18", option_exercise_price: "410" },
          ],
        },
        { position_id: "POS4", symbol: "ZERO", instrument_type: "EQUITY", quantity: "0", cost_price: "1", last_price: "1" },
      ],
      ROTHACCT0002: [],
      EVENTSACCT03: [{ position_id: "POS5", symbol: "FEDRATE", instrument_type: "EVENT", event_outcome: "yes", quantity: "5", cost_price: "0.4", last_price: "0.45" }],
    },
    openOrders: {
      MARGINACCT01: (now) => [
        {
          client_order_id: "COMBO-1",
          combo_order_id: "C1",
          combo_type: "MASTER",
          orders: [
            { client_order_id: "M1", order_id: "ORD-MASTER", symbol: "AAPL", side: "BUY", status: "FILLED", order_type: "LIMIT", instrument_type: "EQUITY", time_in_force: "DAY", support_trading_session: "CORE", total_quantity: "5", filled_quantity: "5", filled_price: "149.9", limit_price: "150", place_time_at: isoAt(now - 2 * DAY), filled_time_at: isoAt(now - 2 * DAY + 5_000) },
            { client_order_id: "M2", order_id: "ORD-TP", symbol: "AAPL", side: "SELL", status: "SUBMITTED", order_type: "LIMIT", instrument_type: "EQUITY", time_in_force: "GTC", support_trading_session: "ALL", total_quantity: "5", filled_quantity: "0", limit_price: "170", place_time_at: isoAt(now - 2 * DAY) },
            { client_order_id: "M3", order_id: "ORD-SL", symbol: "AAPL", side: "SELL", status: "SUBMITTED", order_type: "STOP_LOSS", instrument_type: "EQUITY", time_in_force: "GTC", total_quantity: "5", stop_price: "140", place_time_at: isoAt(now - 2 * DAY) },
          ],
        },
        {
          client_order_id: "T1",
          combo_type: "NORMAL",
          orders: [{ client_order_id: "T1", order_id: "ORD-TRAIL", symbol: "MSFT", side: "SELL", status: "PENDING", order_type: "TRAILING_STOP_LOSS", instrument_type: "EQUITY", time_in_force: "DAY", total_quantity: "3", trailing_type: "PERCENTAGE", trailing_stop_step: "2.5", place_time: String(now - 3_600_000) }],
        },
      ],
    },
    history: {
      MARGINACCT01: (now) => [
        {
          // The bracket master again (history repeats open orders): it must appear once.
          client_order_id: "COMBO-1",
          combo_type: "MASTER",
          orders: [{ client_order_id: "M1", order_id: "ORD-MASTER", symbol: "AAPL", side: "BUY", status: "FILLED", order_type: "LIMIT", instrument_type: "EQUITY", time_in_force: "DAY", total_quantity: "5", filled_quantity: "5", filled_price: "149.9", limit_price: "150", place_time_at: isoAt(now - 2 * DAY), filled_time_at: isoAt(now - 2 * DAY + 5_000) }],
        },
        {
          client_order_id: "OPT1",
          combo_type: "NORMAL",
          orders: [
            {
              client_order_id: "OPT1",
              order_id: "ORD-OPT",
              symbol: "SPY",
              side: "SHORT",
              status: "FILLED",
              order_type: "LIMIT",
              instrument_type: "OPTION",
              option_strategy: "SINGLE",
              time_in_force: "DAY",
              total_quantity: "2",
              filled_quantity: "2",
              filled_price: "3.5",
              limit_price: "3.4",
              place_time_at: isoAt(now - 3 * DAY),
              filled_time_at: isoAt(now - 3 * DAY + 2_000),
              legs: [{ id: "LEG1", symbol: "SPY", side: "SHORT", quantity: "2", option_type: "CALL", strike_price: "600", option_expire_date: "2026-12-18", option_contract_multiplier: "100" }],
            },
          ],
        },
        {
          client_order_id: "X1",
          combo_type: "NORMAL",
          orders: [{ client_order_id: "X1", order_id: "ORD-CANCELLED", symbol: "NVDA", side: "BUY", status: "CANCELLED", order_type: "MARKET", instrument_type: "EQUITY", time_in_force: "DAY", total_quantity: "1", filled_quantity: "0", place_time_at: isoAt(now - 5 * DAY) }],
        },
        {
          // Placed 40 days ago: outside the 30 days Nasscord asks for.
          client_order_id: "OLD",
          combo_type: "NORMAL",
          orders: [{ client_order_id: "OLD", order_id: "ORD-OLD", symbol: "OLD", side: "BUY", status: "FILLED", order_type: "MARKET", instrument_type: "EQUITY", total_quantity: "1", filled_quantity: "1", filled_price: "1", place_time_at: isoAt(now - 40 * DAY) }],
        },
      ],
    },
    activities: {
      MARGINACCT01: (now) => {
        const ny = (/** @type {number} */ ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
        return [
          // The AAPL buy: 5 x 149.90 = 749.50, plus 0.05 of fees.
          { id: "ACT1", account_id: "MARGINACCT01", activity_type: "TRADE", activity_sub_type: "BUY", currency: "USD", market: "US", symbol: "AAPL", trade_date: ny(now - 2 * DAY + 5_000), net_amount: "-749.55", biz_time: isoAt(now - 2 * DAY + 5_000) },
          { id: "ACT2", account_id: "MARGINACCT01", activity_type: "DEPOSIT", activity_sub_type: "ACH", currency: "USD", market: "US", symbol: "", trade_date: ny(now - 10 * DAY), net_amount: "1000", biz_time: isoAt(now - 10 * DAY) },
        ];
      },
    },
  };
}

/**
 * @param {{
 *   now?: () => number,
 *   redirectUris?: string[],
 *   login?: Partial<FakeLogin>,
 *   refreshMode?: "fixed" | "sliding",
 *   pageSize?: number,
 * }} [opts]
 */
export async function startFakeWebull(opts = {}) {
  const clock = () => (opts.now ? opts.now() : Date.now());
  const app = { ...FAKE_WEBULL_APP };
  const redirectUris = new Set(opts.redirectUris ?? ["http://localhost:3000/api/broker/callback/webull"]);
  const state = {
    /** The Webull login the next approval signs in as. */
    login: /** @type {FakeLogin} */ ({ ...defaultLogin(), ...(opts.login ?? {}) }),
    refreshMode: opts.refreshMode ?? "fixed",
    pageSize: opts.pageSize ?? 2,
    /** @type {Map<string, { redirectUri: string, issuedAt: number, used: boolean, login: FakeLogin }>} */
    codes: new Map(),
    /** @type {Map<string, { login: FakeLogin, approvedAt: number, expiresAt: number }>} */
    refresh: new Map(),
    /** @type {Map<string, { login: FakeLogin, issuedAt: number }>} */
    access: new Map(),
    /** @type {Set<string>} */
    nonces: new Set(),
    /** @type {Array<{ method: string, path: string, query: Record<string, string>, signed: boolean, appSecretHeader: boolean, bearer: string | null, at: number }>} */
    calls: [],
    /** why: the fake's own reason for a refusal (never sent). @type {Array<{ grant: string, status: number, code?: string, why?: string }>} */
    tokenCalls: [],
    /** @type {Array<{ path: string, at: number }>} */
    limited: [],
    /** Every code, access token and refresh token issued (for leak checks). @type {string[]} */
    issued: [],
    deny: false,
    /** The next token call answers this (status and body), once. @type {{ status: number, body: unknown } | null} */
    failNextToken: /** @type {{ status: number, body: unknown } | null} */ (null),
    /**
     * Reads that answer `status` instead: `path` (any when left out) and `account` (an account_id;
     * any account when left out, and the account list only then).
     * @type {Array<{ path?: string, account?: string, status: number }>}
     */
    refuseReads: [],
    /** Milliseconds a read of a path waits before it answers. @type {Record<string, number>} */
    readDelayMs: {},
  };
  /** @type {Map<string, number[]>} user:path -> call times */
  const windows = new Map();

  const token = (/** @type {string} */ prefix) => {
    const t = `${prefix}${randomBytes(18).toString("base64url")}`;
    state.issued.push(t);
    return t;
  };

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} code @param {string} message */
  const fail = (res, status, code, message) => send(res, status, { error_code: code, message });
  /** Webull's documented refusals, with its own neutral messages. */
  const DOCUMENTED = /** @type {Record<number, { error_code: string, message: string }>} */ ({
    401: { error_code: "UNAUTHORIZED", message: "Insufficient permission" },
    403: { error_code: "FORBIDDEN", message: "Forbidden" },
    417: { error_code: "INVALID_PARAMETER", message: "Parameter error" },
    500: { error_code: "SYSTEM_ERROR", message: "Internal Server Error" },
  });

  /**
   * Webull's signature check. Answers why it fails, or null.
   * @param {import("node:http").IncomingMessage} req
   * @param {URL} url
   * @param {string} body
   * @param {string | null} version the x-version this endpoint takes
   */
  function signatureProblem(req, url, body, version) {
    const h = /** @type {Record<string, string>} */ (req.headers);
    if (h["x-app-key"] !== app.appKey) return "INVALID_APP_KEY";
    const algorithm = /** @type {any} */ (h["x-signature-algorithm"]);
    if (!WEBULL_ALGORITHMS.includes(algorithm) || h["x-signature-version"] !== "1.0") return "INVALID_SIGNATURE_ALGORITHM";
    if (version && h["x-version"] !== version) return "INVALID_VERSION";
    const ts = Date.parse(h["x-timestamp"] ?? "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(h["x-timestamp"] ?? "") || Math.abs(ts - clock()) > 5 * MIN) return "INVALID_TIMESTAMP";
    const nonce = h["x-signature-nonce"] ?? "";
    if (!nonce || state.nonces.has(nonce)) return "DUPLICATE_NONCE";
    state.nonces.add(nonce);
    const want = computeSignature({
      appKey: app.appKey,
      appSecret: app.appSecret,
      host: String(h.host),
      path: url.pathname,
      query: [...url.searchParams.entries()],
      body: body || null,
      timestamp: h["x-timestamp"],
      nonce,
      algorithm,
    });
    return want === h["x-signature"] ? null : "INVALID_SIGNATURE";
  }

  /** @param {FakeLogin} login @param {number} approvedAt */
  function issue(login, approvedAt) {
    const t = clock();
    const access = token("WBAT.");
    const refresh = token("WBRT.");
    const expiresAt = state.refreshMode === "sliding" ? t + 15 * DAY : approvedAt + 15 * DAY;
    state.access.set(access, { login, issuedAt: t });
    state.refresh.set(refresh, { login, approvedAt, expiresAt });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: "1800",
      refresh_token: refresh,
      rt_expires_in: String(Math.max(0, Math.floor((expiresAt - t) / 1000))),
      created_at: new Date(t).toISOString().replace("Z", "+0000"),
      identity_id: login.identityId,
    };
  }

  /**
   * At most `limit` calls of one user to one endpoint in `windowMs`.
   * @param {string} key @param {number} limit @param {number} windowMs
   */
  function overLimit(key, limit, windowMs) {
    const t = clock();
    const hits = (windows.get(key) ?? []).filter((at) => t - at < windowMs);
    if (hits.length >= limit) {
      windows.set(key, hits);
      return true;
    }
    hits.push(t);
    windows.set(key, hits);
    return false;
  }

  /**
   * A paged answer: `pageSize` items per page, the page number as the key.
   * @param {any[]} items @param {URL} url
   */
  function paged(items, url) {
    const page = Number(url.searchParams.get("pagination_key") ?? "0") || 0;
    const slice = items.slice(page * state.pageSize, (page + 1) * state.pageSize);
    const more = (page + 1) * state.pageSize < items.length;
    return { data: slice, ...(more ? { pagination_key: String(page + 1) } : {}) };
  }

  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;
    const call = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      signed: typeof req.headers["x-signature"] === "string",
      appSecretHeader: req.headers["x-app-secret"] !== undefined,
      bearer,
      at: clock(),
    };
    state.calls.push(call);
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const t = clock();
      if (call.appSecretHeader) return fail(res, 401, "UNAUTHORIZED", "The app secret must never be sent");

      if (req.method === "GET" && url.pathname === "/oauth2/auth-codes/get") {
        const q = url.searchParams;
        const redirectUri = q.get("redirect_uri") ?? "";
        if (q.get("response_type") !== "code" || q.get("client_id") !== app.clientId || !q.get("scope") || !q.get("state") || !redirectUris.has(redirectUri)) {
          return fail(res, 417, "INVALID_PARAMETER", "Parameter error");
        }
        const back = new URL(redirectUri);
        if (state.deny) {
          back.searchParams.set("error", "access_denied");
        } else {
          const code = token("WBCODE.");
          state.codes.set(code, { redirectUri, issuedAt: t, used: false, login: state.login });
          back.searchParams.set("code", code);
        }
        back.searchParams.set("state", String(q.get("state")));
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      if (req.method === "POST" && url.pathname === "/oauth2/tokens/create") {
        const fields = Object.fromEntries(new URLSearchParams(text));
        /** @param {number} status @param {unknown} body @param {string} [why] */
        const answer = (status, body, why) => {
          state.tokenCalls.push({ grant: String(fields.grant_type ?? ""), status, ...(status === 200 ? {} : { code: String(/** @type {any} */ (body)?.error_code ?? ""), why: why ?? "injected" }) });
          return send(res, status, body);
        };
        /** One of Webull's documented refusals. @param {401 | 417} status @param {string} why */
        const refuse = (status, why) => answer(status, DOCUMENTED[status], why);
        if (!String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return refuse(417, "FORM_EXPECTED");
        const problem = signatureProblem(req, url, text, "v2");
        if (problem) return refuse(401, problem);
        if (state.failNextToken) {
          const f = state.failNextToken;
          state.failNextToken = null;
          return answer(f.status, f.body);
        }
        if (fields.client_id !== app.clientId || fields.client_secret !== app.clientSecret) return refuse(401, "CLIENT");
        if (fields.grant_type === "authorization_code") {
          const c = state.codes.get(fields.code ?? "");
          if (!c || c.used) return refuse(417, "CODE_UNKNOWN_OR_USED");
          c.used = true;
          if (t - c.issuedAt > 60_000) return refuse(417, "CODE_EXPIRED");
          return answer(200, issue(c.login, t));
        }
        if (fields.grant_type === "refresh_token") {
          const r = state.refresh.get(fields.refresh_token ?? "");
          if (!r || r.expiresAt <= t) return refuse(417, "REFRESH_TOKEN_DEAD");
          // Rotation: the old refresh token dies with this answer.
          state.refresh.delete(String(fields.refresh_token));
          return answer(200, issue(r.login, r.approvedAt));
        }
        return refuse(417, "GRANT_TYPE");
      }

      if (!url.pathname.startsWith("/trading/")) return fail(res, 404, "NOT_FOUND", "not found");
      const grant = bearer ? state.access.get(bearer) : null;
      if (!grant || t - grant.issuedAt > 30 * MIN) return fail(res, 401, "UNAUTHORIZED", "Insufficient permission");
      if (call.signed) {
        const problem = signatureProblem(req, url, text, "v3");
        if (problem) return fail(res, 401, "UNAUTHORIZED", "Insufficient permission");
      }
      if (req.method !== "GET") return fail(res, 404, "NOT_FOUND", "not found");
      const login = grant.login;
      const user = login.identityId;
      const isAccounts = url.pathname === "/trading/accounts/list";
      const isCash = url.pathname === "/trading/activities/cash-activities/list";
      if (overLimit(`${user}:${url.pathname}`, isAccounts ? 10 : isCash ? 600 : 2, isAccounts ? 30_000 : isCash ? 60_000 : 2_000)) {
        state.limited.push({ path: url.pathname, at: t });
        return fail(res, 429, "TOO_MANY_REQUESTS", "Too many requests");
      }
      const accountId = url.searchParams.get("account_id") ?? "";
      const refusal = state.refuseReads.find((r) => (!r.path || r.path === url.pathname) && (r.account === undefined ? true : r.account === accountId));
      const delay = state.readDelayMs[url.pathname] ?? 0;
      if (delay > 0 || refusal) {
        setTimeout(() => (refusal ? send(res, refusal.status, DOCUMENTED[refusal.status] ?? DOCUMENTED[500]) : reply()), delay);
        return;
      }
      return reply();

      function reply() {
        if (isAccounts) return send(res, 200, login.accounts);

        if (!login.accounts.some((a) => a.account_id === accountId)) return fail(res, 417, "INVALID_PARAMETER", "account_id");
        switch (url.pathname) {
          case "/trading/assets/balances/get":
            return send(res, 200, login.balances[accountId] ?? {});
          case "/trading/assets/positions/list":
            return send(res, 200, login.positions[accountId] ?? []);
          case "/trading/orders/open-orders/list":
            return send(res, 200, paged(login.openOrders[accountId]?.(t) ?? [], url));
          case "/trading/orders/historical-orders/list": {
            const from = Date.parse(url.searchParams.get("start_time") ?? "");
            const to = Date.parse(url.searchParams.get("end_time") ?? "");
            // Without both bounds Webull answers the last 7 days only.
            const lo = Number.isFinite(from) ? from : t - 7 * DAY;
            const hi = Number.isFinite(to) ? to : t;
            const groups = (login.history[accountId]?.(t) ?? []).filter((g) => {
              const at = Date.parse(g.orders?.[0]?.place_time_at ?? "");
              return at >= lo && at <= hi;
            });
            return send(res, 200, paged(groups, url));
          }
          case "/trading/activities/cash-activities/list": {
            const from = Date.parse(url.searchParams.get("start_time") ?? "");
            const to = Date.parse(url.searchParams.get("end_time") ?? "");
            if (Number.isFinite(from) && Number.isFinite(to) && new Date(from).getUTCFullYear() !== new Date(to).getUTCFullYear()) {
              return fail(res, 417, "INVALID_PARAMETER", "Cross-year queries are not supported");
            }
            const types = (url.searchParams.get("activity_types") ?? "").split(",").filter(Boolean);
            const lo = Number.isFinite(from) ? from : t - 7 * DAY;
            const hi = Number.isFinite(to) ? to : t;
            const items = (login.activities[accountId]?.(t) ?? []).filter((a) => {
              const at = Date.parse(a.biz_time);
              return (!types.length || types.includes(a.activity_type)) && at >= lo && at <= hi;
            });
            return send(res, 200, paged(items, url));
          }
          default:
            return fail(res, 404, "NOT_FOUND", "not found");
        }
      }
    });
  });

  return {
    ...server,
    app,
    state,
    /** Forget every access token (Webull ended them early). */
    revokeAccess() {
      state.access.clear();
    },
    /** Forget every token (the user removed Nasscord in Webull). */
    revokeAll() {
      state.access.clear();
      state.refresh.clear();
    },
    /** Calls the service made (the browser's authorize visits left out). */
    serviceCalls() {
      return state.calls.filter((c) => c.path !== "/oauth2/auth-codes/get");
    },
  };
}
