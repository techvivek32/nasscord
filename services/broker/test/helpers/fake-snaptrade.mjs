import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { listen } from "./common.mjs";

/**
 * A fake SnapTrade API (https://api.snaptrade.com/api/v1) plus its Connection Portal, for tests.
 *
 * - Every /api/v1 call must carry clientId, a Unix timestamp within 5 minutes of `state.now()` and a
 *   Signature header: base64(HMAC-SHA256(consumerKey, JSON of { content, path, query } with keys
 *   sorted)), with the full path (/api/v1 prefix) and the raw query. The check is written here on
 *   its own (sorted copy + JSON.stringify), not with the service's signer. Failures answer 401
 *   (code 1076), as SnapTrade does.
 * - User calls need userId and userSecret of a registered, not deleted user (else 403, code 1083).
 * - registerUser shows the userSecret once; an id already taken answers 400 (code 1010). With
 *   `keepDeletedIds`, a deleted user's id stays taken (SnapTrade deletes in the background).
 * - login answers a portal link on this server; GET /portal?session=… "logs in" with
 *   `state.portal` and answers 302 to customRedirect with status=SUCCESS&connection_id=<id>
 *   (or ABANDONED, or ERROR&error_code). A reconnect re-enables that connection.
 * - Orders filter by state (all | open | executed) and days; activities by startDate, endDate and
 *   type, paged by offset and limit as { data, pagination }.
 * - listUsers answers every user that is not deleted (registered ones, and strays put in `users`).
 * - Knobs: disable(), enable(), remove() a connection, addAuthorization() (orphans, other users),
 *   addAccount(), failNext (one answer for the next matching call), webhook() (a signed webhook body).
 * Every call is recorded (method, path without query, userId), never the secret.
 */

const OPEN = new Set(["PENDING", "ACCEPTED", "PARTIAL", "CANCEL_PENDING", "REPLACE_PENDING", "QUEUED", "TRIGGERED", "ACTIVATED", "PENDING_RISK_REVIEW", "CONTINGENT_ORDER"]);
const DAY = 24 * 3_600_000;

/** @type {Record<string, string>} */
const NAMES = {
  FIDELITY: "Fidelity",
  ROBINHOOD: "Robinhood",
  PUBLIC: "Public",
  MOOMOO: "Moomoo",
  WEBULL: "Webull",
  SCHWAB: "Charles Schwab",
  TASTYTRADE: "tastytrade",
  "ALPACA-PAPER": "Alpaca Paper",
};

/** @param {unknown} v @returns {unknown} */
const sortDeep = (v) =>
  Array.isArray(v)
    ? v.map(sortDeep)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(/** @type {object} */ (v))
            .sort()
            .map((k) => [k, sortDeep(/** @type {any} */ (v)[k])]),
        )
      : v;

/** SnapTrade's time format for holdings syncs ("2026-11-16 14:03:12.123456+00:00"). @param {number} ms */
export function snapTimeText(ms) {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.(\d{3})Z$/, ".$1456+00:00");
}

/**
 * @typedef {{
 *   name?: string, number?: string, rawType?: string, isPaper?: boolean, status?: string,
 *   total?: number, currency?: string, holdingsSync?: string | null, txThrough?: string | null,
 *   holdingsUnavailable?: boolean,
 *   balances?: any[], positions?: any[], options?: any[], orders?: any[], activities?: any[],
 * }} AccountSpec
 * @typedef {{ outcome: "SUCCESS" | "ABANDONED" | "ERROR", slug: string | null, accounts: ((auth: any) => AccountSpec[]) | null }} PortalPlan
 */

/** @param {{ clientId: string, consumerKey: string }} o */
export async function startFakeSnapTrade(o) {
  const state = {
    now: () => Date.now(),
    /** @type {Map<string, { userSecret: string, deleted: boolean }>} */
    users: new Map(),
    keepDeletedIds: false,
    /** @type {Map<string, { id: string, userId: string, slug: string, type: string, disabled: boolean, disabledAt: number | null, createdAt: number }>} */
    authorizations: new Map(),
    /** @type {Map<string, { userId: string, authorizationId: string, json: any, spec: AccountSpec }>} */
    accounts: new Map(),
    /** @type {Map<string, any>} */
    sessions: new Map(),
    /** @type {Array<{ method: string, path: string, userId: string | null, query: Record<string, string> }>} */
    calls: [],
    /** @type {any[]} login bodies, in order */
    logins: [],
    /** @type {Array<{ reason: string }>} */
    refused: [],
    /** @type {PortalPlan} */
    portal: { outcome: "SUCCESS", slug: null, accounts: null },
    /** @type {Array<{ method?: string, path?: RegExp, status: number, body?: unknown, headers?: Record<string, string> }>} */
    failNext: [],
  };

  /** @param {import("node:http").ServerResponse} res @param {number} status @param {unknown} [body] @param {Record<string, string>} [headers] */
  const send = (res, status, body, headers = {}) => {
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  /** @param {string} path @param {string} query @param {unknown} content @param {string} [key] */
  const expectedSignature = (path, query, content, key = o.consumerKey) =>
    createHmac("sha256", key)
      .update(JSON.stringify(sortDeep({ content, path, query })))
      .digest("base64");

  /** @param {string} id */
  const authJson = (id) => {
    const a = /** @type {NonNullable<ReturnType<typeof state.authorizations.get>>} */ (state.authorizations.get(id));
    return {
      id: a.id,
      created_date: new Date(a.createdAt).toISOString(),
      updated_date: new Date(a.createdAt).toISOString(),
      brokerage: { id: `brk-${a.slug.toLowerCase()}`, slug: a.slug, name: NAMES[a.slug] ?? a.slug, display_name: NAMES[a.slug] ?? a.slug, allows_trading: true },
      name: `Connection-${a.id.slice(0, 4)}`,
      type: a.type,
      disabled: a.disabled,
      disabled_date: a.disabledAt ? new Date(a.disabledAt).toISOString() : null,
      meta: {},
      is_eligible_for_payout: false,
    };
  };

  /**
   * @param {string} authorizationId
   * @param {AccountSpec} spec
   */
  function addAccount(authorizationId, spec = {}) {
    const auth = state.authorizations.get(authorizationId);
    if (!auth) throw new Error("fake-snaptrade: no such authorization");
    const id = randomUUID();
    const json = {
      id,
      brokerage_authorization: authorizationId,
      portfolio_group: null,
      name: spec.name ?? `${NAMES[auth.slug] ?? auth.slug} Individual`,
      number: spec.number ?? `Z${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
      institution_name: NAMES[auth.slug] ?? auth.slug,
      created_date: new Date(state.now()).toISOString(),
      sync_status: {
        transactions: { initial_sync_completed: spec.txThrough != null, last_successful_sync: spec.txThrough ?? null, first_transaction_date: "2020-01-02" },
        holdings: { initial_sync_completed: spec.holdingsSync != null, last_successful_sync: spec.holdingsSync ?? null, holdings_unavailable: spec.holdingsUnavailable ?? false },
      },
      balance: { total: { amount: spec.total ?? 1000, currency: spec.currency ?? "USD" } },
      status: spec.status ?? "open",
      raw_type: spec.rawType ?? "Individual",
      account_category: "INVESTMENT",
      meta: {},
      cash_restrictions: [],
      is_paper: spec.isPaper ?? false,
    };
    state.accounts.set(id, { userId: auth.userId, authorizationId, json, spec });
    return id;
  }

  /**
   * A connection at SnapTrade, as if the user had made one (an orphan, another user's).
   * @param {{ userId: string, slug?: string, createdAt?: number, accounts?: AccountSpec[] }} a
   */
  function addAuthorization(a) {
    const id = randomUUID();
    state.authorizations.set(id, { id, userId: a.userId, slug: a.slug ?? "FIDELITY", type: "read", disabled: false, disabledAt: null, createdAt: a.createdAt ?? state.now() });
    for (const spec of a.accounts ?? []) addAccount(id, spec);
    return id;
  }

  /** @param {string} id */
  function removeAuthorization(id) {
    state.authorizations.delete(id);
    for (const [aid, acc] of state.accounts) if (acc.authorizationId === id) state.accounts.delete(aid);
  }

  /** @param {URLSearchParams} q */
  function userOf(q) {
    const userId = q.get("userId") ?? "";
    const u = state.users.get(userId);
    if (!u || u.deleted || u.userSecret !== q.get("userSecret")) return null;
    return userId;
  }

  /** @param {URL} url @param {import("node:http").ServerResponse} res */
  function portal(url, res) {
    const sid = url.searchParams.get("session") ?? "";
    const s = state.sessions.get(sid);
    state.sessions.delete(sid);
    if (!s) return send(res, 410, { detail: "This link expired." });
    const back = new URL(s.customRedirect);
    if (state.portal.outcome === "ABANDONED") {
      back.searchParams.set("status", "ABANDONED");
    } else if (state.portal.outcome === "ERROR") {
      back.searchParams.set("status", "ERROR");
      back.searchParams.set("error_code", "BROKERAGE_ERROR");
      back.searchParams.set("status_code", "500");
    } else {
      let id = s.reconnect;
      if (id) {
        const a = state.authorizations.get(id);
        if (a) {
          a.disabled = false;
          a.disabledAt = null;
        }
      } else {
        id = randomUUID();
        state.authorizations.set(id, { id, userId: s.userId, slug: state.portal.slug ?? s.broker, type: s.connectionType ?? "read", disabled: false, disabledAt: null, createdAt: state.now() });
        const specs = state.portal.accounts ? state.portal.accounts(state.authorizations.get(id)) : [{}];
        for (const spec of specs) addAccount(id, spec);
      }
      back.searchParams.set("status", "SUCCESS");
      back.searchParams.set("connection_id", id);
    }
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  /** @param {import("node:http").IncomingMessage} req */
  const readBody = (req) =>
    new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

  const api = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const text = /** @type {string} */ (await readBody(req));
    if (url.pathname === "/portal") return portal(url, res);
    if (!url.pathname.startsWith("/api/v1/")) return send(res, 404, { detail: "Not found." });
    const q = url.searchParams;
    /** @type {unknown} */
    let content = null;
    if (text) {
      try {
        content = JSON.parse(text);
      } catch {
        return send(res, 400, { detail: "Body is not JSON." });
      }
    }
    const ts = Number(q.get("timestamp"));
    const sig = String(req.headers.signature ?? "");
    let reason = "";
    if (q.get("clientId") !== o.clientId) reason = "client";
    else if (!Number.isFinite(ts) || Math.abs(state.now() / 1000 - ts) > 300) reason = "timestamp";
    else if (sig !== expectedSignature(url.pathname, url.search.replace(/^\?/, ""), content)) reason = "signature";
    if (reason) {
      state.refused.push({ reason });
      return send(res, 401, { detail: "Unable to verify signature sent", status_code: 401, code: "1076" });
    }
    const method = req.method ?? "GET";
    const path = url.pathname.slice("/api/v1".length);
    /** @type {Record<string, string>} */
    const query = {};
    for (const [k, v] of q) if (k !== "userSecret") query[k] = v;
    state.calls.push({ method, path, userId: q.get("userId"), query });

    const fail = state.failNext.findIndex((f) => (!f.method || f.method === method) && (!f.path || f.path.test(path)));
    if (fail >= 0) {
      const f = state.failNext.splice(fail, 1)[0];
      return send(res, f.status, f.body ?? { detail: "Failure.", status_code: f.status }, f.headers ?? {});
    }

    // ── users
    if (method === "POST" && path === "/snapTrade/registerUser") {
      const userId = String(/** @type {any} */ (content)?.userId ?? "");
      if (!userId) return send(res, 400, { detail: "userId is required", code: "1001" });
      if (state.users.has(userId)) return send(res, 400, { detail: "User already exist", status_code: 400, code: "1010" });
      const userSecret = randomBytes(24).toString("base64url");
      state.users.set(userId, { userSecret, deleted: false });
      return send(res, 200, { userId, userSecret });
    }
    if (method === "GET" && path === "/snapTrade/listUsers") {
      return send(res, 200, [...state.users.entries()].filter(([, u]) => !u.deleted).map(([id]) => id));
    }
    if (method === "DELETE" && path === "/snapTrade/deleteUser") {
      const userId = q.get("userId") ?? "";
      const u = state.users.get(userId);
      if (!u || u.deleted) return send(res, 404, { detail: "User not found", code: "1011" });
      for (const a of [...state.authorizations.values()]) if (a.userId === userId) removeAuthorization(a.id);
      if (state.keepDeletedIds) u.deleted = true;
      else state.users.delete(userId);
      return send(res, 200, { status: "deleted", detail: "User deleted", userId });
    }

    const user = userOf(q);
    if (!user) return send(res, 403, { detail: "Invalid userID or userSecret provided", status_code: 403, code: "1083" });

    if (method === "POST" && path === "/snapTrade/login") {
      const body = /** @type {any} */ (content) ?? {};
      state.logins.push(body);
      if (!body.broker) return send(res, 400, { detail: "broker is required" });
      if (body.reconnect && state.authorizations.get(body.reconnect)?.userId !== user) return send(res, 400, { detail: "Invalid reconnect", code: "1084" });
      const sid = randomUUID();
      state.sessions.set(sid, { userId: user, ...body });
      return send(res, 200, { redirectURI: `${api.url}/portal?session=${sid}`, sessionId: sid });
    }

    let m;
    if (method === "GET" && path === "/authorizations") {
      return send(res, 200, [...state.authorizations.values()].filter((a) => a.userId === user).map((a) => authJson(a.id)));
    }
    if ((m = /^\/authorizations\/([^/]+)$/.exec(path))) {
      const a = state.authorizations.get(m[1]);
      if (!a || a.userId !== user) return send(res, 404, { detail: "Connection not found", code: "1086" });
      if (method === "GET") return send(res, 200, authJson(a.id));
      if (method === "DELETE") {
        removeAuthorization(a.id);
        return send(res, 204);
      }
    }
    if (method === "GET" && path === "/accounts") {
      return send(res, 200, [...state.accounts.values()].filter((a) => a.userId === user).map((a) => a.json));
    }
    if ((m = /^\/accounts\/([^/]+)\/(balances|positions|options|orders|activities)$/.exec(path)) && method === "GET") {
      const acc = state.accounts.get(m[1]);
      if (!acc || acc.userId !== user) return send(res, 404, { detail: "Account not found", code: "1100" });
      const s = acc.spec;
      if (m[2] === "balances") return send(res, 200, s.balances ?? [{ currency: { id: "usd", code: "USD", name: "US Dollar" }, cash: 0, buying_power: 0 }]);
      if (m[2] === "positions") return send(res, 200, s.positions ?? []);
      if (m[2] === "options") return send(res, 200, s.options ?? []);
      if (m[2] === "orders") {
        const st = q.get("state") ?? "all";
        const days = Math.min(90, Math.max(1, Number(q.get("days") ?? 30)));
        const since = state.now() - days * DAY;
        const list = (s.orders ?? []).filter((x) => {
          const placed = Date.parse(x.time_placed);
          if (!(placed >= since)) return false;
          if (st === "open") return OPEN.has(x.status);
          if (st === "executed") return x.status === "EXECUTED";
          return true;
        });
        return send(res, 200, list);
      }
      const start = q.get("startDate") ?? "0000-00-00";
      const end = q.get("endDate") ?? "9999-99-99";
      const types = (q.get("type") ?? "").split(",").filter(Boolean);
      const all = (s.activities ?? []).filter((x) => {
        const d = String(x.trade_date).slice(0, 10);
        return d >= start && d <= end && (!types.length || types.includes(x.type));
      });
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit") ?? 1000);
      return send(res, 200, { data: all.slice(offset, offset + limit), pagination: { offset, limit, total: all.length } });
    }
    return send(res, 404, { detail: "Not found." });
  });

  return {
    state,
    url: api.url,
    addAccount,
    addAuthorization,
    /** @param {string} id */
    disable(id) {
      const a = state.authorizations.get(id);
      if (a) {
        a.disabled = true;
        a.disabledAt = state.now();
      }
    },
    /** As if SnapTrade fixed the connection (CONNECTION_FIXED). @param {string} id */
    enable(id) {
      const a = state.authorizations.get(id);
      if (a) {
        a.disabled = false;
        a.disabledAt = null;
      }
    },
    /** As if the user removed the connection at SnapTrade. @param {string} id */
    remove: removeAuthorization,
    /** The calls since `from` as "METHOD /path". @param {number} [from] */
    paths(from = 0) {
      return state.calls.slice(from).map((c) => `${c.method} ${c.path}`);
    },
    /**
     * The portal "login": follows the link and answers where SnapTrade sends the browser.
     * @param {string} redirectUri
     */
    async follow(redirectUri) {
      const r = await fetch(redirectUri, { redirect: "manual" });
      await r.text();
      return { status: r.status, location: r.headers.get("location") ?? "" };
    },
    /**
     * A webhook body and its Signature header, signed as SnapTrade signs them.
     * @param {Record<string, unknown>} payload
     * @param {{ key?: string }} [opts]
     */
    webhook(payload, opts = {}) {
      const body = JSON.stringify(payload);
      const signature = createHmac("sha256", opts.key ?? o.consumerKey)
        .update(JSON.stringify(sortDeep(payload)))
        .digest("base64");
      return { body, signature };
    },
    close: () => api.close(),
  };
}
