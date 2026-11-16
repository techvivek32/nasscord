import { badGateway, HttpError } from "../errors.mjs";
import { snaptradeSignature, sortedCopy } from "./signer.mjs";

/**
 * SnapTrade's API for the aggregator adapter (docs/real-backend.md, "Connect flows",
 * aggregator_portal). Every call goes through createBrokerHttp with the allowlist below and is
 * signed (signer.mjs). Nothing here logs a URL, query, header or body: the query carries the
 * user's userSecret, as SnapTrade's API requires.
 *
 * Read only. The allowlist holds the read endpoints plus what the connect flow itself needs
 * (register, list and delete SnapTrade users, the Connection Portal link, and deleting a
 * connection on Disconnect). No trade, order, refresh or secret-reset endpoint is on it: the
 * manual refresh is billed per call on the Daily plan, and orders are off in this release.
 */

/** SnapTrade's host. The legacy /api/v1 prefix is the path the official SDKs call and sign. */
export const SNAPTRADE_ORIGIN = "https://api.snaptrade.com";
const PREFIX = "/api/v1";

/** SnapTrade ids (users' authorizations and accounts are UUIDs). */
export const SNAPTRADE_ID = /^[A-Za-z0-9-]{1,64}$/;
const ID = "[A-Za-z0-9-]{1,64}";

/** @type {import("../http.mjs").AllowRule[]} */
export const SNAPTRADE_ALLOW = /** @type {import("../http.mjs").AllowRule[]} */ (
  Object.freeze([
    // The workspace's SnapTrade user and its Connection Portal link; the user list finds users whose
    // workspace was deleted (the sweep).
    Object.freeze(["POST", /^\/snapTrade\/registerUser$/]),
    Object.freeze(["DELETE", /^\/snapTrade\/deleteUser$/]),
    Object.freeze(["GET", /^\/snapTrade\/listUsers$/]),
    Object.freeze(["POST", /^\/snapTrade\/login$/]),
    // Connections: list, one, and remove on Disconnect.
    Object.freeze(["GET", /^\/authorizations$/]),
    Object.freeze(["GET", new RegExp(`^/authorizations/${ID}$`)]),
    Object.freeze(["DELETE", new RegExp(`^/authorizations/${ID}$`)]),
    // Reads.
    Object.freeze(["GET", /^\/accounts$/]),
    Object.freeze(["GET", new RegExp(`^/accounts/${ID}/(balances|positions|options|orders|activities)$`)]),
  ])
);

/** SnapTrade allows 250 requests a minute per customer: one bucket for the whole process. */
export const SNAPTRADE_RATE_PER_SEC = 4;
export const SNAPTRADE_BUCKET = "snaptrade:*";

/**
 * The base URL this server calls. BROKER_URL_OVERRIDES ({"snaptrade":{"api":"http://127.0.0.1:9100"}})
 * apply outside production only, so a local fake can never stand in for SnapTrade in front of users.
 * @param {Readonly<Record<string, string>>} urls
 * @param {boolean} production
 */
export function snaptradeBase(urls, production) {
  const origin = (production ? SNAPTRADE_ORIGIN : urls?.api || SNAPTRADE_ORIGIN).replace(/\/+$/, "");
  return origin.endsWith(PREFIX) ? origin : `${origin}${PREFIX}`;
}

/**
 * A SnapTrade answer outside 2xx (429 is answered by createBrokerHttp as rateLimited first). Keeps
 * SnapTrade's status and error code for the adapter, never its message text.
 */
export class SnapTradeError extends HttpError {
  /**
   * @param {number} status the HTTP status Nasscord answers
   * @param {string} message a sentence for the user
   * @param {{ code: string, snapStatus: number, snapCode?: string | null }} o
   */
  constructor(status, message, o) {
    super(status, message, { code: o.code });
    this.name = "SnapTradeError";
    this.snapStatus = o.snapStatus;
    this.snapCode = o.snapCode ?? null;
  }
}

/** @typedef {{ userId: string, userSecret: string }} SnapUser */

/**
 * @param {{
 *   http: import("../adapter-types.mjs").AdapterDeps["http"],
 *   base: string,
 *   clientId: string,
 *   consumerKey: string,
 *   now: () => number,
 *   log: import("../log.mjs").Logger,
 * }} o
 */
export function createSnapTradeClient(o) {
  const http = o.http({
    name: "SnapTrade",
    base: o.base,
    allow: SNAPTRADE_ALLOW,
    bucket: { key: SNAPTRADE_BUCKET, ratePerSec: SNAPTRADE_RATE_PER_SEC },
    timeoutMs: 8_000,
  });
  const basePath = new URL(o.base).pathname.replace(/\/+$/, "");

  const unreadable = () => badGateway("SnapTrade sent a reply Nasscord could not read.", "broker_reply");

  /**
   * One signed call. Answers the parsed body of a 2xx; anything else becomes a SnapTradeError
   * (401 and 403 mean SnapTrade refused Nasscord's own keys or a stored userSecret: a problem on
   * Nasscord's side that a Reconnect cannot fix, so it never expires a connection).
   * @param {string} method
   * @param {string} path
   * @param {{ user?: SnapUser | null, query?: Record<string, string | number | null | undefined>, body?: unknown, timeoutMs?: number,
   *   accept?: (res: import("../http.mjs").RawResponse) => unknown }} [opts]
   *   accept: answers a non-2xx reply the caller understands (undefined: handled as below).
   */
  async function call(method, path, opts = {}) {
    /** @type {Record<string, string>} */
    const query = { clientId: o.clientId, timestamp: String(Math.floor(o.now() / 1000)) };
    if (opts.user) {
      query.userId = opts.user.userId;
      query.userSecret = opts.user.userSecret;
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) query[k] = String(v);
    // createBrokerHttp builds the query string from this record the same way (URLSearchParams, in
    // insertion order), so what is signed is exactly what is sent.
    const queryString = new URLSearchParams(query).toString();
    const content = opts.body === undefined ? null : sortedCopy(opts.body);
    const signature = snaptradeSignature(o.consumerKey, { path: `${basePath}${path}`, query: queryString, content });
    const res = /** @type {import("../http.mjs").RawResponse} */ (
      await http.request(method, path, {
        query,
        ...(content === null ? {} : { json: content }),
        headers: { Signature: signature },
        raw: true,
        timeoutMs: opts.timeoutMs,
      })
    );
    if (res.status >= 200 && res.status < 300) {
      if (res.text && res.json === null) throw unreadable();
      return res.json;
    }
    const accepted = opts.accept?.(res);
    if (accepted !== undefined) return accepted;
    const snapCode = res.json && typeof res.json === "object" && res.json.code !== undefined ? String(res.json.code).slice(0, 20) : null;
    if (res.status === 401 || res.status === 403) {
      o.log.warn("snaptrade refused a request", { status: res.status, snapCode });
      throw new SnapTradeError(502, "SnapTrade did not accept Nasscord's request right now. Try again in a few minutes.", {
        code: "snaptrade_refused",
        snapStatus: res.status,
        snapCode,
      });
    }
    if (res.status === 404) {
      throw new SnapTradeError(502, "SnapTrade no longer has what Nasscord asked for.", { code: "snaptrade_not_found", snapStatus: 404, snapCode });
    }
    if (res.status >= 500) {
      throw new SnapTradeError(502, `SnapTrade is not answering right now (${res.status}). Try again in a moment.`, { code: "broker_down", snapStatus: res.status, snapCode });
    }
    throw new SnapTradeError(502, `SnapTrade could not answer this request (${res.status}).`, { code: "broker_http", snapStatus: res.status, snapCode });
  }

  /** @param {unknown} v @returns {any[]} */
  const listOf = (v) => {
    if (!Array.isArray(v)) throw unreadable();
    return v;
  };
  /** @param {unknown} v @returns {any} */
  const objectOf = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw unreadable();
    return v;
  };
  /** @param {string} id */
  const idOf = (id) => {
    if (!SNAPTRADE_ID.test(String(id))) throw new Error("snaptrade: an id with characters SnapTrade never uses");
    return String(id);
  };
  /** @param {unknown} e */
  const missing = (e) => e instanceof SnapTradeError && (e.snapStatus === 404 || e.snapStatus === 400);

  return {
    /** For the allowlist tests only. */
    http,
    call,

    /**
     * POST /snapTrade/registerUser. SnapTrade shows the userSecret only here. `exists` when the id
     * is already taken (SnapTrade answers 400, code 1010; a deleted user's id stays taken a while).
     * @param {string} userId
     * @returns {Promise<{ userSecret: string } | { exists: true }>}
     */
    async registerUser(userId) {
      const out = objectOf(
        await call("POST", "/snapTrade/registerUser", {
          body: { userId },
          timeoutMs: 10_000,
          accept: (res) => (res.status === 400 && (String(res.json?.code ?? "") === "1010" || /already exist/i.test(String(res.json?.detail ?? ""))) ? { exists: true } : undefined),
        }),
      );
      if (out.exists === true) return { exists: /** @type {const} */ (true) };
      const userSecret = typeof out.userSecret === "string" ? out.userSecret : "";
      if (!userSecret || userSecret.length > 512) throw unreadable();
      return { userSecret };
    },

    /**
     * DELETE /snapTrade/deleteUser: the user and every connection it holds (SnapTrade finishes it
     * shortly after). A user SnapTrade does not know is already gone.
     * @param {string} userId
     */
    async deleteUser(userId) {
      try {
        await call("DELETE", "/snapTrade/deleteUser", { query: { userId } });
      } catch (e) {
        if (!(e instanceof SnapTradeError && e.snapStatus === 404)) throw e;
      }
    },

    /**
     * GET /snapTrade/listUsers: the id of every SnapTrade user of Nasscord's keys (not paged).
     * @returns {Promise<string[]>}
     */
    async listUsers() {
      return listOf(await call("GET", "/snapTrade/listUsers", { timeoutMs: 15_000 })).filter((v) => typeof v === "string");
    },

    /**
     * POST /snapTrade/login: a Connection Portal link (it expires in 5 minutes).
     * @param {SnapUser} user
     * @param {{ broker: string, connectionType: "read", customRedirect: string, immediateRedirect: boolean, showCloseButton?: boolean, reconnect?: string }} body
     */
    async login(user, body) {
      return objectOf(await call("POST", "/snapTrade/login", { user, body, timeoutMs: 10_000 }));
    },

    /** GET /authorizations: every connection of the user. @param {SnapUser} user */
    async authorizations(user) {
      return listOf(await call("GET", "/authorizations", { user }));
    },

    /**
     * GET /authorizations/{id}, or null when the user has no such connection (a deleted one, or
     * another user's).
     * @param {SnapUser} user @param {string} id
     */
    async authorization(user, id) {
      try {
        return objectOf(await call("GET", `/authorizations/${idOf(id)}`, { user }));
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },

    /**
     * DELETE /authorizations/{id}. False when SnapTrade had no such connection.
     * @param {SnapUser} user @param {string} id
     */
    async deleteAuthorization(user, id) {
      try {
        await call("DELETE", `/authorizations/${idOf(id)}`, { user });
        return true;
      } catch (e) {
        if (missing(e)) return false;
        throw e;
      }
    },

    /** GET /accounts: every account of the user, across its connections. @param {SnapUser} user */
    async accounts(user) {
      return listOf(await call("GET", "/accounts", { user }));
    },

    /** @param {SnapUser} user @param {string} accountId */
    async balances(user, accountId) {
      return listOf(await call("GET", `/accounts/${idOf(accountId)}/balances`, { user }));
    },

    /** Stocks, ETFs, funds and crypto. @param {SnapUser} user @param {string} accountId */
    async positions(user, accountId) {
      return listOf(await call("GET", `/accounts/${idOf(accountId)}/positions`, { user }));
    },

    /** Option holdings. @param {SnapUser} user @param {string} accountId */
    async options(user, accountId) {
      return listOf(await call("GET", `/accounts/${idOf(accountId)}/options`, { user }));
    },

    /**
     * @param {SnapUser} user @param {string} accountId
     * @param {{ state: "all" | "open" | "executed", days: number }} q
     */
    async orders(user, accountId, q) {
      return listOf(await call("GET", `/accounts/${idOf(accountId)}/orders`, { user, query: { state: q.state, days: q.days } }));
    },

    /**
     * One page of transactions (a day late on every SnapTrade plan).
     * @param {SnapUser} user @param {string} accountId
     * @param {{ startDate: string, endDate: string, offset: number, limit: number, type: string }} q
     * @returns {Promise<{ data: any[], total: number | null }>}
     */
    async activities(user, accountId, q) {
      const out = await call("GET", `/accounts/${idOf(accountId)}/activities`, { user, query: q });
      if (Array.isArray(out)) return { data: out, total: null };
      const page = objectOf(out);
      const total = Number(page.pagination?.total);
      return { data: listOf(page.data ?? []), total: Number.isFinite(total) ? total : null };
    },
  };
}

/** @typedef {ReturnType<typeof createSnapTradeClient>} SnapTradeClient */
