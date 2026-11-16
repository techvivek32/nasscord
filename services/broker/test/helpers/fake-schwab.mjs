import { createHash, randomBytes } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake Charles Schwab (OAuth + Trader API) on one local port, close to what Schwab does:
 *
 * OAuth (/v1/oauth/*)
 * - GET /v1/oauth/authorize: an unknown App Key, or a redirect_uri that is not exactly the app's
 *   registered callback (a trailing slash included), answers Schwab's HTML "We are unable to complete
 *   your request". Otherwise 302 back with state and a URL-encoded code that contains "@" (as
 *   Schwab's codes do). `deny` answers error=access_denied.
 * - POST /v1/oauth/token: HTTP Basic with the App Key and Secret, form body. Codes are single use and
 *   live 30 seconds on the fake clock; redirect_uri must match the one at authorize. A refresh token
 *   older than 7 days answers 400 invalid_client (or `expiredRefreshError`). A refresh answers a new
 *   access token and the same refresh token. Access tokens live 30 minutes.
 * - The token answer carries an id_token whose `sub` is the login's, unless `login.sub` is null.
 *
 * Trader API (/trader/v1/*), Bearer access token required (401 otherwise)
 * - accounts/accountNumbers, accounts[?fields=positions], accounts/{hash}/orders (both
 *   fromEnteredTime and toEnteredTime required), accounts/{hash}/transactions (types, startDate and
 *   endDate required), userPreference. A plain account number or an unknown hash in a path is 400.
 * - Anything else is 404 and stays in `calls`, so a test can prove nothing outside the read set was
 *   asked for.
 *
 * Every request is recorded with its method, path and query keys and values (test memory only).
 */

/**
 * @typedef {{
 *   number: string,
 *   type: "MARGIN" | "CASH",
 *   nickName: string,
 *   balances: Record<string, number>,
 *   positions: any[],
 *   orders: (now: number) => any[],
 *   transactions: (now: number) => any[],
 * }} FakeAccount
 * @typedef {{ sub: string | null, accounts: FakeAccount[] }} FakeLogin
 */

const DAY = 24 * 3_600_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

/** The default login: a margin account with stock and an option, and a Roth IRA (cash). */
export function defaultAccounts() {
  /** @type {FakeAccount[]} */
  const accounts = [
    {
      number: "12345678",
      type: "MARGIN",
      nickName: "Trading",
      balances: { liquidationValue: 25_340.5, cashBalance: 10_000.25, buyingPower: 40_000, availableFunds: 20_000 },
      positions: [
        {
          shortQuantity: 0,
          averagePrice: 150.25,
          currentDayProfitLoss: 12.5,
          longQuantity: 10,
          instrument: { assetType: "EQUITY", cusip: "037833100", symbol: "AAPL" },
          marketValue: 1_515,
          longOpenProfitLoss: 12.5,
        },
        {
          shortQuantity: 2,
          averagePrice: 3.1,
          currentDayProfitLoss: -20,
          longQuantity: 0,
          instrument: { assetType: "OPTION", cusip: "0SPY..XX40000", symbol: "SPY   261218C00600000" },
          marketValue: -700,
          shortOpenProfitLoss: -80,
        },
        {
          shortQuantity: 0,
          longQuantity: 0,
          averagePrice: 10,
          instrument: { assetType: "EQUITY", symbol: "ZERO" },
          marketValue: 0,
        },
      ],
      orders: (now) => [
        {
          session: "NORMAL",
          duration: "DAY",
          orderType: "LIMIT",
          quantity: 10,
          filledQuantity: 10,
          remainingQuantity: 0,
          price: 150,
          orderLegCollection: [{ orderLegType: "EQUITY", legId: 1, instrument: { assetType: "EQUITY", symbol: "AAPL" }, instruction: "BUY", quantity: 10 }],
          orderStrategyType: "SINGLE",
          orderId: 1_000_001,
          status: "FILLED",
          enteredTime: iso(now - 2 * DAY),
          closeTime: iso(now - 2 * DAY + 1_000),
          accountNumber: 12_345_678,
          orderActivityCollection: [
            {
              activityType: "EXECUTION",
              activityId: 9_001,
              executionType: "FILL",
              quantity: 10,
              executionLegs: [
                { legId: 1, quantity: 4, price: 149.9, time: iso(now - 2 * DAY + 500) },
                { legId: 1, quantity: 6, price: 150, time: iso(now - 2 * DAY + 900) },
              ],
            },
          ],
        },
        {
          session: "SEAMLESS",
          duration: "GOOD_TILL_CANCEL",
          orderType: "STOP",
          quantity: 5,
          filledQuantity: 0,
          stopPrice: 140,
          orderLegCollection: [{ legId: 1, instrument: { assetType: "EQUITY", symbol: "AAPL" }, instruction: "SELL", quantity: 5 }],
          orderStrategyType: "TRIGGER",
          orderId: 1_000_002,
          status: "WORKING",
          enteredTime: iso(now - 1 * DAY),
          childOrderStrategies: [
            {
              session: "NORMAL",
              duration: "DAY",
              orderType: "TRAILING_STOP",
              quantity: 5,
              stopPriceLinkType: "PERCENT",
              stopPriceOffset: 2.5,
              orderLegCollection: [{ legId: 1, instrument: { assetType: "EQUITY", symbol: "AAPL" }, instruction: "SELL", quantity: 5 }],
              orderId: 1_000_003,
              status: "AWAITING_PARENT_ORDER",
              enteredTime: iso(now - 1 * DAY),
            },
          ],
        },
        {
          session: "NORMAL",
          duration: "DAY",
          orderType: "MARKET",
          quantity: 2,
          filledQuantity: 2,
          orderLegCollection: [{ legId: 1, instrument: { assetType: "OPTION", symbol: "SPY   261218C00600000" }, instruction: "SELL_TO_OPEN", quantity: 2 }],
          orderId: 1_000_004,
          status: "FILLED",
          enteredTime: iso(now - 3_600_000),
          orderActivityCollection: [
            { activityType: "EXECUTION", activityId: 9_002, executionLegs: [{ legId: 1, quantity: 2, price: 3.5, time: iso(now - 3_600_000 + 2_000) }] },
          ],
        },
        {
          // Entered outside the 60-day window: never answered when both bounds are sent.
          session: "NORMAL",
          duration: "DAY",
          orderType: "LIMIT",
          price: 1,
          orderLegCollection: [{ legId: 1, instrument: { assetType: "EQUITY", symbol: "OLD" }, instruction: "BUY", quantity: 1 }],
          orderId: 999,
          status: "CANCELED",
          enteredTime: iso(now - 90 * DAY),
        },
      ],
      transactions: (now) => [
        {
          activityId: 7_001,
          time: iso(now - 2 * DAY + 1_000),
          accountNumber: "12345678",
          type: "TRADE",
          orderId: 1_000_001,
          netAmount: -1_499.9 - 0.65,
          transferItems: [
            { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: 0, cost: -0.65, feeType: "COMMISSION" },
            { instrument: { assetType: "CURRENCY", symbol: "CURRENCY_USD" }, amount: 0, cost: 0, feeType: "SEC_FEE" },
            { instrument: { assetType: "EQUITY", symbol: "AAPL" }, amount: 10, cost: -1_499.6, price: 149.96, positionEffect: "OPENING" },
          ],
        },
      ],
    },
    {
      number: "87654321",
      type: "CASH",
      nickName: "Roth Contributory IRA",
      balances: { liquidationValue: 5_000, cashBalance: 5_000, cashAvailableForTrading: 4_900 },
      positions: [],
      orders: () => [],
      transactions: () => [],
    },
  ];
  return accounts;
}

/**
 * @param {{
 *   now?: () => number,
 *   apps?: Array<{ key: string, secret: string, callback: string }>,
 *   login?: Partial<FakeLogin>,
 * }} [opts]
 */
export async function startFakeSchwab(opts = {}) {
  const clock = () => (opts.now ? opts.now() : Date.now());
  const apps = new Map((opts.apps ?? [{ key: "SchwabAppKeyQwErTyUiOpAsDfGhJkLz", secret: "SchwabSecret0123", callback: "http://localhost:3000/api/broker/callback/schwab" }]).map((a) => [a.key, a]));
  const state = {
    /** The Schwab login the next approval signs in as (tests switch it). */
    login: /** @type {FakeLogin} */ ({ sub: "schwab-login-1", accounts: defaultAccounts(), ...(opts.login ?? {}) }),
    /** @type {Map<string, { appKey: string, redirectUri: string, issuedAt: number, used: boolean, login: FakeLogin }>} */
    codes: new Map(),
    /** @type {Map<string, { appKey: string, issuedAt: number, login: FakeLogin }>} */
    refresh: new Map(),
    /** @type {Map<string, { appKey: string, issuedAt: number, login: FakeLogin }>} */
    access: new Map(),
    /** @type {Array<{ method: string, path: string, query: Record<string, string> }>} */
    calls: [],
    /** @type {Array<{ grant: string, status: number }>} */
    tokenCalls: [],
    /** Every code, access token and refresh token issued (for leak checks). */
    /** @type {string[]} */
    issued: [],
    deny: false,
    /** what a refresh token older than 7 days answers */
    expiredRefreshError: "invalid_client",
    /** when set, the next refresh answers 400 with this error */
    /** @type {string | null} */
    failRefreshWith: /** @type {string | null} */ (null),
    /** changes every hashValue (Schwab may re-key them) */
    hashSalt: "v1",
  };
  const token = (/** @type {string} */ prefix) => {
    const t = `${prefix}${randomBytes(18).toString("base64url")}`;
    state.issued.push(t);
    return t;
  };
  /** @param {string} n */
  const hashOf = (n) => createHash("sha256").update(`${state.hashSalt}:${n}`).digest("hex").toUpperCase();

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  /** @param {import("node:http").ServerResponse} res */
  const unable = (res) => {
    res.writeHead(400, { "content-type": "text/html" });
    res.end("<html><body><h1>We are unable to complete your request</h1></body></html>");
  };

  /** @param {FakeLogin} login @param {string} appKey */
  function issueTokens(login, appKey, withId = true) {
    const access = token("AT.");
    const refresh = token("RT.");
    const t = clock();
    state.access.set(access, { appKey, issuedAt: t, login });
    state.refresh.set(refresh, { appKey, issuedAt: t, login });
    /** @type {Record<string, unknown>} */
    const out = { expires_in: 1800, token_type: "Bearer", scope: "api", refresh_token: refresh, access_token: access };
    if (withId && login.sub) out.id_token = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: login.sub, aud: appKey, iss: "fake-schwab" })).toString("base64url")}.sig`;
    return out;
  }

  /** @param {import("node:http").IncomingMessage} req */
  function basicApp(req) {
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ""));
    if (!m) return null;
    const raw = Buffer.from(m[1], "base64").toString("utf8");
    const i = raw.indexOf(":");
    const app = apps.get(raw.slice(0, i));
    return app && app.secret === raw.slice(i + 1) ? app : null;
  }

  /** @param {FakeLogin} login @param {string} hash */
  const accountByHash = (login, hash) => login.accounts.find((a) => hashOf(a.number) === hash) ?? null;

  /** @param {FakeAccount} a @param {boolean} positions */
  const accountJson = (a, positions) => ({
    securitiesAccount: {
      type: a.type,
      accountNumber: a.number,
      roundTrips: 0,
      isDayTrader: false,
      ...(positions ? { positions: a.positions } : {}),
      initialBalances: {},
      currentBalances: a.balances,
      projectedBalances: {},
    },
    aggregatedBalance: { currentLiquidationValue: a.balances.liquidationValue, liquidationValue: a.balances.liquidationValue },
  });

  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    state.calls.push({ method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams) });
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const t = clock();

      if (req.method === "GET" && url.pathname === "/v1/oauth/authorize") {
        const app = apps.get(url.searchParams.get("client_id") ?? "");
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!app || redirectUri !== app.callback || url.searchParams.get("response_type") !== "code") return unable(res);
        const back = new URL(redirectUri);
        if (state.deny) {
          back.searchParams.set("error", "access_denied");
        } else {
          // Schwab's codes end in "@" and arrive URL-encoded (%40); the service gets them decoded.
          const code = `C0.${randomBytes(18).toString("base64url")}@`;
          state.issued.push(code);
          state.codes.set(code, { appKey: app.key, redirectUri, issuedAt: t, used: false, login: state.login });
          back.searchParams.set("code", code);
        }
        const st = url.searchParams.get("state");
        if (st) back.searchParams.set("state", st);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      if (req.method === "POST" && url.pathname === "/v1/oauth/token") {
        const fields = Object.fromEntries(new URLSearchParams(text));
        /** @param {number} status @param {unknown} body */
        const answer = (status, body) => {
          state.tokenCalls.push({ grant: String(fields.grant_type ?? ""), status });
          return send(res, status, body);
        };
        const app = basicApp(req);
        if (!app) return answer(401, { error: "invalid_client", error_description: "Unauthorized" });
        if (fields.grant_type === "authorization_code") {
          const c = state.codes.get(fields.code ?? "");
          if (!c || c.used || c.appKey !== app.key) return answer(400, { error: "invalid_grant" });
          c.used = true;
          if (t - c.issuedAt > 30_000) return answer(400, { error: "invalid_grant", error_description: "code expired" });
          if (fields.redirect_uri !== c.redirectUri) return answer(400, { error: "invalid_grant" });
          return answer(200, issueTokens(c.login, app.key));
        }
        if (fields.grant_type === "refresh_token") {
          const r = state.refresh.get(fields.refresh_token ?? "");
          if (!r || r.appKey !== app.key) return answer(400, { error: "invalid_grant" });
          if (t - r.issuedAt > 7 * DAY) return answer(400, { error: state.expiredRefreshError, error_description: "refresh token expired" });
          if (state.failRefreshWith) {
            const error = state.failRefreshWith;
            state.failRefreshWith = null;
            return answer(400, { error, error_description: "Failed refresh token authentication" });
          }
          const access = token("AT.");
          state.access.set(access, { appKey: app.key, issuedAt: t, login: r.login });
          return answer(200, { expires_in: 1800, token_type: "Bearer", scope: "api", refresh_token: fields.refresh_token, access_token: access });
        }
        return answer(400, { error: "unsupported_grant_type" });
      }

      if (!url.pathname.startsWith("/trader/v1/")) return send(res, 404, { message: "not found" });
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? "";
      const grant = state.access.get(bearer);
      if (!grant || t - grant.issuedAt > 30 * 60_000) return send(res, 401, { message: "Client not authorized" });
      if (req.method !== "GET") return send(res, 404, { message: "not found" });
      const login = grant.login;

      if (url.pathname === "/trader/v1/accounts/accountNumbers") {
        return send(res, 200, login.accounts.map((a) => ({ accountNumber: a.number, hashValue: hashOf(a.number) })));
      }
      if (url.pathname === "/trader/v1/accounts") {
        return send(res, 200, login.accounts.map((a) => accountJson(a, url.searchParams.get("fields") === "positions")));
      }
      if (url.pathname === "/trader/v1/userPreference") {
        return send(res, 200, {
          accounts: login.accounts.map((a, i) => ({ accountNumber: a.number, primaryAccount: i === 0, type: "BROKERAGE", nickName: a.nickName, displayAcctId: `...${a.number.slice(-3)}` })),
          streamerInfo: [{ streamerSocketUrl: "wss://streamer.invalid", schwabClientCustomerId: "customer-id-not-for-storage", schwabClientCorrelId: "correl" }],
          offers: [{ level2Permissions: false, mktDataPermission: "NP" }],
        });
      }
      const m = /^\/trader\/v1\/accounts\/([^/]+)\/(orders|transactions)$/.exec(url.pathname);
      if (m) {
        const account = accountByHash(login, m[1]);
        if (!account) return send(res, 400, { message: "Invalid account number", errors: ["account"] });
        if (m[2] === "orders") {
          const from = Date.parse(url.searchParams.get("fromEnteredTime") ?? "");
          const to = Date.parse(url.searchParams.get("toEnteredTime") ?? "");
          if (!Number.isFinite(from) || !Number.isFinite(to)) return send(res, 400, { message: "fromEnteredTime and toEnteredTime are required" });
          if (to - from > 366 * DAY) return send(res, 400, { message: "range too long" });
          return send(res, 200, account.orders(t).filter((o) => {
            const at = Date.parse(o.enteredTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
            return at >= from && at <= to;
          }));
        }
        const start = Date.parse(url.searchParams.get("startDate") ?? "");
        const end = Date.parse(url.searchParams.get("endDate") ?? "");
        if (!url.searchParams.get("types") || !Number.isFinite(start) || !Number.isFinite(end)) return send(res, 400, { message: "types, startDate and endDate are required" });
        return send(res, 200, account.transactions(t));
      }
      return send(res, 404, { message: "not found" });
    });
  });

  return {
    ...server,
    state,
    apps,
    hashOf,
    /** Forget every access token (Schwab invalidated them early). */
    revokeAccess() {
      state.access.clear();
    },
    /** Forget every refresh token too (the user removed the app's access at Schwab). */
    revokeAll() {
      state.access.clear();
      state.refresh.clear();
    },
    /** Calls the service made (the browser's authorize visits left out). */
    serviceCalls() {
      return state.calls.filter((c) => c.path !== "/v1/oauth/authorize");
    },
  };
}
