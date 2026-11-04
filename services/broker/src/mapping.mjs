/**
 * Broker answers -> Nasscord shapes (src/lib/types.ts plus the contract section 4 additions).
 * Pure functions only: everything here is unit-tested against recorded-style payloads.
 *
 * Shapes produced:
 *   Position  { id, accountId, brokerId, symbol, qty, avgCost, last, dayPnl?, marketValue?, unrealizedPnl?, currency?, secType? }
 *   Order     { id, clientId, accountId, brokerId, symbol, side, qty, type, price?, trailPct?, tif, status, placedAt,
 *               filledQty?, avgFill?, parentId?, outsideRth?, brokerRef? }
 *   Execution { id, accountId, brokerId, symbol, side, qty, price, commission, net, tradedAt, provisional? }
 *   Account   { accountId, netLiq?, buyingPower?, cash?, dayPnl?, currency }
 * `accountId` is always broker_accounts.id (a uuid), never the broker's own number.
 * An account value the broker did not report is left out, never sent as 0: the app shows
 * "Not reported" for it, and adds up only the values that exist.
 */

/**
 * @typedef {"ibkr" | "etrade"} BrokerId
 * @typedef {{ id: string, accountId: string, brokerId: BrokerId, symbol: string, qty: number, avgCost: number, last: number,
 *   dayPnl?: number, marketValue?: number, unrealizedPnl?: number, currency?: string, secType?: string }} Position
 * @typedef {"MKT" | "LMT" | "STP" | "MIT" | "TRAIL"} OrderType
 * @typedef {"submitted" | "verifying" | "working" | "verified" | "filled" | "cancelled" | "rejected"} OrderStatus
 * @typedef {{ id: string, clientId: string, accountId: string, brokerId: BrokerId, symbol: string, side: "BUY" | "SELL",
 *   qty: number, type: OrderType, price?: number, trailPct?: number, tif: "GTC" | "DAY", status: OrderStatus,
 *   placedAt: string, filledQty?: number, avgFill?: number, parentId?: string, outsideRth?: boolean, brokerRef?: string }} Order
 * @typedef {{ id: string, accountId: string, brokerId: BrokerId, symbol: string, side: "BUY" | "SELL", qty: number,
 *   price: number, commission: number, net: number, tradedAt: string, provisional?: boolean }} Execution
 * @typedef {{ accountId: string, netLiq?: number, buyingPower?: number, cash?: number, dayPnl?: number, currency: string }} AccountSummary
 * @typedef {"individual" | "ira" | "roth" | "margin" | "paper"} AccountType
 */

/**
 * Number from a broker field: numbers, numeric strings ("1,234.50"), or IBKR's { amount } objects.
 * @param {unknown} v
 * @returns {number | undefined}
 */
export function num(v) {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "object" && v && "amount" in v) return num(/** @type {any} */ (v).amount);
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : undefined;
}
/** @param {unknown} v */
const num0 = (v) => num(v) ?? 0;
/** Round money-ish values to cents to hide float noise. @param {number} n */
const cents = (n) => Math.round(n * 100) / 100;

/**
 * The balance fields that have a value, rounded to cents; missing ones are left out.
 * @param {{ netLiq?: number, buyingPower?: number, cash?: number, dayPnl?: number }} values
 */
function reported(values) {
  /** @type {{ netLiq?: number, buyingPower?: number, cash?: number, dayPnl?: number }} */
  const out = {};
  for (const k of /** @type {const} */ (["netLiq", "buyingPower", "cash", "dayPnl"])) {
    const v = values[k];
    if (v !== undefined) out[k] = cents(v);
  }
  return out;
}

/**
 * "U1234567" -> "U12•••67". Short ids keep only the last two characters.
 * @param {string} id
 */
export function maskAccountNumber(id) {
  const s = String(id ?? "").trim();
  if (s.length <= 5) return `•••${s.slice(-2)}`;
  return `${s.slice(0, 3)}•••${s.slice(-2)}`;
}

/** @param {string | null | undefined} v */
const clean = (v) => (typeof v === "string" ? v.trim() : "");

// ─────────────────────────────────────────────────────────────── connection view (API shape)

/**
 * `connection` as the API returns it (contract section 6).
 * @param {import("./db.mjs").ConnectionRow} row
 * @param {import("./db.mjs").AccountRow[]} accounts
 */
export function connectionView(row, accounts) {
  const iso = (/** @type {string | null} */ s) => (s ? new Date(s).toISOString() : null);
  return {
    id: row.id,
    brokerId: row.broker_id,
    method: row.method,
    environment: row.environment,
    status: row.status,
    statusDetail: row.status_detail ?? null,
    sessionExpiresAt: iso(row.session_expires_at),
    lastOkAt: iso(row.last_ok_at),
    accounts: accounts
      .filter((a) => a.connection_id === row.id)
      .map((a) => ({ id: a.id, label: a.label, displayNumber: a.display_number, type: a.type, included: a.included })),
  };
}

// ─────────────────────────────────────────────────────────────── IBKR

/**
 * @param {{ accountId?: string, id?: string, type?: string, tradingType?: string, accountTitle?: string, desc?: string, accountAlias?: string | null, displayName?: string }} acct
 * @param {"production" | "paper" | "sandbox"} environment
 * @returns {AccountType}
 */
export function ibkrAccountType(acct, environment) {
  const id = String(acct.accountId ?? acct.id ?? "");
  if (environment === "paper" || /^D[UF]/i.test(id)) return "paper";
  const text = `${acct.type ?? ""} ${acct.accountTitle ?? ""} ${acct.desc ?? ""}`.toUpperCase();
  if (text.includes("ROTH")) return "roth";
  if (/\bIRA\b/.test(text)) return "ira";
  if (/MRGN|MARGIN|REGT|PM\b/i.test(String(acct.tradingType ?? ""))) return "margin";
  return "individual";
}

/**
 * Accounts from /portfolio/accounts (preferred) and /iserver/accounts (fallback) as broker_accounts rows.
 * @param {{ portfolioAccounts?: any[], iserverAccounts?: any }} src
 * @param {{ id: string, workspace_id: string, environment: "production" | "paper" | "sandbox" }} connection
 */
export function ibkrAccountRows(src, connection) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const a of Array.isArray(src.portfolioAccounts) ? src.portfolioAccounts : []) {
    const id = clean(a?.accountId ?? a?.id);
    if (id) byId.set(id, a);
  }
  const iserver = src.iserverAccounts ?? {};
  for (const id of Array.isArray(iserver.accounts) ? iserver.accounts : []) {
    const key = clean(id);
    if (key && !byId.has(key)) byId.set(key, { accountId: key, accountAlias: iserver.aliases?.[key] ?? null });
  }
  return [...byId.entries()]
    .filter(([id]) => id && id.toUpperCase() !== "ALL")
    .map(([id, a]) => {
      const type = ibkrAccountType(a, connection.environment);
      // An alias or description that is just the account number again says nothing; skip it.
      const named = [clean(a.accountAlias), clean(a.desc)].find((s) => s && s !== id);
      const label = named || `IBKR ${TYPE_LABEL[type]}`;
      return {
        connection_id: connection.id,
        workspace_id: connection.workspace_id,
        broker_id: /** @type {const} */ ("ibkr"),
        external_id: id,
        display_number: maskAccountNumber(id),
        label: label.slice(0, 80),
        type,
      };
    });
}

/** @type {Record<AccountType, string>} */
const TYPE_LABEL = { individual: "Individual", ira: "IRA", roth: "Roth IRA", margin: "Margin", paper: "Paper" };

/**
 * /portfolio/{acct}/summary + the account's row from /iserver/account/pnl/partitioned.
 * @param {any} summary
 * @param {any} pnl the whole partitioned answer
 * @param {{ id: string, external_id: string }} account
 * @returns {AccountSummary}
 */
export function ibkrAccountSummary(summary, pnl, account) {
  const s = summary ?? {};
  const pick = (/** @type {string[]} */ keys) => {
    for (const k of keys) {
      const v = num(s[k]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const currency = clean(s.netliquidation?.currency) || clean(s.totalcashvalue?.currency) || "USD";
  return {
    accountId: account.id,
    ...reported({
      netLiq: pick(["netliquidation", "equitywithloanvalue"]),
      buyingPower: pick(["buyingpower", "availablefunds"]),
      cash: pick(["totalcashvalue", "settledcash"]),
      dayPnl: ibkrDayPnl(pnl, account.external_id),
    }),
    currency,
  };
}

/**
 * Day P&L for one account from pnl/partitioned: { upnl: { "U123.Core": { dpl } } }.
 * Undefined when IBKR sent no day P&L for the account (the call failed, or no row has `dpl`).
 * @param {any} pnl
 * @param {string} accountNumber
 * @returns {number | undefined}
 */
export function ibkrDayPnl(pnl, accountNumber) {
  const rows = pnl?.upnl ?? {};
  const exact = rows[`${accountNumber}.Core`];
  if (exact && num(exact.dpl) !== undefined) return num(exact.dpl);
  /** @type {number | undefined} */
  let total;
  for (const [k, v] of Object.entries(rows)) {
    if (!k.startsWith(`${accountNumber}.`)) continue;
    const dpl = num(/** @type {any} */ (v)?.dpl);
    if (dpl !== undefined) total = (total ?? 0) + dpl;
  }
  return total;
}

/**
 * One item of /portfolio/{acct}/positions/{page}.
 * IBKR's position list has no per-position day P&L field: `dayPnl` is left out unless a newer
 * gateway sends `dailyPnl` (a value the broker did not report is never sent as 0). The
 * account-level day P&L (pnl/partitioned) is in the account summary.
 * @param {any} p
 * @param {{ id: string }} account
 * @returns {Position}
 */
export function ibkrPosition(p, account) {
  const assetClass = clean(p.assetClass).toUpperCase() || "STK";
  const symbol = assetClass === "STK" || assetClass === "FUND" ? clean(p.ticker) || clean(p.contractDesc) : clean(p.contractDesc) || clean(p.ticker);
  const qty = num0(p.position);
  const avg = num(p.avgPrice) ?? num0(p.avgCost);
  /** @type {Position} */
  const out = {
    id: `ibkr:${account.id}:${p.conid ?? symbol}`,
    accountId: account.id,
    brokerId: "ibkr",
    symbol: symbol || String(p.conid ?? ""),
    qty,
    avgCost: avg,
    last: num0(p.mktPrice),
    marketValue: cents(num0(p.mktValue)),
    unrealizedPnl: cents(num0(p.unrealizedPnl)),
    currency: clean(p.currency) || "USD",
    secType: assetClass,
  };
  const day = num(p.dailyPnl) ?? num(p.dailyPnL);
  if (day !== undefined) out.dayPnl = cents(day);
  return out;
}

/** @param {string} raw */
function normOrderType(raw) {
  return String(raw ?? "").toUpperCase().replace(/[\s_-]/g, "");
}

/**
 * @param {string} raw IBKR or E*TRADE order type
 * @param {boolean} hasPrice
 * @returns {OrderType}
 */
export function mapOrderType(raw, hasPrice) {
  const t = normOrderType(raw);
  if (t === "MARKET" || t === "MKT" || t === "MOC" || t === "MARKETONCLOSE" || t === "MARKETONOPEN") return "MKT";
  if (t === "LIMIT" || t === "LMT" || t === "LOC" || t === "LIMITONCLOSE" || t === "LIT" || t === "LIMITONOPEN") return "LMT";
  if (t === "STOP" || t === "STP" || t === "STOPLIMIT" || t === "STPLMT") return "STP";
  if (t.startsWith("TRAIL")) return "TRAIL";
  if (t === "MIT") return "MIT";
  return hasPrice ? "LMT" : "MKT";
}

/**
 * @param {string} raw
 * @returns {OrderStatus}
 */
export function ibkrOrderStatus(raw) {
  const s = String(raw ?? "").toLowerCase().replace(/[\s_]/g, "");
  if (s === "filled") return "filled";
  if (s === "cancelled" || s === "canceled" || s === "apicancelled" || s === "pendingcancel") return "cancelled";
  if (s === "inactive" || s === "rejected") return "rejected";
  if (s === "pendingsubmit" || s === "apipending") return "submitted";
  if (s === "presubmitted" || s === "submitted") return "working";
  return "working";
}

/** @param {string} raw @returns {"BUY" | "SELL"} */
function side(raw) {
  const s = String(raw ?? "").toUpperCase();
  return s === "B" || s.startsWith("BUY") || s === "BOT" ? "BUY" : "SELL";
}

/**
 * IBKR's "231211180049" (yyMMddHHmmss, UTC) or "20231211-18:00:49".
 * @param {any} ms epoch ms if present
 * @param {any} text
 * @param {number} fallback
 */
function ibkrTime(ms, text, fallback) {
  const n = num(ms);
  if (n && n > 0) return new Date(n).toISOString();
  const t = String(text ?? "");
  let m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(t);
  if (m) return new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
  m = /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
  return new Date(fallback).toISOString();
}

/**
 * One item of /iserver/account/orders -> orders[].
 * @param {any} o
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Order}
 */
export function ibkrOrder(o, account, fetchedAt) {
  const typeRaw = o.orderType ?? o.origOrderType ?? "";
  const limit = num(o.price);
  const aux = num(o.auxPrice) ?? num(o.stop_price);
  const type = mapOrderType(typeRaw, limit !== undefined);
  const filled = num(o.filledQuantity);
  const remaining = num(o.remainingQuantity);
  const qty = num(o.totalSize) ?? (filled ?? 0) + (remaining ?? 0);
  const trailIsPct = String(o.trailingType ?? "").includes("%");
  /** @type {Order} */
  const out = {
    id: `ibkr:${account.id}:${o.orderId}`,
    clientId: clean(o.order_ref) || clean(o.cOID) || `ibkr-${o.orderId}`,
    accountId: account.id,
    brokerId: "ibkr",
    symbol: clean(o.ticker) || clean(o.description1) || clean(o.companyName) || String(o.conid ?? ""),
    side: side(o.side),
    qty,
    type,
    tif: String(o.timeInForce ?? "").toUpperCase() === "GTC" ? "GTC" : "DAY",
    status: ibkrOrderStatus(o.status ?? o.order_ccp_status),
    placedAt: ibkrTime(o.lastExecutionTime_r, o.lastExecutionTime, fetchedAt),
    brokerRef: String(o.orderId),
  };
  const price = type === "STP" ? aux ?? limit : limit ?? aux;
  if (price !== undefined && type !== "MKT" && type !== "TRAIL") out.price = price;
  if (type === "TRAIL" && trailIsPct && num(o.trailingAmt) !== undefined) out.trailPct = num0(o.trailingAmt);
  if (filled !== undefined) out.filledQty = filled;
  const avg = num(o.avgPrice);
  if (avg !== undefined && avg > 0) out.avgFill = avg;
  if (o.parentId !== undefined && o.parentId !== null && String(o.parentId) !== "0") {
    out.parentId = `ibkr:${account.id}:${o.parentId}`;
  }
  if (typeof o.outsideRTH === "boolean") out.outsideRth = o.outsideRTH;
  return out;
}

/**
 * One item of /iserver/account/trades.
 * @param {any} t
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution}
 */
export function ibkrExecution(t, account, fetchedAt) {
  const qty = Math.abs(num0(t.size));
  const price = num0(t.price);
  const commission = Math.abs(num0(t.commission));
  const gross = Math.abs(num(t.net_amount) ?? qty * price);
  const s = side(t.side);
  return {
    id: `ibkr:${account.id}:${t.execution_id}`,
    accountId: account.id,
    brokerId: "ibkr",
    symbol: clean(t.symbol) || clean(t.contract_description_1) || String(t.conid ?? ""),
    side: s,
    qty,
    price,
    commission: cents(commission),
    net: cents(s === "BUY" ? -(gross + commission) : gross - commission),
    tradedAt: ibkrTime(t.trade_time_r, t.trade_time, fetchedAt),
  };
}

// ─────────────────────────────────────────────────────────────── E*TRADE

/**
 * @param {{ accountType?: string, accountMode?: string, accountDesc?: string }} a
 * @returns {AccountType}
 */
export function etradeAccountType(a) {
  const t = `${a.accountType ?? ""} ${a.accountDesc ?? ""}`.toUpperCase();
  if (t.includes("ROTH")) return "roth";
  if (/\bIRA\b|ROLLOVER|SEP|SIMPLE/.test(t)) return "ira";
  if (String(a.accountMode ?? "").toUpperCase().includes("MARGIN")) return "margin";
  return "individual";
}

/**
 * /v1/accounts/list -> broker_accounts rows (closed accounts left out).
 * @param {any} list
 * @param {{ id: string, workspace_id: string }} connection
 */
export function etradeAccountRows(list, connection) {
  const raw = list?.AccountListResponse?.Accounts?.Account ?? [];
  const accounts = Array.isArray(raw) ? raw : [raw];
  return accounts
    .filter((a) => a && a.accountIdKey && String(a.accountStatus ?? "ACTIVE").toUpperCase() !== "CLOSED")
    .map((a) => {
      const type = etradeAccountType(a);
      const label = clean(a.accountDesc) || clean(a.accountName) || `E*TRADE ${TYPE_LABEL[type]}`;
      return {
        connection_id: connection.id,
        workspace_id: connection.workspace_id,
        broker_id: /** @type {const} */ ("etrade"),
        external_id: String(a.accountIdKey),
        display_number: maskAccountNumber(String(a.accountId ?? a.accountIdKey)),
        label: label.slice(0, 80),
        type,
      };
    });
}

/**
 * /balance + portfolio Totals -> account summary.
 * @param {any} balance
 * @param {any} totals PortfolioResponse.Totals (todaysGainLoss) or null
 * @param {{ id: string }} account
 * @returns {AccountSummary}
 */
export function etradeAccountSummary(balance, totals, account) {
  const b = balance?.BalanceResponse ?? {};
  const c = b.Computed ?? {};
  const rt = c.RealTimeValues ?? {};
  const margin = String(b.accountMode ?? b.accountType ?? "").toUpperCase().includes("MARGIN");
  const buyingPower = margin
    ? num(c.marginBuyingPower) ?? num(c.cashBuyingPower)
    : num(c.cashBuyingPower) ?? num(c.cashAvailableForInvestment);
  return {
    accountId: account.id,
    ...reported({
      netLiq: num(rt.totalAccountValue) ?? num(c.accountBalance),
      buyingPower,
      cash: num(c.cashBalance) ?? num(c.netCash) ?? num(c.cashAvailableForInvestment),
      dayPnl: num(totals?.todaysGainLoss),
    }),
    currency: "USD",
  };
}

/** @param {string} raw */
function etradeSecType(raw) {
  const t = String(raw ?? "").toUpperCase();
  if (t === "EQ") return "STK";
  if (t === "OPTN") return "OPT";
  if (t === "MF" || t === "MMF") return "FUND";
  if (t === "BOND") return "BOND";
  return t || "STK";
}

/**
 * One AccountPortfolio.Position.
 * @param {any} p
 * @param {{ id: string }} account
 * @returns {Position}
 */
export function etradePosition(p, account) {
  const product = p.Product ?? {};
  const secType = etradeSecType(product.securityType);
  const rawQty = num0(p.quantity);
  const qty = String(p.positionType ?? "").toUpperCase() === "SHORT" ? -Math.abs(rawQty) : rawQty;
  const symbol = secType === "OPT" ? clean(p.symbolDescription) || clean(product.symbol) : clean(product.symbol) || clean(p.symbolDescription);
  return {
    id: `etrade:${account.id}:${p.positionId ?? symbol}`,
    accountId: account.id,
    brokerId: "etrade",
    symbol,
    qty,
    avgCost: num(p.costPerShare) ?? num0(p.pricePaid),
    last: num(p.Quick?.lastTrade) ?? num(p.Complete?.lastTrade) ?? num0(p.marketValue) / (qty || 1),
    dayPnl: cents(num0(p.daysGain)),
    marketValue: cents(num0(p.marketValue)),
    unrealizedPnl: cents(num0(p.totalGain)),
    currency: "USD",
    secType,
  };
}

/** @param {string} raw @returns {OrderStatus} */
export function etradeOrderStatus(raw) {
  const s = String(raw ?? "").toUpperCase();
  if (s === "EXECUTED" || s === "DONE_TRADE_EXECUTED") return "filled";
  if (s === "CANCELLED" || s === "EXPIRED" || s === "DO_NOT_EXERCISE") return "cancelled";
  if (s === "REJECTED") return "rejected";
  if (s === "OPEN" || s === "PARTIAL" || s === "INDIVIDUAL_FILLS" || s === "CANCEL_REQUESTED") return "working";
  return "working";
}

/**
 * OrdersResponse -> Order[] (one per leg; multi-leg orders get ":<leg>" on the id).
 * @param {any} resp
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Order[]}
 */
export function etradeOrders(resp, account, fetchedAt) {
  /** @type {Order[]} */
  const out = [];
  const raw = resp?.OrdersResponse?.Order ?? [];
  for (const o of Array.isArray(raw) ? raw : [raw]) {
    const details = Array.isArray(o?.OrderDetail) ? o.OrderDetail : o?.OrderDetail ? [o.OrderDetail] : [];
    for (const d of details) {
      const legs = Array.isArray(d.Instrument) ? d.Instrument : d.Instrument ? [d.Instrument] : [];
      legs.forEach((/** @type {any} */ leg, /** @type {number} */ i) => {
        const priceType = String(d.priceType ?? "");
        const limit = num(d.limitPrice);
        const stop = num(d.stopPrice);
        const type = mapOrderType(priceType, !!(limit || stop));
        const placed = num(d.placedTime);
        /** @type {Order} */
        const order = {
          id: `etrade:${account.id}:${o.orderId}${legs.length > 1 ? `:${i}` : ""}`,
          clientId: clean(o.clientOrderId) || `etrade-${o.orderId}`,
          accountId: account.id,
          brokerId: "etrade",
          symbol: clean(leg.Product?.symbol) || clean(leg.symbolDescription),
          side: side(leg.orderAction),
          qty: num0(leg.orderedQuantity),
          type,
          tif: String(d.orderTerm ?? "").toUpperCase() === "GOOD_UNTIL_CANCEL" ? "GTC" : "DAY",
          status: etradeOrderStatus(d.status),
          placedAt: new Date(placed && placed > 0 ? placed : fetchedAt).toISOString(),
          brokerRef: String(o.orderId),
        };
        const price = type === "STP" ? stop || limit : limit || stop;
        if (price && type !== "MKT" && type !== "TRAIL") order.price = price;
        if (type === "TRAIL" && priceType.toUpperCase().includes("PRCT") && num(d.offsetValue) !== undefined) {
          order.trailPct = num0(d.offsetValue);
        }
        const filled = num(leg.filledQuantity);
        if (filled !== undefined) order.filledQty = filled;
        const avg = num(leg.averageExecutionPrice);
        if (avg) order.avgFill = avg;
        if (d.marketSession) order.outsideRth = String(d.marketSession).toUpperCase() === "EXTENDED";
        out.push(order);
      });
    }
  }
  return out;
}

/**
 * Fills from the same OrdersResponse: E*TRADE has no separate executions list in this release's
 * read set, so every leg with a filled quantity becomes one execution at its average price.
 * Commission is E*TRADE's estimate on the order, so these are marked provisional.
 * @param {any} resp
 * @param {{ id: string }} account
 * @param {number} fetchedAt
 * @returns {Execution[]}
 */
export function etradeExecutions(resp, account, fetchedAt) {
  /** @type {Execution[]} */
  const out = [];
  const raw = resp?.OrdersResponse?.Order ?? [];
  for (const o of Array.isArray(raw) ? raw : [raw]) {
    const details = Array.isArray(o?.OrderDetail) ? o.OrderDetail : o?.OrderDetail ? [o.OrderDetail] : [];
    for (const d of details) {
      const legs = Array.isArray(d.Instrument) ? d.Instrument : d.Instrument ? [d.Instrument] : [];
      legs.forEach((/** @type {any} */ leg, /** @type {number} */ i) => {
        const qty = num0(leg.filledQuantity);
        const price = num0(leg.averageExecutionPrice);
        if (!(qty > 0) || !(price > 0)) return;
        const s = side(leg.orderAction);
        const commission = Math.abs(num0(leg.estimatedCommission)) + Math.abs(num0(leg.estimatedFees));
        const multiplier = String(leg.Product?.securityType ?? "").toUpperCase() === "OPTN" ? 100 : 1;
        const gross = qty * price * multiplier;
        const when = num(d.executedTime) ?? num(d.placedTime);
        out.push({
          id: `etrade:${account.id}:${o.orderId}${legs.length > 1 ? `:${i}` : ""}`,
          accountId: account.id,
          brokerId: "etrade",
          symbol: clean(leg.Product?.symbol) || clean(leg.symbolDescription),
          side: s,
          qty,
          price,
          commission: cents(commission),
          net: cents(s === "BUY" ? -(gross + commission) : gross - commission),
          tradedAt: new Date(when && when > 0 ? when : fetchedAt).toISOString(),
          provisional: true,
        });
      });
    }
  }
  return out;
}
