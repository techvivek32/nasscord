import { randomUUID } from "node:crypto";
import { badRequest, conflict, SessionExpiredError } from "../errors.mjs";
import {
  etradeAccountRows,
  etradeAccountSummary,
  etradeExecutions,
  etradeOrders,
  etradePosition,
} from "../mapping.mjs";
import { iso, nextMidnightEt, parseTime } from "../time.mjs";
import { createEtradeClient, ETRADE_URLS, EtradeAuthError } from "./client.mjs";

/**
 * E*TRADE connections (contract section 8): start -> verify -> reads, renew, disconnect, and the
 * midnight-Eastern expiry. Consumer key, secret and tokens live only in `broker_secrets`,
 * encrypted; a short in-memory copy saves a database read per broker call.
 */

export const ETRADE_DETAIL = Object.freeze({
  pending: "Approve access on E*TRADE, then paste the verification code here.",
  codeTimeout: "The E*TRADE code was not entered within 5 minutes. Start again.",
  midnight: "E*TRADE ends every session at midnight Eastern. Reconnect to continue.",
  ended: "E*TRADE ended the session. Reconnect to continue.",
  accountsLater: "Connected. E*TRADE has not sent the account list yet; it loads on the next refresh.",
});

const REQUEST_TOKEN_MS = 5 * 60_000;
const SECRET_CACHE_MS = 10 * 60_000;
/** Renew a token nobody has used for this long, before E*TRADE's 2-hour idle cut-off. */
export const ETRADE_IDLE_RENEW_MS = 90 * 60_000;
const KEY_SHAPE = /^[\x21-\x7e]{8,256}$/;
const CODE_SHAPE = /^[A-Za-z0-9]{3,32}$/;

/**
 * @typedef {import("../db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("../db.mjs").AccountRow} AccountRow
 * @typedef {{ consumerKey: string, consumerSecret: string, requestToken?: string, requestSecret?: string,
 *   accessToken?: string, accessSecret?: string }} EtradeSecret
 */

/**
 * @param {{
 *   store: import("../db.mjs").Store,
 *   secretBox: import("../secrets.mjs").SecretBox,
 *   limiter: import("../limits.mjs").Limiter,
 *   cache: import("../cache.mjs").CoalescingCache,
 *   log: import("../log.mjs").Logger,
 *   allowSandbox: boolean,
 *   now?: () => number,
 *   urls?: import("./client.mjs").EtradeUrls,
 *   fetch?: typeof fetch,
 *   signer?: import("./oauth1.mjs").OAuth1Signer,
 * }} deps
 */
export function createEtradeAdapter(deps) {
  const { store, secretBox, limiter, cache, log, allowSandbox, now = Date.now, urls = ETRADE_URLS } = deps;
  /** @type {Map<string, { value: EtradeSecret | null, at: number }>} */
  const secrets = new Map();
  /** @type {Map<string, number>} last successful broker call per connection */
  const lastUse = new Map();
  /** @type {Map<string, number>} last time last_ok_at was written */
  const lastOkWrite = new Map();

  /** @param {ConnectionRow | { id: string, environment: string }} connection @param {EtradeSecret} secret */
  const clientFor = (connection, secret) =>
    createEtradeClient({
      environment: /** @type {"production" | "sandbox"} */ (connection.environment),
      consumerKey: secret.consumerKey,
      consumerSecret: secret.consumerSecret,
      connectionId: connection.id,
      urls,
      fetch: deps.fetch,
      signer: deps.signer,
      limiter,
    });

  /** @param {string} id @returns {Promise<EtradeSecret | null>} */
  async function loadSecret(id) {
    const hit = secrets.get(id);
    if (hit && now() - hit.at < SECRET_CACHE_MS) return hit.value;
    const row = await store.getSecret(id);
    const value = row ? /** @type {EtradeSecret} */ (secretBox.decrypt(id, row)) : null;
    secrets.set(id, { value, at: now() });
    // A row sealed with an older key is re-sealed with the current one on first use.
    if (row && value && secretBox.needsRotation(row)) await saveSecret(id, value).catch(() => {});
    return value;
  }

  /** @param {string} id @param {EtradeSecret} value */
  async function saveSecret(id, value) {
    await store.putSecret({ connection_id: id, ...secretBox.encrypt(id, value) });
    secrets.set(id, { value, at: now() });
  }

  /** @param {string} id */
  async function touch(id) {
    const t = now();
    lastUse.set(id, t);
    if (t - (lastOkWrite.get(id) ?? 0) < 60_000) return;
    lastOkWrite.set(id, t);
    await store.updateConnectionIf(id, ["active"], { last_ok_at: iso(t) }).catch(() => {});
  }

  /**
   * Marks the connection expired and drops the dead access token (the consumer key stays so a
   * reconnect does not need it pasted again).
   * @param {ConnectionRow} connection
   * @param {string} detail
   */
  async function expire(connection, detail) {
    const secret = await loadSecret(connection.id).catch(() => null);
    if (secret && (secret.accessToken || secret.requestToken)) {
      await saveSecret(connection.id, { consumerKey: secret.consumerKey, consumerSecret: secret.consumerSecret });
    }
    cache.invalidate(connection.id);
    lastUse.delete(connection.id);
    return store.updateConnectionIf(connection.id, ["active", "pending"], {
      status: "expired",
      status_detail: detail,
    });
  }

  /**
   * Runs a read with the access token. A 401 gets one same-day renew and one retry; after that the
   * connection is marked expired.
   * @template T
   * @param {ConnectionRow} connection
   * @param {(client: import("./client.mjs").EtradeClient, tokens: { token: string, secret: string }) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function withSession(connection, fn) {
    if (connection.status !== "active") throw new SessionExpiredError(connection.status_detail || ETRADE_DETAIL.ended);
    const secret = await loadSecret(connection.id);
    if (!secret?.accessToken || !secret.accessSecret) {
      await expire(connection, ETRADE_DETAIL.ended);
      throw new SessionExpiredError(ETRADE_DETAIL.ended);
    }
    const client = clientFor(connection, secret);
    const tokens = { token: secret.accessToken, secret: secret.accessSecret };
    try {
      const out = await fn(client, tokens);
      await touch(connection.id);
      return out;
    } catch (e) {
      if (!(e instanceof EtradeAuthError)) throw e;
      const expiresAt = parseTime(connection.session_expires_at) ?? 0;
      if (e.problem !== "token_expired" && expiresAt > now()) {
        try {
          await client.renewAccessToken(tokens);
          const out = await fn(client, tokens);
          await touch(connection.id);
          return out;
        } catch (e2) {
          if (!(e2 instanceof EtradeAuthError)) throw e2;
        }
      }
      const detail = expiresAt <= now() ? ETRADE_DETAIL.midnight : ETRADE_DETAIL.ended;
      log.info("etrade session ended", { connectionId: connection.id, problem: e.problem });
      await expire(connection, detail);
      throw new SessionExpiredError(detail);
    }
  }

  /** @param {unknown} v @param {string} what */
  function credential(v, what) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!KEY_SHAPE.test(s)) throw badRequest(`Paste the ${what} exactly as E*TRADE shows it.`);
    return s;
  }

  /**
   * Reads the account list and stores it. Once accounts arrive after verify could not list them,
   * the "account list not sent yet" detail goes, so the connection stops showing a warning.
   * @param {ConnectionRow} connection
   */
  async function syncAccounts(connection) {
    const list = await withSession(connection, (client, tokens) => client.getJson("/v1/accounts/list", tokens));
    const rows = etradeAccountRows(list, connection);
    await store.upsertAccounts(rows);
    if (rows.length > 0 && connection.status_detail === ETRADE_DETAIL.accountsLater) {
      await store.updateConnectionIf(connection.id, ["active"], { status_detail: null }).catch((e) => {
        log.warn("etrade status detail not cleared", { connectionId: connection.id, error: e });
      });
      cache.invalidate(connection.id);
    }
    return rows;
  }

  /** @param {AccountRow[]} accounts */
  const accountsKey = (accounts) => accounts.map((a) => a.id).sort().join(",");

  /**
   * Raw orders per account, shared by orders() and executions() through the cache.
   * @param {ConnectionRow} connection
   * @param {AccountRow[]} accounts
   * @returns {Promise<Array<{ account: AccountRow, resp: any }>>}
   */
  function rawOrders(connection, accounts) {
    return cache.get(`${connection.id}:etrade-orders:${accountsKey(accounts)}`, () =>
      withSession(connection, async (client, tokens) => {
        const out = [];
        for (const account of accounts) {
          const resp = await client.getJson(`/v1/accounts/${encodeURIComponent(account.external_id)}/orders`, tokens, {
            count: 100,
          });
          out.push({ account, resp });
        }
        return out;
      }),
    );
  }

  return {
    ETRADE_DETAIL,
    loadSecret,
    expire,

    /**
     * @param {{ claims: import("../jwt.mjs").ServiceClaims, environment: unknown, consumerKey: unknown, consumerSecret: unknown }} input
     * @returns {Promise<{ connection: ConnectionRow, authorizeUrl: string }>}
     */
    async start({ claims, environment, consumerKey, consumerSecret }) {
      if (environment !== "production" && environment !== "sandbox") {
        throw badRequest("Choose Production or Sandbox for the E*TRADE key.");
      }
      if (environment === "sandbox" && !allowSandbox) {
        throw badRequest("Sandbox keys are not accepted here. Use a production key from developer.etrade.com.");
      }
      const key = credential(consumerKey, "consumer key");
      const secret = credential(consumerSecret, "consumer secret");
      const id = randomUUID();
      const client = clientFor({ id, environment }, { consumerKey: key, consumerSecret: secret });

      let rt;
      try {
        rt = await client.requestToken();
      } catch (e) {
        if (e instanceof EtradeAuthError) {
          throw badRequest(
            `E*TRADE did not accept this consumer key and secret. Check both, and that the key is a ${environment} key.`,
            "etrade_key_rejected",
          );
        }
        throw e;
      }

      // Earlier attempts in this workspace that never got past the code step are dead ends now
      // that a new one starts: remove them rather than leave them listed as expired.
      const abandoned = await store.listConnections({
        workspace_id: /** @type {string} */ (claims.wid),
        broker_id: "etrade",
        environment,
        status: ["in", ["pending", "expired"]],
      });
      for (const c of abandoned) {
        if ((await store.listAccounts([c.id])).length === 0) {
          await store.deleteConnection(c.id).catch(() => {});
          secrets.delete(c.id);
        }
      }

      const t = now();
      const connection = await store.insertConnection({
        id,
        workspace_id: claims.wid,
        user_id: claims.sub,
        broker_id: "etrade",
        method: "etrade_oauth1",
        environment,
        status: "pending",
        status_detail: ETRADE_DETAIL.pending,
        session_expires_at: iso(t + REQUEST_TOKEN_MS),
      });
      try {
        await saveSecret(id, { consumerKey: key, consumerSecret: secret, requestToken: rt.token, requestSecret: rt.secret });
      } catch (e) {
        await store.deleteConnection(id).catch(() => {});
        secrets.delete(id);
        throw e;
      }
      return { connection, authorizeUrl: client.authorizeUrl(rt.token) };
    },

    /**
     * @param {ConnectionRow} connection
     * @param {unknown} verifierInput
     * @returns {Promise<ConnectionRow>}
     */
    async verify(connection, verifierInput) {
      const verifier = typeof verifierInput === "string" ? verifierInput.trim() : "";
      if (!CODE_SHAPE.test(verifier)) throw badRequest("Paste the verification code E*TRADE showed you.");
      if (connection.status !== "pending") {
        throw conflict("This connection is not waiting for a verification code. Start again.", "not_pending");
      }
      if ((parseTime(connection.session_expires_at) ?? 0) <= now()) {
        await expire(connection, ETRADE_DETAIL.codeTimeout);
        throw conflict("The E*TRADE code expired. Codes last 5 minutes. Start again.", "code_expired");
      }
      const secret = await loadSecret(connection.id);
      if (!secret?.requestToken || !secret.requestSecret) {
        throw conflict("This connection is not waiting for a verification code. Start again.", "not_pending");
      }
      const client = clientFor(connection, secret);
      let access;
      try {
        access = await client.accessToken({ token: secret.requestToken, secret: secret.requestSecret, verifier });
      } catch (e) {
        if (e instanceof EtradeAuthError) {
          throw badRequest("E*TRADE did not accept this code. Copy it again, or start over if it is older than 5 minutes.", "etrade_code_rejected");
        }
        throw e;
      }
      await saveSecret(connection.id, {
        consumerKey: secret.consumerKey,
        consumerSecret: secret.consumerSecret,
        accessToken: access.token,
        accessSecret: access.secret,
      });
      const t = now();
      let row = await store.updateConnection(connection.id, {
        status: "active",
        status_detail: null,
        session_expires_at: iso(nextMidnightEt(t)),
        last_ok_at: iso(t),
      });
      if (!row) throw conflict("This connection was removed while it was being verified.");
      lastUse.set(connection.id, t);
      cache.invalidate(connection.id);
      try {
        await syncAccounts(row);
      } catch (e) {
        log.warn("etrade account list failed after verify", { connectionId: connection.id, error: e });
        row = (await store.updateConnection(connection.id, { status_detail: ETRADE_DETAIL.accountsLater })) ?? row;
      }
      return row;
    },

    syncAccounts,

    /**
     * Same-day renew while the token is alive. Otherwise a fresh request token with the stored key,
     * and the authorize URL comes back as `loginUrl` for a new verification code.
     * @param {ConnectionRow} connection
     * @returns {Promise<{ connection: ConnectionRow, loginUrl?: string }>}
     */
    async renew(connection) {
      const expiresAt = parseTime(connection.session_expires_at) ?? 0;
      if (connection.status === "active" && expiresAt > now()) {
        try {
          await withSession(connection, (client, tokens) => client.renewAccessToken(tokens));
          const row = await store.updateConnection(connection.id, { status_detail: null, last_ok_at: iso(now()) });
          return { connection: row ?? connection };
        } catch (e) {
          if (!(e instanceof SessionExpiredError)) throw e;
        }
      }
      const secret = await loadSecret(connection.id);
      if (!secret?.consumerKey || !secret.consumerSecret) {
        throw conflict("Connect E*TRADE again with your consumer key and secret.", "no_key");
      }
      const client = clientFor(connection, secret);
      let rt;
      try {
        rt = await client.requestToken();
      } catch (e) {
        if (e instanceof EtradeAuthError) {
          throw badRequest("E*TRADE no longer accepts the saved consumer key. Remove this connection and add it again with a current key.", "etrade_key_rejected");
        }
        throw e;
      }
      await saveSecret(connection.id, {
        consumerKey: secret.consumerKey,
        consumerSecret: secret.consumerSecret,
        requestToken: rt.token,
        requestSecret: rt.secret,
      });
      cache.invalidate(connection.id);
      const row = await store.updateConnection(connection.id, {
        status: "pending",
        status_detail: ETRADE_DETAIL.pending,
        session_expires_at: iso(now() + REQUEST_TOKEN_MS),
      });
      return { connection: row ?? connection, loginUrl: client.authorizeUrl(rt.token) };
    },

    /**
     * Revokes the access token (best effort) and deletes the stored secret.
     * @param {ConnectionRow} connection
     */
    async disconnect(connection) {
      const secret = await loadSecret(connection.id).catch(() => null);
      if (secret?.accessToken && secret.accessSecret) {
        try {
          await clientFor(connection, secret).revokeAccessToken({ token: secret.accessToken, secret: secret.accessSecret });
        } catch (e) {
          log.info("etrade revoke failed (token may already be dead)", { connectionId: connection.id, error: e });
        }
      }
      await store.deleteSecret(connection.id);
      secrets.delete(connection.id);
      lastUse.delete(connection.id);
      lastOkWrite.delete(connection.id);
    },

    /**
     * Balances and positions of the included accounts.
     * @param {ConnectionRow} connection
     * @param {AccountRow[]} accounts
     */
    async portfolio(connection, accounts) {
      return withSession(connection, async (client, tokens) => {
        /** @type {import("../mapping.mjs").AccountSummary[]} */
        const summaries = [];
        /** @type {import("../mapping.mjs").Position[]} */
        const positions = [];
        for (const account of accounts) {
          const key = encodeURIComponent(account.external_id);
          const balance = await client.getJson(`/v1/accounts/${key}/balance`, tokens, { instType: "BROKERAGE", realTimeNAV: "true" });
          let totals = null;
          for (let page = 1; page <= 10; page++) {
            /** @type {Record<string, string | number>} */
            const query = { count: 50, view: "QUICK", totalsRequired: "true" };
            if (page > 1) query.pageNumber = page;
            const resp = await client.getJson(`/v1/accounts/${key}/portfolio`, tokens, query);
            const pr = resp?.PortfolioResponse;
            if (!pr) break;
            totals = totals ?? pr.Totals ?? null;
            const groups = Array.isArray(pr.AccountPortfolio) ? pr.AccountPortfolio : pr.AccountPortfolio ? [pr.AccountPortfolio] : [];
            let more = false;
            for (const g of groups) {
              const list = Array.isArray(g.Position) ? g.Position : g.Position ? [g.Position] : [];
              for (const p of list) positions.push(etradePosition(p, account));
              if (g.nextPageNo && Number(g.nextPageNo) > page && Number(g.totalPages ?? 0) > page) more = true;
            }
            if (!more) break;
          }
          summaries.push(etradeAccountSummary(balance, totals, account));
        }
        return { accounts: summaries, positions };
      });
    },

    /** @param {ConnectionRow} connection @param {AccountRow[]} accounts */
    async orders(connection, accounts) {
      const fetchedAt = now();
      return (await rawOrders(connection, accounts)).flatMap(({ account, resp }) => etradeOrders(resp, account, fetchedAt));
    },

    /** @param {ConnectionRow} connection @param {AccountRow[]} accounts */
    async executions(connection, accounts) {
      const fetchedAt = now();
      return (await rawOrders(connection, accounts)).flatMap(({ account, resp }) => etradeExecutions(resp, account, fetchedAt));
    },

    /**
     * Keeps an unused token from going idle (E*TRADE drops it after 2 hours without calls).
     * @param {ConnectionRow} connection
     * @returns {Promise<boolean>} true when a renew was sent
     */
    async keepFresh(connection) {
      if (connection.status !== "active") return false;
      const expiresAt = parseTime(connection.session_expires_at) ?? 0;
      const t = now();
      if (expiresAt - t < 10 * 60_000) return false;
      const last = lastUse.get(connection.id) ?? parseTime(connection.last_ok_at) ?? 0;
      if (t - last < ETRADE_IDLE_RENEW_MS) return false;
      try {
        await withSession(connection, (client, tokens) => client.renewAccessToken(tokens));
        return true;
      } catch (e) {
        if (!(e instanceof SessionExpiredError)) log.warn("etrade keep-fresh renew failed", { connectionId: connection.id, error: e });
        return false;
      }
    },

    /** @param {string} id */
    forget(id) {
      secrets.delete(id);
      lastUse.delete(id);
      lastOkWrite.delete(id);
    },
  };
}

/** @typedef {ReturnType<typeof createEtradeAdapter>} EtradeAdapter */
