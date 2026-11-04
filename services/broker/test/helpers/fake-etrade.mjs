import { randomBytes } from "node:crypto";
import { hmacSha1, parseAuthorizationHeader, signatureBaseString, signingKey } from "../../src/etrade/oauth1.mjs";
import { listen } from "./common.mjs";

/**
 * A local E*TRADE: OAuth 1.0a endpoints that VERIFY the HMAC-SHA1 signature of every request
 * (same base-string rules as RFC 5849, rebuilt from what arrives on the wire), plus the account
 * reads the service uses. Knobs let a test make E*TRADE rate-limit, idle out or kill a token.
 *
 * @param {{ consumerKey: string, consumerSecret: string, verifier?: string }} o
 */
export async function startFakeEtrade(o) {
  const verifier = o.verifier ?? "8XR2Q";
  /** @type {Map<string, { secret: string }>} */
  const requestTokens = new Map();
  /** @type {Map<string, { secret: string, active: boolean, dead: boolean }>} */
  const accessTokens = new Map();
  const nonces = new Set();
  const state = {
    /** answer the next N calls with E*TRADE's HTML 400 (rate limited) */
    rateLimitNext: 0,
    /** @type {Array<{ path: string, token: string | undefined }>} */
    calls: [],
    signatureFailures: 0,
  };
  // Tokens carry "+", "/" and "=" like real E*TRADE tokens, to catch decoding mistakes.
  const token = () => `${randomBytes(12).toString("base64")}+/=`;

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {string} body @param {string} [type] */
  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  /** @param {import("node:http").ServerResponse} res @param {string} problem */
  const unauthorized = (res, problem) => send(res, 401, `oauth_problem=${problem}`, "text/plain");

  const ACCOUNTS = {
    AccountListResponse: {
      Accounts: {
        Account: [
          { accountId: "84012345", accountIdKey: "keyAlpha", accountMode: "MARGIN", accountDesc: "Brokerage", accountType: "INDIVIDUAL", institutionType: "BROKERAGE", accountStatus: "ACTIVE" },
          { accountId: "84055555", accountIdKey: "keyRoth", accountMode: "CASH", accountDesc: "Roth IRA", accountType: "ROTHIRA", institutionType: "BROKERAGE", accountStatus: "ACTIVE" },
          { accountId: "84000000", accountIdKey: "keyClosed", accountDesc: "Old", accountStatus: "CLOSED" },
        ],
      },
    },
  };
  /** @param {string} sym @param {number} id @param {number} qty */
  const position = (sym, id, qty) => ({
    positionId: id,
    symbolDescription: sym,
    quantity: qty,
    positionType: "LONG",
    daysGain: 10,
    marketValue: qty * 100,
    totalGain: qty * 5,
    costPerShare: 95,
    Quick: { lastTrade: 100 },
    Product: { symbol: sym, securityType: "EQ" },
  });

  const server = await listen((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${server.port}`);
    const auth = parseAuthorizationHeader(String(req.headers.authorization ?? ""));
    if (!auth) return unauthorized(res, "parameter_absent");
    if (auth.oauth_consumer_key !== o.consumerKey) return unauthorized(res, "consumer_key_rejected");
    const t = auth.oauth_token;
    const tokenSecret = t ? requestTokens.get(t)?.secret ?? accessTokens.get(t)?.secret ?? "" : "";
    const params = /** @type {Array<[string, string]>} */ (Object.entries(auth).filter(([k]) => k !== "oauth_signature" && k !== "realm"));
    const expected = hmacSha1(signatureBaseString("GET", url.href, params), signingKey(o.consumerSecret, tokenSecret));
    if (expected !== auth.oauth_signature) {
      state.signatureFailures++;
      return unauthorized(res, "signature_invalid");
    }
    if (nonces.has(auth.oauth_nonce)) return unauthorized(res, "nonce_used");
    nonces.add(auth.oauth_nonce);
    state.calls.push({ path: url.pathname, token: t });

    if (state.rateLimitNext > 0) {
      state.rateLimitNext--;
      return send(res, 400, "<html><body>Bad Request</body></html>", "text/html");
    }

    if (url.pathname === "/oauth/request_token") {
      if (auth.oauth_callback !== "oob" || t) return unauthorized(res, "parameter_rejected");
      const rt = token();
      const rs = token();
      requestTokens.set(rt, { secret: rs });
      return send(res, 200, `oauth_token=${encodeURIComponent(rt)}&oauth_token_secret=${encodeURIComponent(rs)}&oauth_callback_confirmed=true`, "text/plain");
    }
    if (url.pathname === "/oauth/access_token") {
      if (!t || !requestTokens.has(t)) return unauthorized(res, "token_rejected");
      if (auth.oauth_verifier !== verifier) return unauthorized(res, "verifier_invalid");
      requestTokens.delete(t);
      const at = token();
      const as = token();
      accessTokens.set(at, { secret: as, active: true, dead: false });
      return send(res, 200, `oauth_token=${encodeURIComponent(at)}&oauth_token_secret=${encodeURIComponent(as)}`, "text/plain");
    }

    const access = t ? accessTokens.get(t) : undefined;
    if (!access) return unauthorized(res, "token_rejected");
    if (access.dead) return unauthorized(res, "token_expired");

    if (url.pathname === "/oauth/renew_access_token") {
      access.active = true;
      return send(res, 200, "Access Token has been renewed", "text/plain");
    }
    if (url.pathname === "/oauth/revoke_access_token") {
      access.dead = true;
      return send(res, 200, "Revoked Access Token", "text/plain");
    }
    if (!access.active) return unauthorized(res, "token_rejected");

    if (url.pathname === "/v1/accounts/list") return send(res, 200, JSON.stringify(ACCOUNTS));
    const m = /^\/v1\/accounts\/([^/]+)\/(balance|portfolio|orders)$/.exec(url.pathname);
    if (!m) return send(res, 404, JSON.stringify({ Error: { code: 404, message: "not here" } }));
    const [, key, what] = m;
    if (what === "balance") {
      if (url.searchParams.get("instType") !== "BROKERAGE" || url.searchParams.get("realTimeNAV") !== "true") {
        return send(res, 400, JSON.stringify({ Error: { message: "instType required" } }));
      }
      return send(res, 200, JSON.stringify({
        BalanceResponse: {
          accountMode: key === "keyAlpha" ? "MARGIN" : "CASH",
          Computed: { marginBuyingPower: 50_000, cashBuyingPower: 20_000, cashBalance: 10_000, RealTimeValues: { totalAccountValue: key === "keyAlpha" ? 100_000 : 30_000 } },
        },
      }));
    }
    if (what === "portfolio") {
      if (key !== "keyAlpha") return send(res, 204, "");
      const page = Number(url.searchParams.get("pageNumber") ?? 1);
      const list = page === 1 ? [position("AAPL", 1, 10), position("MSFT", 2, 5)] : [position("NVDA", 3, 7)];
      return send(res, 200, JSON.stringify({
        PortfolioResponse: {
          Totals: { todaysGainLoss: 123.45 },
          AccountPortfolio: [{ accountId: "84012345", totalPages: 2, nextPageNo: page === 1 ? 2 : undefined, Position: list }],
        },
      }));
    }
    if (key !== "keyAlpha") return send(res, 204, "");
    return send(res, 200, JSON.stringify({
      OrdersResponse: {
        Order: [
          {
            orderId: 501,
            OrderDetail: [{
              placedTime: Date.parse("2026-11-03T14:31:00Z"),
              executedTime: Date.parse("2026-11-03T14:31:02Z"),
              status: "EXECUTED",
              orderTerm: "GOOD_FOR_DAY",
              priceType: "LIMIT",
              limitPrice: 99.5,
              Instrument: [{ Product: { symbol: "AAPL", securityType: "EQ" }, orderAction: "BUY", orderedQuantity: 10, filledQuantity: 10, averageExecutionPrice: 99.4, estimatedCommission: 0 }],
            }],
          },
          {
            orderId: 502,
            OrderDetail: [{
              placedTime: Date.parse("2026-11-03T15:00:00Z"),
              status: "OPEN",
              orderTerm: "GOOD_UNTIL_CANCEL",
              priceType: "STOP",
              stopPrice: 90,
              Instrument: [{ Product: { symbol: "AAPL", securityType: "EQ" }, orderAction: "SELL", orderedQuantity: 10 }],
            }],
          },
        ],
      },
    }));
  });

  return {
    ...server,
    state,
    verifier,
    urls: {
      oauthBase: server.url,
      apiBase: { production: server.url, sandbox: server.url },
      authorizeUrl: `${server.url}/e/t/etws/authorize`,
    },
    /** the last access token issued (for idle / kill simulations) */
    lastAccessToken: () => [...accessTokens.keys()].at(-1),
    /** @param {string} t E*TRADE's 2-hour idle: renew wakes it */
    idle: (t) => {
      const a = accessTokens.get(t);
      if (a) a.active = false;
    },
    /** @param {string} t midnight: renew no longer works */
    kill: (t) => {
      const a = accessTokens.get(t);
      if (a) a.dead = true;
    },
    isDead: (/** @type {string} */ t) => !!accessTokens.get(t)?.dead,
  };
}
