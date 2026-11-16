import { SNAPTRADE_BROKER_IDS } from "../config.mjs";
import { badGateway, badRequest, conflict, gone, SessionExpiredError, unavailable } from "../errors.mjs";
import { FLOW_DETAIL } from "../flows.mjs";
import { clean } from "../mapping.mjs";
import { etDateKey, iso, parseTime } from "../time.mjs";
import { createSnapTradeClient, SNAPTRADE_ID, SNAPTRADE_ORIGIN, snaptradeBase, SnapTradeError } from "./client.mjs";
import {
  accountsOfAuthorization,
  authorizationOf,
  brokerageMatches,
  brokerName,
  dataAsOfOf,
  isPaperAccount,
  nonLiveKind,
  parseSnapTime,
  SNAPTRADE_SLUGS,
  snaptradeAccountRow,
  snaptradeAccountSummary,
  snaptradeExecutions,
  snaptradeOptionPosition,
  snaptradeOrders,
  snaptradePosition,
  transactionsSyncedThrough,
} from "./mapping.mjs";
import { createSnapTradeUsers, notSetUp } from "./users.mjs";
import { createSnapTradeWebhook } from "./webhook.mjs";

/**
 * SnapTrade, the data intermediary for brokers without an API Nasscord can use (method snaptrade,
 * flow aggregator_portal): Fidelity, Robinhood, Public, Moomoo, Webull until Webull approves
 * Nasscord, and Schwab and tastytrade read only once SnapTrade enables them (SNAPTRADE_BROKERS).
 * docs/real-backend.md, "Connect flows".
 *
 * - One SnapTrade user per workspace (users.mjs), registered at the first hop.
 * - Connect: the hop asks for a Connection Portal link with the broker's slug always set (the user
 *   can never pick another or a sample brokerage), connectionType "read", immediateRedirect and the
 *   canonical callback as customRedirect. On the callback the authorization must belong to the
 *   workspace's SnapTrade user, be at the broker the user chose, not be a sandbox, demo or paper
 *   brokerage, and be enabled. Its id is the connection's external_ref; its type ("read") is the
 *   scope.
 * - Reconnect (renew): SnapTrade is asked about the authorization first. An enabled one needs no
 *   login (the connection is active again); a disabled one opens the portal with
 *   reconnect=<authorization id> (SnapTrade: reconnect only a disabled connection); one SnapTrade no
 *   longer holds is a 409 (a new login cannot bring it back).
 * - Reads (cached 10 minutes on SnapTrade's Real-time plan, its own guidance; 30 on Daily): balances from /accounts and /balances,
 *   positions and option holdings, orders (30 days plus open orders of 90), and fills: transactions
 *   up to the last day SnapTrade synced them (with fees, read at most once a day per account, as
 *   SnapTrade's launch checklist asks), then executed orders after it, marked provisional.
 *   data_as_of is the oldest holdings sync of the connection's accounts.
 * - Accounts: listed on the first read after connecting. When every account of a connection is
 *   closed or gone at SnapTrade, the stored ones are removed and reads say so.
 * - Every 15 minutes the sweep lists each workspace's authorizations: a disabled one expires its
 *   connection, a missing one makes it an error, an expired one SnapTrade shows enabled again is
 *   active again, one no connection uses (older than 30 minutes, no login in progress) is deleted,
 *   and a SnapTrade user without connections is deleted. In production (and against a local fake)
 *   it also deletes SnapTrade users no workspace holds any more (users.mjs, deleteStrays).
 * - Disconnect deletes the authorization at SnapTrade, and the user with the workspace's last one.
 * - POST /hooks/snaptrade (webhook.mjs) once SnapTrade keys are set.
 * Read only: the client's allowlist has no trade, order or refresh endpoint.
 */

export const SNAPTRADE_DETAIL = Object.freeze({
  /** @param {string} name */
  ended: (name) => `${name} ended Nasscord's access. Reconnect to continue.`,
  /** @param {string} name */
  gone: (name) => `SnapTrade no longer holds this ${name} connection. Disconnect it, then connect ${name} again.`,
  /** @param {string} name */
  accountsSyncing: (name) => `${name} is still sending the account list through SnapTrade. It appears in a few minutes.`,
  /** @param {string} name */
  accountGone: (name) => `One ${name} account is no longer listed by SnapTrade. The account list refreshes on the next read.`,
  /** @param {string} name */
  noAccounts: (name) => `${name} no longer lists an open account for this connection. If you closed the accounts, disconnect it.`,
  /** @param {string} name */
  sample: (name) => `That login is a sandbox or demo brokerage with sample data, which Nasscord does not read. Connect your own ${name} account.`,
  /** @param {string} name */
  paper: (name) => `Nasscord reads only live ${name} accounts through SnapTrade; paper accounts are not connected this way. Connect your live ${name} account.`,
  /** @param {string} name */
  paperOnly: (name) => `That ${name} login holds only paper accounts. Nasscord reads only live ${name} accounts through SnapTrade, so paper accounts are not connected this way.`,
  /** @param {string} name */
  working: (name) => `Your ${name} connection works again, so there is nothing to log in to. Go back to Nasscord.`,
  /** @param {string} name @param {string[]} symbols */
  noPrice: (name, symbols) =>
    `${name} sent no price for ${symbols.slice(0, 5).join(", ")}${symbols.length > 5 ? ` and ${symbols.length - 5} more` : ""} through SnapTrade, so ${symbols.length === 1 ? "its" : "their"} market value is not shown.`,
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Reads are reused this long on the Real-time plan (SnapTrade: one poll per account per 10 minutes)... */
export const SNAPTRADE_READ_TTL_MS = 10 * MINUTE;
/** ...and on the Daily plan, where SnapTrade refreshes the data once a day. */
export const SNAPTRADE_DAILY_TTL_MS = 30 * MINUTE;
const SWEEP_MS = 15 * MINUTE;
/** A SnapTrade connection or user nothing uses is removed only after this long (a login may still finish). */
export const SNAPTRADE_ORPHAN_AGE_MS = 30 * MINUTE;
/** The account list right after a login, and while it is being loaded. */
const ACCOUNTS_TTL_MS = 30_000;
/** The sweep's authorization list stands in for a per-connection call this long. */
const AUTH_MEMO_MS = 5 * MINUTE;
/**
 * Transactions are read at most once a day per account (SnapTrade's launch checklist). The cache key
 * holds the last synced day, so a new day SnapTrade synced is read at once, and it is kept apart from
 * the connection's other reads (cache.invalidate(connection id) leaves it): only a transactions
 * webhook drops it early.
 */
const ACTIVITY_TTL_MS = DAY;
const HISTORY_DAYS = 30;
const OPEN_ORDER_DAYS = 90;
const ACTIVITY_PAGE = 1000;
const MAX_ACTIVITY_PAGES = 5;
/** How far SnapTrade's clock may run behind ours when it dates a new authorization. */
const AUTH_CLOCK_SLACK_MS = 2 * MINUTE;

/**
 * Whether SnapTrade made an authorization during the login that started at `startedAt` (epoch ms):
 * "yes", "no", or "unknown" when either time is missing. Binds a portal result to its own login (D1).
 * @param {any} auth @param {number | null | undefined} startedAt
 * @returns {"yes" | "no" | "unknown"}
 */
function madeByLogin(auth, startedAt) {
  const created = parseSnapTime(auth?.created_date);
  if (created === null || typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "unknown";
  return created >= startedAt - AUTH_CLOCK_SLACK_MS ? "yes" : "no";
}

/** "2026-11-15" for "2026-11-14". @param {string} day */
const dayAfter = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/**
 * @param {number} ttl
 * @returns {import("../adapter-types.mjs").AdapterDescriptor}
 */
const descriptorWith = (ttl) =>
  Object.freeze(
    /** @type {import("../adapter-types.mjs").AdapterDescriptor} */ ({
      method: "snaptrade",
      brokers: /** @type {any} */ ([...SNAPTRADE_BROKER_IDS]),
      name: "SnapTrade",
      environments: ["production"],
      readTtlMs: Object.freeze({ portfolio: ttl, orders: ttl, executions: ttl }),
      lazyAccounts: true,
      sweepEveryMs: SWEEP_MS,
    }),
  );

/** SNAPTRADE_PLAN=realtime: SnapTrade asks for no more than one poll per account every 10 minutes. */
export const SNAPTRADE_DESCRIPTOR = descriptorWith(SNAPTRADE_READ_TTL_MS);
/** SNAPTRADE_PLAN=daily (the default): SnapTrade itself syncs once a day, so reads are kept 30 minutes. */
export const SNAPTRADE_DAILY_DESCRIPTOR = descriptorWith(SNAPTRADE_DAILY_TTL_MS);

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("./client.mjs").SnapUser} SnapUser
 */

/** @type {import("../adapter-types.mjs").AdapterFactory} */
export function createAdapter(deps) {
  const { config, store, secretBox, cache, locks, log, now } = deps;
  const snap = config.brokers.snaptrade;
  const client =
    snap.clientId && snap.consumerKey
      ? createSnapTradeClient({ http: deps.http, base: snaptradeBase(deps.urls, config.production), clientId: snap.clientId, consumerKey: snap.consumerKey, now, log })
      : null;
  const api = () => {
    if (!client) throw notSetUp();
    return client;
  };
  const users = createSnapTradeUsers({ store, secretBox, locks, client: api, log, now });
  const descriptor = snap.plan === "realtime" ? SNAPTRADE_DESCRIPTOR : SNAPTRADE_DAILY_DESCRIPTOR;
  /**
   * SnapTrade users no workspace holds are deleted by the production server, and against a local
   * fake (BROKER_URL_OVERRIDES, tests). Never by a development server that talks to SnapTrade itself:
   * its database is not production's, so production's users would all look like strays to it.
   * Two databases must therefore never share one pair of SnapTrade keys.
   */
  const sweepsStrayUsers = config.production || !snaptradeBase(deps.urls, false).startsWith(SNAPTRADE_ORIGIN);
  const ttl = descriptor.readTtlMs;
  /** Connections whose account list changed at SnapTrade: the next read loads it again. */
  /** @type {Set<string>} */
  const stale = new Set();
  /** The sweep's authorization list per workspace. */
  /** @type {Map<string, { at: number, list: any[] }>} */
  const authMemo = new Map();

  /** @param {ConnectionRow} c */
  const nameOf = (c) => brokerName(c.broker_id);
  /** @param {ConnectionRow} c */
  const key = (c) => `${c.id}:snaptrade`;
  const missingAccount = () => new SnapTradeError(502, "SnapTrade no longer lists this account.", { code: "snaptrade_not_found", snapStatus: 404 });

  /**
   * Moves an active connection (or one in `from`) to `status` with `detail` (a Reconnect or a claim
   * in between wins).
   * @param {ConnectionRow} conn @param {"expired" | "error"} status @param {string} detail
   * @param {Array<ConnectionRow["status"]>} [from]
   */
  async function setStatus(conn, status, detail, from = ["active"]) {
    const row = await store.updateConnectionIf(conn.id, from, { status, status_detail: detail });
    cache.invalidate(conn.id);
    if (row) log.info(`snaptrade connection ${status}`, { connectionId: conn.id });
    return !!row;
  }

  /** True when `auth` (as SnapTrade shows it now) is there, enabled and at the connection's broker. @param {ConnectionRow} conn @param {any} auth */
  const works = (conn, auth) => !!auth && auth.disabled !== true && brokerageMatches(conn.broker_id, auth.brokerage);

  /**
   * Moves a connection back to active once SnapTrade shows its authorization working again
   * (CONNECTION_FIXED, or the sweep's list): an expired one, or an error SnapTrade only seemed to
   * have lost. The account list is loaded again on the next read.
   * @param {ConnectionRow} conn @param {any} auth
   */
  async function revive(conn, auth) {
    if (!works(conn, auth)) return false;
    const from = conn.status === "expired" ? "expired" : conn.status === "error" && conn.status_detail === SNAPTRADE_DETAIL.gone(nameOf(conn)) ? "error" : null;
    if (!from) return false;
    const row = await store.updateConnectionIf(conn.id, [from], { status: "active", status_detail: null, last_ok_at: iso(now()) });
    cache.invalidate(conn.id);
    if (!row) return false;
    stale.add(conn.id);
    log.info("snaptrade connection active again", { connectionId: conn.id });
    return true;
  }

  /** The connection's authorization as SnapTrade shows it now, or null. @param {ConnectionRow} conn */
  async function currentAuthorization(conn) {
    const user = await users.get(conn.workspace_id);
    return user && conn.external_ref && SNAPTRADE_ID.test(conn.external_ref) ? api().authorization(user, conn.external_ref) : null;
  }

  /**
   * Is the connection's authorization still there and enabled? A disabled one (the broker ended
   * the access) expires the connection; a missing one makes it an error (a Reconnect cannot bring
   * it back). `fresh: false` lets a recent sweep list confirm a healthy authorization; anything
   * else (missing from that list, or disabled in it) is asked of SnapTrade again before the
   * connection changes, since the list may predate a login or a Reconnect.
   * @param {ConnectionRow} conn
   * @param {{ fresh: boolean }} o
   * @returns {Promise<"ok" | "disabled" | "gone">}
   */
  async function checkAuthorization(conn, o) {
    if (!conn.external_ref) return "ok";
    const name = nameOf(conn);
    const user = await users.get(conn.workspace_id);
    /** @type {any} */
    let auth = null;
    if (user) {
      const memo = authMemo.get(conn.workspace_id);
      const listed = !o.fresh && memo && now() - memo.at < AUTH_MEMO_MS ? memo.list.find((a) => clean(a?.id) === conn.external_ref) : null;
      if (listed && listed.disabled !== true) return "ok";
      auth = SNAPTRADE_ID.test(conn.external_ref) ? await api().authorization(user, conn.external_ref) : null;
    }
    if (!auth) {
      await setStatus(conn, "error", SNAPTRADE_DETAIL.gone(name));
      return "gone";
    }
    if (auth.disabled === true) {
      await setStatus(conn, "expired", SNAPTRADE_DETAIL.ended(name));
      return "disabled";
    }
    return "ok";
  }

  /** @param {ConnectionRow} conn @param {"disabled" | "gone"} r */
  function endedError(conn, r) {
    const name = nameOf(conn);
    return r === "disabled" ? new SessionExpiredError(SNAPTRADE_DETAIL.ended(name), { reauth: "redirect" }) : conflict(SNAPTRADE_DETAIL.gone(name), "aggregator_gone");
  }

  /** @param {ConnectionRow} conn @returns {Promise<SnapUser>} */
  async function userOf(conn) {
    const user = await users.get(conn.workspace_id);
    if (user) return user;
    await setStatus(conn, "error", SNAPTRADE_DETAIL.gone(nameOf(conn)));
    throw conflict(SNAPTRADE_DETAIL.gone(nameOf(conn)), "aggregator_gone");
  }

  /**
   * A read of an active connection. When SnapTrade refuses it with a 4xx (other than a refusal of
   * Nasscord's own keys), the authorization is checked: a disabled or deleted one ends the
   * connection and says so.
   * @template T
   * @param {ConnectionRow} conn
   * @param {(user: SnapUser) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function reading(conn, fn) {
    if (conn.status !== "active") throw new SessionExpiredError(conn.status_detail || SNAPTRADE_DETAIL.ended(nameOf(conn)), { reauth: "redirect" });
    try {
      return await fn(await userOf(conn));
    } catch (e) {
      if (e instanceof SnapTradeError && e.snapStatus >= 400 && e.snapStatus < 500 && e.snapStatus !== 401 && e.snapStatus !== 403) {
        const r = await checkAuthorization(conn, { fresh: true }).catch(() => /** @type {const} */ ("ok"));
        if (r !== "ok") throw endedError(conn, r);
      }
      throw e;
    }
  }

  /**
   * Runs `fn` per account, one at a time (SnapTrade's limit is per customer). An account SnapTrade
   * no longer has is skipped; the account list is then loaded again on the next read, unless the
   * whole authorization is gone.
   * @template T
   * @param {ConnectionRow} conn
   * @param {AccountRow[]} accounts
   * @param {(a: AccountRow) => Promise<T>} fn
   */
  async function eachAccount(conn, accounts, fn) {
    /** @type {T[]} */
    const out = [];
    let missing = 0;
    for (const a of accounts) {
      try {
        out.push(await fn(a));
      } catch (e) {
        if (e instanceof SnapTradeError && e.snapStatus === 404) {
          missing++;
          continue;
        }
        throw e;
      }
    }
    if (missing) {
      const r = await checkAuthorization(conn, { fresh: true });
      if (r !== "ok") throw endedError(conn, r);
      stale.add(conn.id);
    }
    return { out, missing };
  }

  /**
   * The connection's live accounts from GET /accounts (cached `ttl`).
   * @param {ConnectionRow} conn @param {SnapUser} user @param {number} ttl
   */
  async function snapAccounts(conn, user, ttl) {
    const all = await cache.get(`${key(conn)}:accounts`, () => api().accounts(user), ttl);
    return accountsOfAuthorization(all, conn.external_ref);
  }

  /** @param {any[]} raws */
  const byId = (raws) => new Map(raws.map((a) => [clean(a.id), a]));

  /**
   * last_ok_at, and data_as_of when SnapTrade synced since.
   * @param {ConnectionRow} conn @param {any[]} raws
   */
  async function touch(conn, raws) {
    const asOf = dataAsOfOf(raws);
    /** @type {Partial<ConnectionRow>} */
    const patch = { last_ok_at: iso(now()) };
    if (asOf && parseTime(asOf) !== parseTime(conn.data_as_of ?? null)) patch.data_as_of = asOf;
    await store.updateConnectionIf(conn.id, ["active"], patch).catch((e) => log.warn("snaptrade sync time not saved", { connectionId: conn.id, error: e }));
  }

  /**
   * Open orders of the last 90 days and every order of the last 30 (shared by orders and fills).
   * @param {ConnectionRow} conn @param {SnapUser} user @param {AccountRow} a
   */
  function rawOrders(conn, user, a) {
    return cache.get(
      `${key(conn)}:orders:${a.external_id}`,
      async () => {
        const open = await api().orders(user, a.external_id, { state: "open", days: OPEN_ORDER_DAYS });
        const recent = await api().orders(user, a.external_id, { state: "all", days: HISTORY_DAYS });
        return [...open, ...recent];
      },
      ttl.orders,
    );
  }

  /** The cache prefix of a connection's transactions (outside `${conn.id}:`, see ACTIVITY_TTL_MS). @param {ConnectionRow} c */
  const activityKey = (c) => `${c.id}~activities`;

  /**
   * BUY and SELL transactions from 30 days ago up to the last synced day (cached by that day). The
   * query runs a day past it: a brokerage that sends exact times dates an evening fill (after 20:00
   * Eastern) on the next UTC day, and the mapping keeps it on its own New York day.
   * @param {ConnectionRow} conn @param {SnapUser} user @param {AccountRow} a @param {string} through
   */
  function activitiesOf(conn, user, a, through) {
    const start = etDateKey(now() - HISTORY_DAYS * DAY);
    if (through < start) return Promise.resolve([]);
    return cache.get(
      `${activityKey(conn)}:${a.external_id}:${through}`,
      async () => {
        /** @type {any[]} */
        const all = [];
        for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
          const { data, total } = await api().activities(user, a.external_id, { startDate: start, endDate: dayAfter(through), offset: page * ACTIVITY_PAGE, limit: ACTIVITY_PAGE, type: "BUY,SELL" });
          all.push(...data);
          if (data.length < ACTIVITY_PAGE || (total !== null && all.length >= total)) break;
        }
        return all;
      },
      ACTIVITY_TTL_MS,
    );
  }

  /**
   * Deletes an authorization the login produced but Nasscord will not use (another brokerage, sample
   * data), unless a connection of the workspace holds it.
   * @param {ConnectionRow} conn @param {SnapUser} user @param {string} id
   */
  async function dropStray(conn, user, id) {
    const holders = await store.listConnections({ workspace_id: conn.workspace_id, method: "snaptrade", external_ref: id, status: ["neq", "disconnected"] });
    if (holders.length) return;
    await api()
      .deleteAuthorization(user, id)
      .catch((e) => log.warn("snaptrade connection that was refused could not be deleted", { connectionId: conn.id, error: e }));
  }

  /**
   * What a verified webhook does to a connection.
   * @param {import("./webhook.mjs").HookAction} action @param {ConnectionRow} conn
   */
  async function act(action, conn) {
    cache.invalidate(conn.id);
    authMemo.delete(conn.workspace_id);
    if (action === "transactions") cache.invalidate(activityKey(conn));
    else if (action === "accounts") stale.add(conn.id);
    else if (action === "fixed") {
      stale.add(conn.id);
      if (conn.status === "expired" || conn.status === "error") await revive(conn, await currentAuthorization(conn));
    } else if (action === "broken") await setStatus(conn, "expired", SNAPTRADE_DETAIL.ended(nameOf(conn)));
    else if (action === "deleted") await setStatus(conn, "error", SNAPTRADE_DETAIL.gone(nameOf(conn)), ["active", "expired"]);
  }

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const adapter = {
    descriptor,

    async portalUrl(req) {
      const conn = req.connection;
      const name = brokerName(req.brokerId);
      const slug = SNAPTRADE_SLUGS[req.brokerId]?.portal;
      if (!slug || req.brokerId !== conn.broker_id) throw badRequest(`Nasscord does not connect ${name} through SnapTrade.`, "unknown_method");
      if (!snap.brokers.includes(req.brokerId)) throw unavailable(`${name} is not set up on this server yet.`, "not_configured");
      const user = await users.ensure(conn.workspace_id);
      /** @type {{ broker: string, connectionType: "read", customRedirect: string, immediateRedirect: boolean, showCloseButton: boolean, reconnect?: string }} */
      const body = { broker: slug, connectionType: "read", customRedirect: req.redirectUrl, immediateRedirect: true, showCloseButton: true };
      if (req.reconnect) {
        const auth = SNAPTRADE_ID.test(req.reconnect) ? await api().authorization(user, req.reconnect) : null;
        if (!auth || !brokerageMatches(conn.broker_id, auth.brokerage)) {
          await store.updateConnectionIf(conn.id, ["pending", "expired", "active"], { status: "error", status_detail: SNAPTRADE_DETAIL.gone(name) }).catch(() => {});
          cache.invalidate(conn.id);
          throw conflict(SNAPTRADE_DETAIL.gone(name), "aggregator_gone");
        }
        if (auth.disabled !== true) {
          // Fixed since Reconnect was pressed. SnapTrade's reconnect is only for a disabled
          // connection, and a login without it would make a second connection at SnapTrade.
          await store.updateConnectionIf(conn.id, ["pending", "expired"], { status: "active", status_detail: null, last_ok_at: iso(now()) }).catch(() => null);
          cache.invalidate(conn.id);
          stale.add(conn.id);
          throw conflict(SNAPTRADE_DETAIL.working(name), "aggregator_working");
        }
        body.reconnect = req.reconnect;
      }
      const out = await api().login(user, body);
      const url = typeof out?.redirectURI === "string" ? out.redirectURI : "";
      /** @type {URL} */
      let u;
      try {
        u = new URL(url);
      } catch {
        throw badGateway("SnapTrade sent no login page address. Try again in a moment.", "broker_reply");
      }
      const host = u.hostname.toLowerCase();
      const official = u.protocol === "https:" && (host === "snaptrade.com" || host.endsWith(".snaptrade.com"));
      if ((u.protocol !== "https:" && u.protocol !== "http:") || (config.production && !official)) {
        throw badGateway("SnapTrade sent a login page address Nasscord does not open.", "broker_reply");
      }
      return url;
    },

    async aggregatorComplete(conn, input) {
      const name = nameOf(conn);
      const authorizationId = String(input.authorizationId ?? "");
      if (!SNAPTRADE_ID.test(authorizationId)) throw badRequest(`${name} sent a connection id Nasscord cannot read. Start again from Brokers.`, "bad_authorization");
      const user = await users.get(conn.workspace_id);
      if (!user) throw gone("This login link expired or was already used. Start again from Brokers.", "login_expired");
      const auth = await api().authorization(user, authorizationId);
      if (!auth) throw badRequest(`SnapTrade does not list this ${name} connection for your workspace. Start again from Brokers.`, "wrong_user");
      // Only what this login's portal made: an older authorization of the same SnapTrade user (a
      // refused login's leftover, another login's) is never attached to a new connection. A
      // Reconnect comes back with the one the connection holds.
      if (authorizationId !== conn.external_ref && madeByLogin(auth, input.startedAt) === "no") {
        throw badRequest(`This ${name} connection was not made by this login. Start again from Brokers.`, "stale_authorization");
      }
      if (!brokerageMatches(conn.broker_id, auth.brokerage)) {
        await dropStray(conn, user, authorizationId);
        const kind = nonLiveKind(auth.brokerage);
        if (kind === "sample") throw badRequest(SNAPTRADE_DETAIL.sample(name), "sample_data");
        if (kind === "paper") throw badRequest(SNAPTRADE_DETAIL.paper(name), "paper_refused");
        throw badRequest(`That login is not at ${name}. Start again from Brokers and log in to ${name}.`, "wrong_brokerage");
      }
      if (auth.disabled === true) throw badRequest(`${name} did not finish granting access. Start again from Brokers.`, "authorization_disabled");
      const all = await api().accounts(user);
      const theirs = all.filter((a) => authorizationOf(a) === authorizationId);
      if (theirs.length > 0 && theirs.every(isPaperAccount)) {
        await dropStray(conn, user, authorizationId);
        throw badRequest(SNAPTRADE_DETAIL.paperOnly(name), "paper_refused");
      }
      authMemo.delete(conn.workspace_id);
      // The claim lists the accounts a moment later: this answer serves it.
      await cache.get(`${key(conn)}:accounts`, async () => all, ACCOUNTS_TTL_MS);
      const scope = clean(auth.type).toLowerCase();
      if (scope && scope.length <= 40) await store.updateConnection(conn.id, { scope }).catch(() => {});
      return { externalRef: authorizationId, dataAsOf: dataAsOfOf(accountsOfAuthorization(all, authorizationId)) };
    },

    /**
     * The canonical callback refused this login (another browser, past its window, not finished):
     * the authorization its portal made is deleted when no connection holds it, so a forwarded
     * portal link leaves nothing under the starter's SnapTrade user. Only one made since the login
     * started, and never the one the connection holds (a Reconnect).
     */
    async aggregatorRefused(conn, input) {
      const id = String(input.authorizationId ?? "");
      if (!client || !SNAPTRADE_ID.test(id) || id === conn.external_ref) return;
      const user = await users.get(conn.workspace_id);
      if (!user) return;
      const auth = await api().authorization(user, id);
      if (!auth || madeByLogin(auth, input.startedAt) !== "yes") return;
      authMemo.delete(conn.workspace_id);
      await dropStray(conn, user, id);
    },

    /**
     * The connection's open accounts. None listed: right after connecting (nothing stored yet)
     * SnapTrade is still loading them (503, reads try again); when accounts are stored, every one
     * of them closed or went, so the answer is empty (flows removes them) and the connection says
     * so until SnapTrade lists an account again, asking SnapTrade no more often than the reads.
     */
    async listAccounts(conn) {
      const name = nameOf(conn);
      const none = conn.status_detail === SNAPTRADE_DETAIL.noAccounts(name);
      const user = await userOf(conn);
      const raws = await snapAccounts(conn, user, none ? ttl.portfolio : ACCOUNTS_TTL_MS);
      const rows = raws.map((a) => snaptradeAccountRow(a, conn.broker_id));
      stale.delete(conn.id);
      if (rows.length) {
        if (none) await store.updateConnectionIf(conn.id, ["active"], { status_detail: null }).catch(() => null);
        return rows;
      }
      if ((await store.listAccounts([conn.id])).length > 0) {
        await store.updateConnectionIf(conn.id, ["active"], { status_detail: SNAPTRADE_DETAIL.noAccounts(name) }).catch(() => null);
        log.info("snaptrade lists no open account for a connection; its accounts are removed", { connectionId: conn.id });
        return [];
      }
      if (none) throw conflict(SNAPTRADE_DETAIL.noAccounts(name), "no_accounts");
      throw unavailable(SNAPTRADE_DETAIL.accountsSyncing(name), "accounts_syncing");
    },

    accountsPending(conn) {
      return stale.has(conn.id) || conn.status_detail === FLOW_DETAIL.accountsLater(nameOf(conn));
    },

    /**
     * Balances and positions together, so a holding SnapTrade sent no price for is named in the
     * read's errors instead of being shown at a made-up value.
     */
    async portfolio(conn, accounts) {
      const [b, positions] = await Promise.all([
        /** @type {NonNullable<typeof adapter.balances>} */ (adapter.balances)(conn, accounts),
        /** @type {NonNullable<typeof adapter.positions>} */ (adapter.positions)(conn, accounts),
      ]);
      const errors = [...(b.errors ?? [])];
      const unpriced = [...new Set(positions.filter((p) => p.last === undefined && p.symbol).map((p) => p.symbol))];
      if (unpriced.length > 0) errors.push({ connectionId: conn.id, message: SNAPTRADE_DETAIL.noPrice(nameOf(conn), unpriced) });
      return { accounts: b.accounts, positions, errors };
    },

    async balances(conn, accounts) {
      return reading(conn, async (user) => {
        const raws = await snapAccounts(conn, user, ttl.portfolio);
        await touch(conn, raws);
        const map = byId(raws);
        const { out, missing } = await eachAccount(conn, accounts, async (a) => {
          const raw = map.get(a.external_id);
          if (!raw) throw missingAccount();
          return snaptradeAccountSummary(raw, await api().balances(user, a.external_id), a);
        });
        return { accounts: out, errors: missing ? [{ connectionId: conn.id, message: SNAPTRADE_DETAIL.accountGone(nameOf(conn)) }] : [] };
      });
    },

    async positions(conn, accounts) {
      return reading(conn, async (user) => {
        const map = byId(await snapAccounts(conn, user, ttl.portfolio));
        const { out } = await eachAccount(conn, accounts, async (a) => {
          const raw = map.get(a.external_id);
          if (!raw) throw missingAccount();
          if (raw.sync_status?.holdings?.holdings_unavailable === true) return [];
          const stocks = await api().positions(user, a.external_id);
          /** @type {any[]} */
          let options = [];
          try {
            options = await api().options(user, a.external_id);
          } catch (e) {
            // A brokerage without option holdings may refuse the call; the stock positions still count.
            if (!(e instanceof SnapTradeError) || e.snapStatus < 400 || e.snapStatus >= 500 || [401, 403, 404].includes(e.snapStatus)) throw e;
          }
          return [...stocks.map((p) => snaptradePosition(p, a, conn.broker_id)), ...options.map((p) => snaptradeOptionPosition(p, a, conn.broker_id))];
        });
        return out.flat();
      });
    },

    async orders(conn, accounts) {
      return reading(conn, async (user) => {
        const t = now();
        const { out } = await eachAccount(conn, accounts, async (a) => snaptradeOrders(await rawOrders(conn, user, a), a, conn.broker_id, t));
        return out.flat();
      });
    },

    async executions(conn, accounts) {
      return reading(conn, async (user) => {
        const map = byId(await snapAccounts(conn, user, ttl.executions));
        const { out } = await eachAccount(conn, accounts, async (a) => {
          const raw = map.get(a.external_id);
          if (!raw) throw missingAccount();
          const through = transactionsSyncedThrough(raw);
          const orders = await rawOrders(conn, user, a);
          const activities = through ? await activitiesOf(conn, user, a, through) : [];
          return snaptradeExecutions({ orders, activities, syncedThrough: through }, a, conn.broker_id);
        });
        return out.flat();
      });
    },

    /** The scheduler (after sweep()) and Reconnect: is the authorization still there and enabled? */
    async refresh(conn) {
      if (!client || !conn.external_ref) return "skipped";
      return (await checkAuthorization(conn, { fresh: false })) === "ok" ? "ok" : "expired";
    },

    /**
     * Reconnect (flows.renew, under the connection's lock, after the BROKER_AUDIENCE gate). SnapTrade
     * is asked about the authorization first:
     * - enabled at the broker: nothing to log in to; the connection is active (again);
     * - gone (or at another brokerage): 409, a new login cannot bring it back;
     * - disabled: a new portal login with reconnect=<authorization id>, through the canonical hop
     *   as genericRenew starts one (needs returnOrigin and bindingHash, which the app always sends).
     * A connection that never finished connecting (no authorization yet) goes straight to a login.
     */
    async renew(conn, ctx) {
      if (!client) throw notSetUp();
      const name = nameOf(conn);
      if (conn.external_ref) {
        authMemo.delete(conn.workspace_id);
        const auth = await currentAuthorization(conn);
        if (!auth || !brokerageMatches(conn.broker_id, auth.brokerage)) {
          await store.updateConnectionIf(conn.id, ["pending", "expired", "active"], { status: "error", status_detail: SNAPTRADE_DETAIL.gone(name) }).catch(() => null);
          cache.invalidate(conn.id);
          throw conflict(SNAPTRADE_DETAIL.gone(name), "aggregator_gone");
        }
        if (auth.disabled !== true) {
          const t = iso(now());
          const row =
            conn.status === "active"
              ? await store.updateConnectionIf(conn.id, ["active"], { last_ok_at: t })
              : await store.updateConnectionIf(conn.id, ["pending", "expired", "error"], { status: "active", status_detail: null, last_ok_at: t });
          // A Reconnect left open in another tab has nothing left to do.
          if (conn.status === "pending") await store.deletePending(conn.id).catch(() => null);
          cache.invalidate(conn.id);
          if (conn.status !== "active") stale.add(conn.id);
          return { connection: row ?? (await store.getConnection(conn.id)) ?? conn };
        }
        if (conn.status === "active") await setStatus(conn, "expired", SNAPTRADE_DETAIL.ended(name));
      }
      if (!ctx.returnOrigin || !ctx.bindingHash) {
        throw badRequest(`Reconnecting ${name} needs a new login. Press Reconnect on the Brokers page.`, "needs_login");
      }
      const t = now();
      const until = /** @type {string} */ (iso(t + config.oauth.loginWindowMs));
      await store.putPending({ connection_id: conn.id, binding_hash: ctx.bindingHash, return_origin: ctx.returnOrigin, expires_at: until });
      const row = await store.updateConnection(conn.id, { status: "pending", status_detail: FLOW_DETAIL.pending(name), session_expires_at: until });
      return { connection: row ?? conn, next: { kind: "redirect" } };
    },

    /**
     * Disconnect: the authorization goes at SnapTrade, and the workspace's SnapTrade user with its
     * last connection (that stops SnapTrade's per-user billing).
     */
    async revoke(conn) {
      if (!client) return;
      stale.delete(conn.id);
      const user = await users.get(conn.workspace_id);
      if (user && conn.external_ref && SNAPTRADE_ID.test(conn.external_ref)) {
        const holders = await store.listConnections({ workspace_id: conn.workspace_id, method: "snaptrade", external_ref: conn.external_ref, status: ["neq", "disconnected"] });
        if (!holders.some((c) => c.id !== conn.id)) await api().deleteAuthorization(user, conn.external_ref);
      }
      authMemo.delete(conn.workspace_id);
      await users.dropIfUnused(conn.workspace_id, { except: conn.id });
    },

    forget(id) {
      stale.delete(id);
    },

    /**
     * Every 15 minutes, per workspace with a SnapTrade user: one authorization list (refresh() then
     * reads it for each active connection), connections no Nasscord connection uses deleted, and a
     * user without connections deleted.
     */
    async sweep() {
      if (!client) return;
      const t = now();
      const rows = await users.list();
      for (const u of rows) {
        const wid = u.workspace_id;
        try {
          const live = await store.listConnections({ workspace_id: wid, method: "snaptrade", status: ["neq", "disconnected"] });
          if (!live.length) {
            if (t - (parseTime(u.created_at) ?? t) >= SNAPTRADE_ORPHAN_AGE_MS) await users.dropIfUnused(wid);
            continue;
          }
          const user = await users.get(wid);
          if (!user) continue;
          const list = await client.authorizations(user);
          authMemo.set(wid, { at: t, list });
          // Expired (or seemingly lost) connections whose authorization SnapTrade shows working again.
          for (const c of live) {
            if ((c.status === "expired" || c.status === "error") && c.external_ref) await revive(c, list.find((a) => clean(a?.id) === c.external_ref));
          }
          // A login in progress may be about to claim an authorization nobody holds yet.
          if (live.some((c) => c.status === "pending")) continue;
          const held = new Set(live.map((c) => c.external_ref).filter(Boolean));
          for (const a of list) {
            const id = clean(a?.id);
            if (!id || held.has(id) || !SNAPTRADE_ID.test(id)) continue;
            const created = parseSnapTime(a?.created_date);
            if (created === null || t - created < SNAPTRADE_ORPHAN_AGE_MS) continue;
            await client.deleteAuthorization(user, id);
            log.info("snaptrade connection no Nasscord connection uses was deleted", { workspaceId: wid });
          }
        } catch (e) {
          log.warn("snaptrade sweep failed for a workspace", { workspaceId: wid, error: e });
        }
      }
      if (!sweepsStrayUsers) return;
      try {
        const listed = await client.listUsers();
        await users.deleteStrays(listed, new Set(rows.map((r) => r.external_user_id)), { minAgeMs: SNAPTRADE_ORPHAN_AGE_MS });
      } catch (e) {
        log.warn("snaptrade user sweep failed", { error: e });
      }
    },

    ...(client && snap.clientId && snap.consumerKey
      ? { webhook: createSnapTradeWebhook({ clientId: snap.clientId, consumerKey: snap.consumerKey, store, users, log, now, act }) }
      : {}),
  };
  return adapter;
}
