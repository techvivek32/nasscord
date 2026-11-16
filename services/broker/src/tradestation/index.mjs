import { badGateway, badRequest, BrokerAuthError, conflict, SessionExpiredError } from "../errors.mjs";
import { clean, num } from "../mapping.mjs";
import { loginRef } from "../oauth2.mjs";
import { iso, parseTime } from "../time.mjs";
import { createTradeStationClient, orderBudget, sinceDate, TRADESTATION_AUDIENCE, TRADESTATION_OAUTH_PATHS, TRADESTATION_SCOPE, tradestationHosts } from "./client.mjs";
import { byExternalId, errorSentence, mergeOrders, tsAccountRows, tsAccountSummary, tsExecutions, tsOrders, tsPosition } from "./mapping.mjs";

/**
 * TradeStation (method tradestation_oauth): OAuth 2.0 through TradeStation's Auth0 sign-in, with the
 * user's own API key (client "user", flow oauth2_user_app) or, once TradeStation accepts Nasscord as
 * a partner, Nasscord's own key (client "platform"). docs/real-backend.md, "Connect flows".
 *
 * Who may connect: a non-partner key reaches only the accounts under its owner's login, so the
 * user-key method is gated to the platform owner (BROKER_AUDIENCE tradestation_oauth.user=superadmin)
 * until TradeStation agrees in writing. The platform client stays unavailable until
 * TRADESTATION_CLIENT_ID and TRADESTATION_CLIENT_SECRET exist.
 *
 * - Login: Nasscord's one callback (OAUTH_CALLBACK_BASE/api/broker/callback/tradestation) must be on
 *   the key's Allowed Callback URLs; TradeStation Client Experience adds it on request. There is no
 *   localhost paste-code fallback: it would teach users to copy login codes around.
 * - Scope: openid offline_access ReadAccount, audience https://api.tradestation.com, client id and
 *   secret in the token request's form body. external_ref is the id_token `sub` (decoded only, never
 *   trusted for access), else a hash of the key and the account ids.
 * - Tokens: the access token lives 20 minutes and is refreshed lazily (src/oauth2.mjs, under the
 *   lock "token:<id>"). Refresh tokens do not expire by default. A key can be set to rotate them:
 *   then every refresh answers a new refresh token, which is saved before the new access token is
 *   used, the login ends 24 hours after the browser sign-in (session_expires_at, "Reconnect by"),
 *   and an unused refresh token dies after about 30 minutes. So the scheduler (every 5 minutes)
 *   refreshes a rotating login once its access token is 10 minutes old, and one whose rotation is
 *   not known yet (no refresh since the login); a key seen not to rotate is left alone.
 * - Environments: Live, and Paper (the user's own SIM accounts at sim-api) only when
 *   TRADESTATION_ALLOW_SIM is set, after a real login has shown SIM holds only the user's own
 *   activity. A SIM connection left when the setting is off is not read or refreshed (it turns into
 *   an error with that sentence) and its Reconnect never opens TradeStation: flows.genericRenew
 *   refuses an environment the registry no longer offers with this sentence, and the hop refuses it too.
 * - Reads: accounts, balances (+ beginning-of-day balances when day P&L is missing), positions,
 *   today's and open orders plus 89 days of closed orders. Executions come from order legs. What
 *   an order read leaves out is listed at TRADESTATION_DESCRIPTOR.
 * - Disconnect deletes the stored key and tokens. /oauth/revoke is never called: it revokes every
 *   refresh token of the key, including the user's other tools.
 * - Legacy keys (capital letters with dashes) use TradeStation's old sign-in and are refused with a
 *   sentence asking for a newer key (checkClient, which flows.startOAuth calls before any row is
 *   written).
 */

export const TRADESTATION_DETAIL = Object.freeze({
  login: "TradeStation needs a new login. Reconnect to continue.",
  rotated:
    "TradeStation ended this login: your API key rotates its refresh tokens, so TradeStation asks for a new login every 24 hours. Reconnect to continue.",
  refused: "TradeStation no longer accepts Nasscord's access. Reconnect to continue.",
  simOff: "TradeStation Paper (SIM) is not offered on this server. Disconnect this connection.",
});

export const TRADESTATION_MESSAGES = Object.freeze({
  legacyKey:
    "This is an older TradeStation API key (capital letters with dashes), which Nasscord cannot use. Ask TradeStation Client Experience for a newer API key (upper and lower case letters, no dashes) with Nasscord's callback URL, then connect again.",
  badKey: "Paste the TradeStation API key exactly as TradeStation sent it: letters and digits only.",
  noReadScope:
    "TradeStation did not grant read access to your accounts (ReadAccount). Ask TradeStation Client Experience to add the ReadAccount scope to your API key, then connect again.",
  noRefresh:
    "TradeStation did not grant lasting access (offline_access), so this login would end within 20 minutes. Ask TradeStation Client Experience to allow refresh tokens on your API key, then connect again.",
  noSandbox: "TradeStation has no sandbox. Connect your Live account.",
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** TradeStation's access token life (expires_in 1200). */
const ACCESS_LIFE_MS = 20 * MINUTE;
/** A rotating login is refreshed by the sweep once its access token is this old (refresh tokens die after about 30 minutes unused). */
const KEEPALIVE_AGE_MS = 10 * MINUTE;
/** Closed orders are read this far back (TradeStation serves about 90 days). */
const HISTORY_DAYS = 89;
/**
 * Closed orders are reused this long: an order that closes meanwhile is in today's orders, which
 * are read every 30 s, until the day rolls over.
 */
const CLOSED_TTL_MS = 2 * MINUTE;
/**
 * The time one order read may spend at TradeStation once it has a token. The app waits 8 s for
 * /v1/orders across every broker of the workspace, so a busy TradeStation login must not use it all.
 */
const ORDERS_BUDGET_MS = 5_000;
/** The optional beginning-of-day balances call waits at most this long. */
const BOD_TIMEOUT_MS = 3_000;
/** last_ok_at is written at most this often per connection. */
const OK_WRITE_MS = MINUTE;
const READ_TTL = Object.freeze({ portfolio: 15_000, orders: 30_000, executions: 30_000 });

/**
 * Reads are cached 15 s (balances, positions) and 30 s (orders and executions share one fetch;
 * closed orders are reused for 2 minutes). The sweep runs every 5 minutes: rotating logins need a
 * refresh within about 30 minutes, and the 24 h mark should expire the connection on time.
 *
 * What an order read leaves out. orders() and executions() answer lists only (the adapter
 * interface has no errors list for them, unlike portfolio), so these are logged with counts and
 * not shown to the user:
 * - per batch of 10 accounts, today's and open orders past 1,200 and closed orders past 3,000
 *   (newest first, 89 days): client.mjs MAX_CURRENT_PAGES and MAX_HISTORY_PAGES pages of 600;
 * - pages not read within ORDERS_BUDGET_MS (5 s) of one read;
 * - the orders of an account TradeStation answers an Errors[] entry for, unless every account
 *   failed (then the read fails with that sentence).
 * @type {import("../adapter-types.mjs").AdapterDescriptor}
 */
export const TRADESTATION_DESCRIPTOR = Object.freeze(
  /** @type {import("../adapter-types.mjs").AdapterDescriptor} */ ({
    method: "tradestation_oauth",
    brokers: ["tradestation"],
    name: "TradeStation",
    environments: ["production", "paper"],
    readTtlMs: READ_TTL,
    lazyAccounts: false,
    sweepEveryMs: 5 * MINUTE,
    clients: ["user", "platform"],
  }),
);

/**
 * Why a pasted API key cannot be used, or null. Legacy keys are capital letters with dashes
 * ("EAC7BF97-1A2B-..."); Auth0 keys are upper and lower case letters and digits without dashes.
 * @param {unknown} clientId
 * @returns {string | null}
 */
export function keyProblem(clientId) {
  const id = clean(/** @type {string} */ (clientId));
  if (id.includes("-") && id === id.toUpperCase()) return TRADESTATION_MESSAGES.legacyKey;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return TRADESTATION_MESSAGES.badKey;
  return null;
}

/**
 * The token endpoint's refusals as the OAuth engine acts on them. Auth0 answers 403 invalid_grant
 * for a dead refresh token or code, 401 for a wrong key or secret, and 403 access_denied when the
 * user's own grant is refused (blocked, revoked): that one needs a new login, it says nothing about
 * the key.
 * @param {number} status
 * @param {any} json
 * @returns {"invalid_grant" | "invalid_client" | "other"}
 */
export function tsTokenError(status, json) {
  const err = clean(typeof json?.error === "string" ? json.error : "").toLowerCase();
  if (err === "invalid_grant") return "invalid_grant";
  if (err === "invalid_client" || err === "unauthorized_client" || status === 401) return "invalid_client";
  if (status === 403 && err === "access_denied") return "invalid_grant";
  return "other";
}

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {import("../db.mjs").Environment} Environment
 * @typedef {import("../oauth2.mjs").OAuthProfile} OAuthProfile
 * @typedef {import("../oauth2.mjs").OAuthSecret} OAuthSecret
 * @typedef {import("./client.mjs").TradeStationClient} TradeStationClient
 */

/** @param {OAuthSecret | null | undefined} s @returns {"user" | "platform"} */
const clientKind = (s) => (s?.client === "platform" ? "platform" : "user");

/** @param {OAuthProfile} p @param {number} ms */
const refreshWhenUnder = (p, ms) => ({ ...p, refresh: { ...p.refresh, refreshBeforeMs: ms } });

/** @type {import("../adapter-types.mjs").AdapterFactory} */
export function createAdapter(deps) {
  const { config, store, oauth2, cache, log, now } = deps;
  const ts = config.brokers.tradestation;
  const hosts = tradestationHosts(deps.urls, config.production);
  /** @type {Map<string, number>} last time last_ok_at was written */
  const lastOkWrite = new Map();
  /** @type {Map<string, Promise<string>>} a forced refresh in flight per connection (after a 401) */
  const forcing = new Map();
  /** @type {Map<string, { at: number, value: import("./client.mjs").Batched }>} closed orders by "<connectionId>|<account ids>" */
  const closed = new Map();

  /**
   * True once a rotating key's login reached its 24 h end. Before that, a refused refresh (the user
   * removed Nasscord at TradeStation, a refresh token unused for 30 minutes) is a plain new login.
   * @param {OAuthSecret | null | undefined} s
   */
  const rotationEnded = (s) => {
    const end = parseTime(s?.refreshExpiresAt);
    return end !== null && end <= now();
  };

  /**
   * The OAuth profile of an environment and client. `secret` picks the sentence for an ended login
   * (a rotating key's 24 h when that has passed, or a plain new login).
   * @param {Environment} environment
   * @param {"user" | "platform"} client
   * @param {OAuthSecret | null} [secret]
   * @returns {OAuthProfile}
   */
  function profileFor(environment, client, secret = null) {
    if (environment === "sandbox") throw badRequest(TRADESTATION_MESSAGES.noSandbox, "sandbox_refused");
    if (environment === "paper" && !ts.allowSim) throw conflict(TRADESTATION_DETAIL.simOff, "sim_off");
    return {
      brokerId: "tradestation",
      name: "TradeStation",
      authorizeUrl: `${hosts.signin}${TRADESTATION_OAUTH_PATHS.authorize}`,
      tokenUrl: `${hosts.signin}${TRADESTATION_OAUTH_PATHS.token}`,
      clientAuth: "body",
      sendRedirectUri: true,
      scope: TRADESTATION_SCOPE,
      extraAuthorizeParams: { audience: TRADESTATION_AUDIENCE },
      pkce: false,
      platformClient: client === "platform" && ts.clientId && ts.clientSecret ? { clientId: ts.clientId, clientSecret: ts.clientSecret } : null,
      refresh: { kind: "fixed", hardExpiryMs: null, rotatedHardExpiryMs: DAY, accessFallbackMs: ACCESS_LIFE_MS },
      expiredDetail: rotationEnded(secret) ? TRADESTATION_DETAIL.rotated : TRADESTATION_DETAIL.login,
      parseTokenError: tsTokenError,
    };
  }

  /** @param {Environment} environment */
  const baseOf = (environment) => (environment === "paper" ? hosts.sim : hosts.live);

  /**
   * A SIM connection while SIM is off on this server: it becomes an error the user sees, and is
   * never read or renewed.
   * @param {ConnectionRow} conn
   */
  async function simGate(conn) {
    if (conn.environment !== "paper" || ts.allowSim) return;
    cache.invalidate(conn.id);
    await store.updateConnectionIf(conn.id, ["active", "pending"], { status: "error", status_detail: TRADESTATION_DETAIL.simOff }).catch(() => {});
    throw conflict(TRADESTATION_DETAIL.simOff, "sim_off");
  }

  /** @param {string} id */
  async function touch(id) {
    const t = now();
    if (t - (lastOkWrite.get(id) ?? 0) < OK_WRITE_MS) return;
    lastOkWrite.set(id, t);
    await store.updateConnectionIf(id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /**
   * A usable access token (refreshed by the engine when under refreshBeforeMs is left).
   * @param {ConnectionRow} conn
   * @param {{ refreshBeforeMs?: number }} [o]
   * @returns {Promise<string>}
   */
  async function bearer(conn, o = {}) {
    await simGate(conn);
    const secret = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
    const profile = profileFor(conn.environment, clientKind(secret), secret);
    return oauth2.accessToken(conn, o.refreshBeforeMs ? refreshWhenUnder(profile, o.refreshBeforeMs) : profile);
  }

  /**
   * A new access token after TradeStation refused `used` before its end. Concurrent reads that hit
   * the same 401 share one refresh; a token someone else refreshed meanwhile is used as it is.
   * @param {ConnectionRow} conn
   * @param {string} used
   */
  function forceRefresh(conn, used) {
    const running = forcing.get(conn.id);
    if (running) return running;
    const p = (async () => {
      const s = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id, { fresh: true }));
      if (s?.accessToken && s.accessToken !== used && (parseTime(s.accessExpiresAt) ?? 0) > now()) return s.accessToken;
      return bearer(conn, { refreshBeforeMs: Number.MAX_SAFE_INTEGER });
    })().finally(() => forcing.delete(conn.id));
    forcing.set(conn.id, p);
    return p;
  }

  /** @param {string} what */
  const forbiddenRead = (what) => badGateway(`TradeStation refused to send the ${what} of this login (403).`, "broker_forbidden");

  /**
   * Runs a read with the connection's access token. A 401 gets one new token and one more try;
   * refused again, the login is over (expired, Reconnect). A 403 is that read refused, not the
   * login: it fails on its own.
   * @template T
   * @param {ConnectionRow} conn
   * @param {string} what for the sentence ("balances")
   * @param {(client: TradeStationClient) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withClient(conn, what, fn) {
    const token = await bearer(conn);
    /** @param {string} t */
    const run = (t) => fn(createTradeStationClient({ http: deps.http, base: baseOf(conn.environment), token: t, bucketPrefix: `tradestation:${conn.id}`, now }));
    try {
      const out = await run(token);
      await touch(conn.id);
      return out;
    } catch (e) {
      if (!(e instanceof BrokerAuthError)) throw e;
      if (e.brokerStatus !== 401) throw forbiddenRead(what);
    }
    const fresh = await forceRefresh(conn, token);
    if (fresh === token) {
      // The refresh did not go through (TradeStation's sign-in is down): the login may still be fine.
      throw badGateway("TradeStation did not accept Nasscord's access just now and could not renew it. Try again in a moment.", "broker_auth_retry");
    }
    try {
      const out = await run(fresh);
      await touch(conn.id);
      return out;
    } catch (e) {
      if (!(e instanceof BrokerAuthError)) throw e;
      if (e.brokerStatus !== 401) throw forbiddenRead(what);
      lastOkWrite.delete(conn.id);
      await oauth2.expire(conn, TRADESTATION_DETAIL.refused);
      log.info("tradestation refused a new access token; connection expired", { connectionId: conn.id });
      throw new SessionExpiredError(TRADESTATION_DETAIL.refused, { reauth: "redirect" });
    }
  }

  /**
   * Errors[] entries as per-connection errors, one per account and read.
   * @param {ConnectionRow} conn
   * @param {Array<[import("./mapping.mjs").TsError[], string]>} lists
   */
  function partialErrors(conn, lists) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {Array<{ connectionId: string, message: string }>} */
    const out = [];
    for (const [errors, what] of lists) {
      for (const e of errors) {
        const message = errorSentence(e, what);
        if (seen.has(message)) continue;
        seen.add(message);
        out.push({ connectionId: conn.id, message });
      }
    }
    return out;
  }

  /**
   * Closed orders of these accounts, reused for CLOSED_TTL_MS. A read cut short by its time budget
   * is not kept, so the next read tries again.
   * @param {TradeStationClient} c
   * @param {ConnectionRow} conn
   * @param {string[]} ids
   * @param {import("./client.mjs").OrderBudget} budget
   * @returns {Promise<import("./client.mjs").Batched>}
   */
  async function closedOrders(c, conn, ids, budget) {
    const key = `${conn.id}|${[...ids].sort().join(",")}`;
    const t = now();
    const hit = closed.get(key);
    if (hit && t - hit.at < CLOSED_TTL_MS) return hit.value;
    const value = await c.historicalOrders(ids, sinceDate(t - HISTORY_DAYS * DAY), budget);
    for (const [k, v] of closed) if (t - v.at >= CLOSED_TTL_MS) closed.delete(k);
    if (value.cut !== "time") closed.set(key, { at: t, value });
    return value;
  }

  /**
   * Today's and open orders plus closed orders, merged: one fetch serves orders() and executions()
   * (both TradeStation lists count against the same order-details quota). The calls share a time
   * budget of ORDERS_BUDGET_MS; what a read leaves out is listed at TRADESTATION_DESCRIPTOR.
   * @param {ConnectionRow} conn
   * @param {AccountRow[]} accounts
   * @returns {Promise<{ merged: any[], fetchedAt: number }>}
   */
  function orderData(conn, accounts) {
    const key = `${conn.id}:tsorders:${accounts.map((a) => a.id).sort().join(",")}`;
    return cache.get(
      key,
      () =>
        withClient(conn, "orders", async (c) => {
          const ids = accounts.map((a) => a.external_id);
          const t = now();
          const budget = orderBudget(now, ORDERS_BUDGET_MS);
          const current = await c.orders(ids, budget);
          const history = await closedOrders(c, conn, ids, budget);
          const errors = [...current.errors, ...history.errors];
          const failed = new Set(errors.map((e) => clean(e?.AccountID)).filter(Boolean));
          if (ids.length > 0 && ids.every((id) => failed.has(id))) throw badGateway(errorSentence(errors[0], "orders"), "broker_partial");
          if (failed.size || current.cut || history.cut) {
            log.info("tradestation orders read in part", {
              connectionId: conn.id,
              accountsLeftOut: failed.size,
              todayCut: current.cut ?? "no",
              closedCut: history.cut ?? "no",
            });
          }
          return { merged: mergeOrders(current.items, history.items, accounts), fetchedAt: t };
        }),
      READ_TTL.orders,
    );
  }

  /** @type {import("../adapter-types.mjs").BrokerAdapter} */
  const adapter = {
    descriptor: TRADESTATION_DESCRIPTOR,

    environmentsFor: (c) => (c.brokers.tradestation.allowSim ? ["production", "paper"] : ["production"]),

    oauthProfile: (environment, client) => profileFor(environment, client),

    /**
     * After the code exchange (canonical host, the connection still pending): the login's name and
     * what it was granted. A login without ReadAccount, or without a refresh token, is refused here
     * with what to ask TradeStation for, before the user's host claims it.
     */
    async identify(conn, tokens, secret) {
      const granted = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
      if (granted.length > 0 && !granted.includes("ReadAccount")) throw badRequest(TRADESTATION_MESSAGES.noReadScope, "tradestation_scope");
      if (!tokens.refreshToken) throw badRequest(TRADESTATION_MESSAGES.noRefresh, "tradestation_no_refresh");
      let ref = loginRef({ idToken: tokens.idToken });
      if (!ref) {
        // No id_token: name the login by a hash of its key and its account ids.
        const c = createTradeStationClient({ http: deps.http, base: baseOf(conn.environment), token: tokens.accessToken, bucketPrefix: "tradestation:*:connect" });
        const ids = tsAccountRows(await c.accounts(), conn.environment).map((a) => a.external_id);
        ref = loginRef({ key: secret.client === "user" ? (secret.clientId ?? null) : ts.clientId, members: ids });
      }
      if (!ref) throw badGateway("TradeStation did not say which login this is. Start again from Brokers.", "no_identity");
      // The first access token's end: while the secret still holds it, no refresh has happened and
      // the sweep cannot tell yet whether the key rotates its refresh tokens.
      return { externalRef: ref, scope: tokens.scope ?? null, extra: { loginAccessExpiresAt: tokens.accessExpiresAt } };
    },

    async listAccounts(conn) {
      return withClient(conn, "account list", async (c) => tsAccountRows(await c.accounts(), conn.environment));
    },

    async portfolio(conn, accounts) {
      const ids = accounts.map((a) => a.external_id);
      const known = byExternalId(accounts);
      const { balances, positions, bod } = await withClient(conn, "balances and positions", async (c) => {
        const [b, p] = await Promise.all([c.balances(ids), c.positions(ids)]);
        // Day P&L baseline only for accounts whose balance has no TodaysProfitLoss.
        const missing = b.items.filter((x) => num(x?.TodaysProfitLoss) === undefined && known.has(clean(x?.AccountID))).map((x) => clean(x.AccountID));
        /** @type {import("./client.mjs").Batched} */
        let start = { items: [], errors: [], cut: null };
        if (missing.length) {
          start = await c.bodBalances(missing, { timeoutMs: BOD_TIMEOUT_MS }).catch((e) => {
            // Only a refused token matters here (withClient renews it and reads again). Anything
            // else, a 403 on this optional read included, leaves those accounts' day P&L unreported.
            if (e instanceof BrokerAuthError && e.brokerStatus === 401) throw e;
            return { items: [], errors: [], cut: null };
          });
        }
        return { balances: b, positions: p, bod: start };
      });
      const bodBy = new Map(bod.items.map((x) => [clean(x?.AccountID), x]));
      /** @type {Map<string, import("../mapping.mjs").AccountSummary>} */
      const summaries = new Map();
      for (const b of balances.items) {
        const acct = known.get(clean(b?.AccountID));
        if (acct && !summaries.has(acct.id)) summaries.set(acct.id, tsAccountSummary(b, acct, bodBy.get(acct.external_id)));
      }
      /** @type {import("../mapping.mjs").Position[]} */
      const list = [];
      for (const p of positions.items) {
        const acct = known.get(clean(p?.AccountID));
        if (acct) list.push(tsPosition(p, acct));
      }
      return {
        accounts: [...summaries.values()],
        positions: list,
        errors: partialErrors(conn, [
          [balances.errors, "balances"],
          [positions.errors, "positions"],
        ]),
      };
    },

    async orders(conn, accounts) {
      const { merged, fetchedAt } = await orderData(conn, accounts);
      return tsOrders(merged, accounts, fetchedAt);
    },

    async executions(conn, accounts) {
      const { merged, fetchedAt } = await orderData(conn, accounts);
      return tsExecutions(merged, accounts, fetchedAt);
    },

    /**
     * The scheduler (every 5 minutes) and renew, both under the connection's lock:
     * - the 24 h end of a rotating key passed: expired, with that sentence;
     * - a rotating key, or one not refreshed since the login: refreshed once its access token is 10
     *   minutes old, so the refresh token is used well within its 30 minutes;
     * - a key seen not to rotate: "skipped" (its refresh token does not expire; reads refresh it).
     */
    async refresh(conn) {
      await simGate(conn);
      // The engine's in-process copy: every save (refresh, exchange, expiry) updates it, and the
      // service runs as one process, so the 5-minute sweep does not read every secret again.
      const secret = /** @type {OAuthSecret | null} */ (await oauth2.loadSecret(conn.id));
      if (!secret || (!secret.refreshToken && !secret.accessToken)) {
        await oauth2.expire(conn, TRADESTATION_DETAIL.login);
        return "expired";
      }
      const end = parseTime(secret.refreshExpiresAt);
      if (end !== null && end <= now()) {
        lastOkWrite.delete(conn.id);
        await oauth2.expire(conn, TRADESTATION_DETAIL.rotated);
        log.info("tradestation login reached its 24 hour end; connection expired", { connectionId: conn.id });
        return "expired";
      }
      const firstToken = secret.extra?.loginAccessExpiresAt;
      const unknown = end === null && typeof firstToken === "string" && firstToken === secret.accessExpiresAt;
      if (end === null && !unknown) return "skipped";
      try {
        await bearer(conn, { refreshBeforeMs: ACCESS_LIFE_MS - KEEPALIVE_AGE_MS });
        return "ok";
      } catch (e) {
        if (e instanceof SessionExpiredError) return "expired";
        throw e;
      }
    },

    /**
     * Never /oauth/revoke: TradeStation revokes every refresh token of the key with it, so the
     * user's other tools would lose their logins too. Disconnect deletes the stored key and tokens.
     */
    async revoke() {},

    forget(id) {
      lastOkWrite.delete(id);
      forcing.delete(id);
      for (const k of [...closed.keys()]) if (k.startsWith(`${id}|`)) closed.delete(k);
    },
  };

  /**
   * The pasted key's format, checked before any login starts (flows.startOAuth calls it for the
   * user's own key; adapter-types lists it as checkClient).
   * @param {{ clientId: string, clientSecret?: string }} input
   */
  function checkClient(input) {
    const problem = keyProblem(input?.clientId);
    if (problem) throw badRequest(problem, problem === TRADESTATION_MESSAGES.legacyKey ? "tradestation_legacy_key" : "bad_client_id");
  }

  return Object.assign(adapter, { checkClient });
}
