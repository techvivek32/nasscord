import { randomBytes } from "node:crypto";
import { hmacSha1, parseAuthorizationHeader, signatureBaseString, signingKey } from "../../src/etrade/oauth1.mjs";
import { etDateKey } from "../../src/time.mjs";
import { listen } from "./common.mjs";

/**
 * A local E*TRADE: OAuth 1.0a endpoints that VERIFY the HMAC-SHA1 signature of every request
 * (same base-string rules as RFC 5849, rebuilt from what arrives on the wire, with the request's own
 * method), plus the account reads the service uses, the quote, and the order calls (preview, place,
 * cancel) against a per-account order book. Order bodies are read as XML (application/xml, with a
 * small parser that understands exactly what encodeOrderBody writes) or JSON. Knobs let a test make
 * E*TRADE rate-limit, idle out, kill a token, or answer an order call in a chosen way.
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
  /** @type {Map<number, { key: string, clientOrderId: string, order: any, at: number }>} */
  const previews = new Map();
  /** @type {Set<string>} "<key>:<clientOrderId>" of placed orders */
  const usedClientIds = new Set();

  const state = {
    /** answer the next N calls with E*TRADE's HTML 400 (rate limited) */
    rateLimitNext: 0,
    /** @type {Array<{ method: string, path: string, token: string | undefined }>} */
    calls: [],
    signatureFailures: 0,
    /** @type {Array<"xml" | "json" | "other">} the body format of each order call */
    bodyTypes: [],
    /** @type {Array<{ method: string, path: string, contentType: string, accept: string, body: string, parsed: any }>} every order call */
    writes: [],
    previewCalls: 0,
    placeCalls: 0,
    cancelCalls: 0,
    quoteCalls: 0,
    /**
     * The next call whose path ends with `path` answers this way (once):
     * drop (socket destroyed, nothing recorded), accept_then_drop (recorded, then the socket is destroyed),
     * xml_error / json_error (400 with code and message), html_rate_limit, html_400, status_302,
     * status_500, "401".
     * @type {{ path: string, kind: "drop" | "accept_then_drop" | "xml_error" | "json_error" | "html_rate_limit" | "html_400" | "status_302" | "status_500" | "401", code?: number, message?: string } | null}
     */
    failNext: null,
    /** @type {Record<string, any[][]>} account key -> portfolio pages of positions */
    positions: /** @type {Record<string, any[][]>} */ ({}),
    /** The portfolio page total: "totalPages" (the sample), "totalNoOfPages" (the field reference) or "none". */
    portfolioTotal: /** @type {"totalPages" | "totalNoOfPages" | "none"} */ ("totalPages"),
    /** @type {Record<string, any[]>} account key -> orders as E*TRADE lists them */
    orders: /** @type {Record<string, any[]>} */ ({}),
    /** @type {Record<string, { bid?: number, ask?: number, lastTrade?: number, companyName?: string, quoteStatus?: string, dateTimeUTC?: number }>} */
    quotes: /** @type {Record<string, any>} */ ({}),
    /** @type {any[]} Message objects added to the next previews' Order echo ({ code, description, type }) */
    previewMessages: /** @type {any[]} */ ([]),
    /** @type {((order: any, response: any) => void) | null} changes the preview answer before it is sent */
    previewEcho: /** @type {((order: any, response: any) => void) | null} */ (null),
    /** @type {((order: any, response: any) => void) | null} changes the place answer before it is sent */
    placeEcho: /** @type {((order: any, response: any) => void) | null} */ (null),
    /** @type {Array<Record<string, string>>} the query of every orders list read */
    ordersQueries: /** @type {Array<Record<string, string>>} */ ([]),
    /**
     * List Orders paging as E*TRADE does it: pages of at most this many orders (oldest first), each with
     * a `marker` for the next page while more remain. Null: the old behaviour (the newest `count`).
     * @type {number | null}
     */
    ordersPageSize: /** @type {number | null} */ (null),
    /** With ordersPageSize: answer pages without the marker (a cut list Nasscord cannot recognise by marker). */
    ordersOmitMarker: false,
    nextOrderId: 1001,
    nextPreviewId: 3_429_395_279,
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
  /** @type {Record<string, string>} */
  const ACCOUNT_NUMBER = { keyAlpha: "84012345", keyRoth: "84055555" };

  state.positions.keyAlpha = [[etradePositionRow("AAPL", 1, 10), etradePositionRow("MSFT", 2, 5)], [etradePositionRow("NVDA", 3, 7)]];
  state.orders.keyAlpha = [
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
  ];
  state.quotes.AAPL = { bid: 99.9, ask: 100.1, lastTrade: 100, companyName: "APPLE INC COM", quoteStatus: "REALTIME", dateTimeUTC: 1_763_650_800 };

  /** @param {number} code @param {string} message */
  const jsonError = (code, message) => JSON.stringify({ Error: { code, message } });

  /**
   * @param {import("node:http").IncomingMessage} req
   * @returns {Promise<string>}
   */
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server = await listen(async (req, res) => {
    const raw = await readBody(req);
    const method = String(req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${server.port}`);
    const auth = parseAuthorizationHeader(String(req.headers.authorization ?? ""));
    if (!auth) return unauthorized(res, "parameter_absent");
    if (auth.oauth_consumer_key !== o.consumerKey) return unauthorized(res, "consumer_key_rejected");
    const t = auth.oauth_token;
    const tokenSecret = t ? requestTokens.get(t)?.secret ?? accessTokens.get(t)?.secret ?? "" : "";
    const params = /** @type {Array<[string, string]>} */ (Object.entries(auth).filter(([k]) => k !== "oauth_signature" && k !== "realm"));
    // An XML or JSON body is not part of the base string (RFC 5849 3.4.1.3.1).
    const expected = hmacSha1(signatureBaseString(method, url.href, params), signingKey(o.consumerSecret, tokenSecret));
    if (expected !== auth.oauth_signature) {
      state.signatureFailures++;
      return unauthorized(res, "signature_invalid");
    }
    if (nonces.has(auth.oauth_nonce)) return unauthorized(res, "nonce_used");
    nonces.add(auth.oauth_nonce);
    state.calls.push({ method, path: url.pathname, token: t });

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

    // Order calls: record the body and its format.
    const write = /^\/v1\/accounts\/([^/]+)\/orders\/(preview|place|cancel)\.json$/.exec(url.pathname);
    /** @type {any} */
    let parsed = null;
    if (method === "POST" || method === "PUT") {
      const contentType = String(req.headers["content-type"] ?? "");
      const kind = /xml/i.test(contentType) ? "xml" : /json/i.test(contentType) ? "json" : "other";
      try {
        parsed = kind === "xml" ? parseOrderXml(raw) : kind === "json" ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      state.bodyTypes.push(kind);
      state.writes.push({ method, path: url.pathname, contentType, accept: String(req.headers.accept ?? ""), body: raw, parsed });
    }
    if (write?.[2] === "preview") state.previewCalls++;
    if (write?.[2] === "place") state.placeCalls++;
    if (write?.[2] === "cancel") state.cancelCalls++;
    if (url.pathname.startsWith("/v1/market/quote/")) state.quoteCalls++;

    const fail = state.failNext && url.pathname.endsWith(state.failNext.path) ? state.failNext : null;
    if (fail) state.failNext = null;
    if (fail?.kind === "drop") {
      req.socket.destroy();
      return;
    }
    if (fail && fail.kind !== "accept_then_drop") {
      const code = fail.code ?? 1021;
      const message = fail.message ?? "We cannot accept this order because there are insufficient funds in your account.";
      if (fail.kind === "xml_error") return send(res, 400, `<Error><code>${code}</code><message>${xmlEscape(message)}</message></Error>`, "application/xml");
      if (fail.kind === "json_error") return send(res, 400, jsonError(code, message));
      if (fail.kind === "html_rate_limit") return send(res, 400, "<html><body>Number of requests exceeded the rate limit set</body></html>", "text/html");
      if (fail.kind === "html_400") return send(res, 400, "<html><body>Bad Request</body></html>", "text/html");
      if (fail.kind === "status_302") {
        res.writeHead(302, { location: "https://us.etrade.com/home" });
        return res.end();
      }
      if (fail.kind === "status_500") return send(res, 500, jsonError(41002, "Orders are temporarily unavailable. Please try again later."));
      if (fail.kind === "401") return unauthorized(res, "token_rejected");
    }

    /** @param {number} status @param {string} body @param {string} [type] */
    const answer = (status, body, type) => {
      if (fail?.kind === "accept_then_drop") {
        req.socket.destroy();
        return;
      }
      send(res, status, body, type);
    };

    if (method === "GET" && url.pathname === "/v1/accounts/list") return answer(200, JSON.stringify(ACCOUNTS));

    const quote = /^\/v1\/market\/quote\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && quote) {
      const sym = decodeURIComponent(quote[1]);
      const q = state.quotes[sym];
      if (!q) return answer(200, JSON.stringify({ QuoteResponse: { Messages: { Message: [{ description: `Invalid Symbol: ${sym}`, code: 1002, type: "WARNING" }] } } }));
      return answer(200, JSON.stringify({
        QuoteResponse: {
          QuoteData: [{
            dateTimeUTC: q.dateTimeUTC,
            quoteStatus: q.quoteStatus ?? "REALTIME",
            ahFlag: "false",
            Product: { symbol: sym, securityType: "EQ" },
            All: { bid: q.bid ?? 0, ask: q.ask ?? 0, lastTrade: q.lastTrade ?? 0, companyName: q.companyName ?? "" },
          }],
        },
      }));
    }

    if (write) {
      const key = decodeURIComponent(write[1]);
      if (!ACCOUNT_NUMBER[key]) return answer(400, jsonError(100, "The account key does not belong to the user."));
      if (write[2] === "preview" && method === "POST") return answer(...preview(key, parsed));
      if (write[2] === "place" && method === "POST") return answer(...place(key, parsed));
      if (write[2] === "cancel" && method === "PUT") return answer(...cancel(key, parsed));
      return answer(405, jsonError(405, "method not allowed"));
    }

    const m = /^\/v1\/accounts\/([^/]+)\/(balance|portfolio|orders)$/.exec(url.pathname);
    if (!m || method !== "GET") return answer(404, JSON.stringify({ Error: { code: 404, message: "not here" } }));
    const [, key, what] = m;
    if (what === "balance") {
      if (url.searchParams.get("instType") !== "BROKERAGE" || url.searchParams.get("realTimeNAV") !== "true") {
        return answer(400, JSON.stringify({ Error: { message: "instType required" } }));
      }
      return answer(200, JSON.stringify({
        BalanceResponse: {
          accountMode: key === "keyAlpha" ? "MARGIN" : "CASH",
          Computed: { marginBuyingPower: 50_000, cashBuyingPower: 20_000, cashBalance: 10_000, RealTimeValues: { totalAccountValue: key === "keyAlpha" ? 100_000 : 30_000 } },
        },
      }));
    }
    if (what === "portfolio") {
      const pages = state.positions[key] ?? [];
      if (pages.length === 0) return answer(204, "");
      const page = Number(url.searchParams.get("pageNumber") ?? 1);
      const list = pages[page - 1] ?? [];
      return answer(200, JSON.stringify({
        PortfolioResponse: {
          Totals: { todaysGainLoss: 123.45 },
          AccountPortfolio: [{
            accountId: ACCOUNT_NUMBER[key],
            ...(state.portfolioTotal === "none" ? {} : { [state.portfolioTotal]: pages.length }),
            nextPageNo: page < pages.length ? page + 1 : undefined,
            Position: list,
          }],
        },
      }));
    }
    const query = Object.fromEntries(url.searchParams);
    state.ordersQueries.push(query);
    let list = [...(state.orders[key] ?? [])];
    if (query.symbol) {
      const wanted = new Set(query.symbol.split(","));
      list = list.filter((x) => wanted.has(String(x.OrderDetail?.[0]?.Instrument?.[0]?.Product?.symbol ?? "")));
    }
    if (query.status) list = list.filter((x) => x.OrderDetail?.[0]?.status === query.status);
    if (query.fromDate && query.toDate) {
      const day = (/** @type {string} */ s) => `${s.slice(4, 8)}-${s.slice(0, 2)}-${s.slice(2, 4)}`;
      const from = day(query.fromDate);
      const to = day(query.toDate);
      list = list.filter((x) => {
        const d = etDateKey(Number(x.OrderDetail?.[0]?.placedTime ?? 0));
        return d >= from && d <= to;
      });
    }
    const count = Number(query.count ?? 25);
    if (state.ordersPageSize !== null) {
      const size = Math.min(count, state.ordersPageSize);
      const start = query.marker ? Number(query.marker) : 0;
      const page = list.slice(start, start + size);
      const more = start + size < list.length;
      if (page.length === 0) return answer(204, "");
      /** @type {Record<string, unknown>} */
      const body = { Order: page };
      if (more && !state.ordersOmitMarker) {
        body.marker = String(start + size);
        body.next = `${url.origin}${url.pathname}?marker=${start + size}`;
      }
      return answer(200, JSON.stringify({ OrdersResponse: body }));
    }
    if (list.length > count) list = list.slice(list.length - count);
    if (list.length === 0) return answer(204, "");
    return answer(200, JSON.stringify({ OrdersResponse: { Order: list } }));
  });

  /** The quote price E*TRADE would estimate with. @param {string} sym */
  const markOf = (sym) => {
    const q = state.quotes[sym];
    if (q?.bid && q?.ask) return (q.bid + q.ask) / 2;
    return q?.lastTrade || 100;
  };

  /**
   * @param {string} key
   * @param {any} parsed
   * @returns {[number, string, string?]}
   */
  function preview(key, parsed) {
    const r = canon(parsed?.PreviewOrderRequest);
    const order = r?.Order?.[0];
    const inst = order?.Instrument?.[0];
    if (!r || r.orderType !== "EQ" || !/^[A-Za-z0-9]{1,20}$/.test(String(r.clientOrderId ?? "")) || r.Order.length !== 1 || !inst || order.Instrument.length !== 1) {
      return [400, jsonError(800, "Invalid Client OrderId. It is either null or length is greater than 20 characters.")];
    }
    const previewId = state.nextPreviewId++;
    previews.set(previewId, { key, clientOrderId: r.clientOrderId, order, at: Date.now() });
    const sym = String(inst.Product?.symbol ?? "");
    const qty = Number(inst.quantity);
    const price = Number(order.limitPrice ?? order.stopPrice ?? markOf(sym));
    const echo = echoOf(order, sym);
    echo.estimatedCommission = 0;
    echo.estimatedFees = 0;
    echo.estimatedTotalAmount = Math.round(qty * price * 100) / 100;
    if (state.previewMessages.length) echo.messages = { Message: state.previewMessages.map((x) => ({ ...x })) };
    /** @type {any} */
    const response = {
      PreviewOrderResponse: {
        orderType: "EQ",
        totalOrderValue: Math.round(qty * price * 100) / 100,
        previewTime: Date.now(),
        accountId: ACCOUNT_NUMBER[key],
        PreviewIds: [{ previewId, cashMargin: "CASH" }],
        Order: [echo],
      },
    };
    state.previewEcho?.(echo, response.PreviewOrderResponse);
    return [200, JSON.stringify(response)];
  }

  /**
   * @param {string} key
   * @param {any} parsed
   * @returns {[number, string, string?]}
   */
  function place(key, parsed) {
    const r = canon(parsed?.PlaceOrderRequest);
    const previewId = Number(r?.PreviewIds?.[0]?.previewId);
    const pv = previews.get(previewId);
    if (!r || !pv || pv.key !== key) return [400, jsonError(900, "Invalid Preview Id.")];
    if (Date.now() - pv.at > 3 * 60_000) return [400, jsonError(1033, "For your protection, we have timed out your original order request. If you would like to place this order, please resubmit it now.")];
    if (usedClientIds.has(`${key}:${r.clientOrderId}`)) return [400, "<Error><code>1028</code><message>This is a duplicate order.</message></Error>", "application/xml"];
    if (r.clientOrderId !== pv.clientOrderId || r.orderType !== "EQ" || r.Order?.length !== 1 || sortedJson(r.Order[0]) !== sortedJson(pv.order)) {
      return [400, jsonError(900, "Invalid Preview Id.")];
    }
    usedClientIds.add(`${key}:${r.clientOrderId}`);
    const order = r.Order[0];
    const inst = order.Instrument[0];
    const sym = String(inst.Product?.symbol ?? "");
    const orderId = state.nextOrderId++;
    const placedTime = Date.now();
    (state.orders[key] ??= []).push({
      orderId,
      OrderDetail: [{
        placedTime,
        status: "OPEN",
        orderTerm: order.orderTerm,
        priceType: order.priceType,
        marketSession: order.marketSession,
        limitPrice: order.limitPrice === undefined ? 0 : Number(order.limitPrice),
        stopPrice: order.stopPrice === undefined ? 0 : Number(order.stopPrice),
        Instrument: [{
          Product: { symbol: sym, securityType: "EQ" },
          symbolDescription: state.quotes[sym]?.companyName ?? `${sym} COMMON STOCK`,
          orderAction: inst.orderAction,
          quantityType: "QUANTITY",
          orderedQuantity: Number(inst.quantity),
          filledQuantity: 0,
        }],
      }],
    });
    const echo = echoOf(order, sym);
    echo.messages = { Message: [{ description: "200|Your order was successfully entered during market hours.", code: 1026, type: "WARNING" }] };
    /** @type {any} */
    const response = {
      PlaceOrderResponse: { orderType: "EQ", placedTime, accountId: ACCOUNT_NUMBER[key], OrderIds: [{ orderId }], Order: [echo] },
    };
    state.placeEcho?.(echo, response.PlaceOrderResponse);
    return [200, JSON.stringify(response)];
  }

  /**
   * @param {string} key
   * @param {any} parsed
   * @returns {[number, string, string?]}
   */
  function cancel(key, parsed) {
    const r = canon(parsed?.CancelOrderRequest);
    const orderId = Number(r?.orderId);
    const found = (state.orders[key] ?? []).find((x) => Number(x.orderId) === orderId);
    if (!found) return [400, jsonError(670000, "Order with the specified order number does not exist.")];
    const d = found.OrderDetail[0];
    if (d.status === "CANCELLED") return [400, jsonError(4148, "This order has already been cancelled. Please check order status.")];
    if (d.status !== "OPEN" && d.status !== "PARTIAL") return [400, jsonError(5005, "This order is not open (or partially open) and therefore cannot be cancelled.")];
    d.status = "CANCEL_REQUESTED";
    return [200, JSON.stringify({
      CancelOrderResponse: {
        accountId: ACCOUNT_NUMBER[key],
        orderId,
        cancelTime: Date.now(),
        Messages: { Message: [{ code: 5011, description: "200|Your request to cancel your order is being processed.", type: "WARNING" }] },
      },
    })];
  }

  /** E*TRADE's echo of an Order: numbers as numbers, the symbol's description added. @param {any} order @param {string} sym */
  function echoOf(order, sym) {
    const inst = order.Instrument[0];
    /** @type {any} */
    const echo = { ...order, allOrNone: order.allOrNone === "true" };
    if (order.limitPrice !== undefined) echo.limitPrice = Number(order.limitPrice);
    if (order.stopPrice !== undefined) echo.stopPrice = Number(order.stopPrice);
    echo.Instrument = [{
      ...inst,
      Product: { ...inst.Product },
      quantity: Number(inst.quantity),
      symbolDescription: state.quotes[sym]?.companyName ?? `${sym} COMMON STOCK`,
    }];
    return echo;
  }

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

/**
 * One AccountPortfolio.Position as E*TRADE lists it. A short has positionType SHORT (its quantity may
 * be positive, as E*TRADE sends it).
 * @param {string} sym @param {number} id @param {number} qty @param {"LONG" | "SHORT"} [type]
 */
export function etradePositionRow(sym, id, qty, type = "LONG") {
  return {
    positionId: id,
    symbolDescription: sym,
    quantity: qty,
    positionType: type,
    daysGain: 10,
    marketValue: qty * 100,
    totalGain: qty * 5,
    costPerShare: 95,
    Quick: { lastTrade: 100 },
    Product: { symbol: sym, securityType: "EQ" },
  };
}

/** @param {string} s */
function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** @param {string} s */
function xmlUnescape(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * Parses exactly what encodeOrderBody writes: elements without attributes, no declaration, no
 * whitespace between elements. An element with children is an object; one that holds text is a string
 * (an empty element is ""); a name repeated among siblings becomes an array. Throws on anything else.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseOrderXml(text) {
  let i = 0;
  /** @returns {string} */
  const openTag = () => {
    const m = /^<([A-Za-z][A-Za-z0-9_]*)>/.exec(text.slice(i));
    if (!m) throw new Error(`xml: an opening tag expected at ${i}`);
    i += m[0].length;
    return m[1];
  };
  /** @param {string} name */
  const closeTag = (name) => {
    const tag = `</${name}>`;
    if (!text.startsWith(tag, i)) throw new Error(`xml: ${tag} expected at ${i}`);
    i += tag.length;
  };
  /** @param {string} name @returns {any} */
  const element = (name) => {
    if (text.startsWith(`</${name}>`, i)) {
      closeTag(name);
      return "";
    }
    if (text[i] === "<" && text[i + 1] !== "/") {
      /** @type {Record<string, any>} */
      const obj = {};
      /** @type {Set<string>} names seen more than once */
      const lists = new Set();
      while (text[i] === "<" && text[i + 1] !== "/") {
        const child = openTag();
        const value = element(child);
        if (!Object.hasOwn(obj, child)) obj[child] = value;
        else if (lists.has(child)) obj[child].push(value);
        else {
          obj[child] = [obj[child], value];
          lists.add(child);
        }
      }
      closeTag(name);
      return obj;
    }
    const end = text.indexOf("<", i);
    if (end === -1) throw new Error("xml: unterminated text");
    const value = xmlUnescape(text.slice(i, end));
    i = end;
    closeTag(name);
    return value;
  };
  const root = openTag();
  const value = element(root);
  if (i !== text.length) throw new Error("xml: trailing content");
  return { [root]: value };
}

/** Keys E*TRADE sends as lists; a single XML element of one of them is a list of one. */
const LIST_KEYS = new Set(["Order", "Instrument", "PreviewIds"]);

/**
 * One shape for an order body from XML or JSON: the list keys are arrays and every value is text.
 * @param {any} v @param {string} [key]
 * @returns {any}
 */
export function canon(v, key = "") {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => canon(x));
  if (LIST_KEYS.has(key)) return [canon(v)];
  if (typeof v === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = canon(x, k);
    return out;
  }
  return String(v);
}

/** JSON with sorted keys. @param {any} v @returns {string} */
function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
