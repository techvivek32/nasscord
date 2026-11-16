import { randomUUID } from "node:crypto";
import { badRequest, BrokerAuthError, conflict, forbidden, gone, HttpError, SessionExpiredError } from "./errors.mjs";
import { hashMatches, randomToken, sha256Hex } from "./oauth2.mjs";
import { BROKER_NAMES, METHODS } from "./registry.mjs";
import { iso, parseTime } from "./time.mjs";

/**
 * The generic connect steps behind the new routes (docs/real-backend.md, "Connect flows").
 *
 * api_key          POST /v1/keys/connect: the adapter checks the key with the broker; a key of a
 *                  login the workspace already has reuses that connection (Included switches kept).
 * OAuth, SnapTrade three hops, so a code or a portal result never reaches a host other than the
 *                  canonical one (OAUTH_CALLBACK_BASE):
 *   1. start (the user's own host, signed in): a pending connection and a hand-off row holding
 *      sha256 of the binding nonce N. The app keeps N in an HttpOnly cookie on the user's host.
 *   2. hop (canonical host): the app proves N, sets the same cookie on the canonical host, and
 *      gets the broker's URL (a fresh state, or SnapTrade's portal link).
 *   3. complete (canonical callback): the app sends the state (or the connection id for SnapTrade)
 *      and the canonical cookie; the code is exchanged here and only an opaque one-time ticket goes
 *      on to the user's host.
 *   4. claim (the user's own host, signed in, same user): ticket + the host's cookie -> active.
 * A login approved by a victim whose browser never did the hop has no canonical cookie and is
 * refused at step 3; a ticket that leaks is useless without the starter's session and cookie.
 * The steps on the canonical host carry no user session: they are authorised by the nonces alone,
 * and audited as the connection's owner.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
/** Nonces, states and tickets: base64url, 32 to 128 characters. */
const OPAQUE = /^[A-Za-z0-9_-]{32,128}$/;
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** Sentences stored on the connection (status_detail) by the generic flows. */
export const FLOW_DETAIL = Object.freeze({
  /** @param {string} name */
  pending: (name) => `Approve access on ${name} to finish connecting.`,
  /** @param {string} name */
  finishing: (name) => `Finishing the ${name} connection in Nasscord.`,
  loginTimeout: "The login was not finished within 10 minutes. Start again.",
  claimTimeout: "The login was not finished in Nasscord. Start again.",
  otherBrowser: "The login was not finished in the browser that started it. Start again.",
  /** @param {string} name */
  denied: (name) => `You did not approve access on ${name}. Start again to connect.`,
  /** @param {string} name */
  accountsLater: (name) => `Connected. ${name} has not sent the account list yet; it loads on the next refresh.`,
});

const LINK_EXPIRED = "This login link expired or was already used. Start again from Brokers.";
const OTHER_BROWSER =
  "This login was started in another browser or on another device. Start again from Brokers in the browser you use for Nasscord.";

/** "jordan.martin@x.com" -> "jo•••@x.com" (the hop page names who asked for the login). @param {string | null} email */
export function maskEmail(email) {
  if (!email || !email.includes("@")) return null;
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}•••@${domain}`;
}

/**
 * @typedef {import("./jwt.mjs").ServiceClaims} Claims
 * @typedef {import("./db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("./adapter-types.mjs").BrokerAdapter} BrokerAdapter
 * @typedef {import("./adapter-types.mjs").RenewNext} RenewNext
 * @typedef {import("./registry.mjs").ConnectOption} ConnectOption
 * @typedef {{
 *   requireWorkspace: (claims: Claims) => string,
 *   owned: (claims: Claims, id: unknown) => Promise<ConnectionRow>,
 *   audited: <T>(claims: Claims, action: string, target: string, fn: () => Promise<T>, meta?: Record<string, unknown>) => Promise<T>,
 *   throttle: (claims: Claims, kind: "connect" | "start" | "verify" | "ticket") => void,
 *   view: (row: ConnectionRow) => Promise<any>,
 *   target: (row: ConnectionRow) => string,
 * }} FlowHelpers
 */

/**
 * @param {{
 *   config: import("./config.mjs").Config,
 *   registry: import("./registry.mjs").Registry,
 *   store: import("./db.mjs").Store,
 *   oauth2: import("./oauth2.mjs").OAuth2Engine,
 *   audit: import("./audit.mjs").Audit,
 *   cache: import("./cache.mjs").CoalescingCache,
 *   locks: import("./locks.mjs").Locks,
 *   log: import("./log.mjs").Logger,
 *   now?: () => number,
 *   helpers: FlowHelpers,
 * }} deps
 */
export function createFlows(deps) {
  const { config, registry, store, oauth2, audit, cache, locks, log, helpers } = deps;
  const now = deps.now ?? Date.now;
  const { requireWorkspace, owned, audited, throttle, view, target } = helpers;
  const loginWindowMs = config.oauth.loginWindowMs;

  /** @param {string} brokerId */
  const nameOf = (brokerId) => BROKER_NAMES[brokerId] ?? brokerId;
  /** @param {unknown} v */
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  /** The owner of a connection as an audit actor (the canonical-host steps carry no user). @param {ConnectionRow} c */
  const ownerOf = (c) => /** @type {Claims} */ ({ sub: c.user_id, wid: c.workspace_id, role: "trader", iss: "", aud: "", iat: 0, exp: 0 });

  /** @param {unknown} v */
  function originOf(v) {
    const s = str(v).toLowerCase().replace(/\/+$/, "");
    if (!ORIGIN.test(s)) throw badRequest("The address to return to after the login is not valid.", "bad_origin");
    if (config.production && !s.startsWith("https://")) throw badRequest("The address to return to after the login must use https.", "bad_origin");
    return s;
  }
  /** @param {unknown} v */
  function hashOf(v) {
    const s = str(v).toLowerCase();
    if (!HASH.test(s)) throw badRequest("The login binding is missing. Start again from Brokers.", "bad_binding");
    return s;
  }
  /** @param {unknown} v @param {string} what */
  function opaqueOf(v, what) {
    const s = str(v);
    if (!OPAQUE.test(s)) throw badRequest(`The login ${what} is missing or not valid. Start again from Brokers.`, `bad_${what}`);
    return s;
  }
  /** @param {unknown} v */
  function uuidOf(v) {
    const s = str(v);
    if (!UUID.test(s)) throw gone(LINK_EXPIRED, "login_expired");
    return s.toLowerCase();
  }

  /**
   * The environment a connect step asked for, or the first one offered (production first).
   * @param {ConnectOption} opt
   * @param {unknown} v
   */
  function pickEnvironment(opt, v) {
    const name = nameOf(opt.brokerId);
    const asked = str(v);
    if (!asked) return opt.environments.includes("production") ? "production" : /** @type {import("./db.mjs").Environment} */ (opt.environments[0]);
    if (asked === "sandbox" && config.production) {
      throw badRequest(`${name} sandbox accounts hold sample data and are not accepted here. Connect your own account.`, "sandbox_refused");
    }
    if (!opt.environments.includes(/** @type {any} */ (asked))) {
      const words = opt.environments.map((e) => (e === "production" ? "Live" : e === "paper" ? "Paper" : "Sandbox"));
      throw badRequest(`Choose ${words.join(" or ")} for ${name}.`, "bad_environment");
    }
    return /** @type {import("./db.mjs").Environment} */ (asked);
  }

  /**
   * Earlier attempts of the same workspace, broker, method and environment that never got anywhere
   * (no accounts, no broker identity) are dead ends once a new one starts.
   * @param {string} wid @param {string} brokerId @param {string} method @param {string} environment
   */
  async function dropAbandoned(wid, brokerId, method, environment) {
    const rows = await store.listConnections({ workspace_id: wid, broker_id: brokerId, method, environment, status: ["in", ["pending", "expired", "error"]] });
    for (const c of rows) {
      if (c.external_ref) continue;
      if ((await store.listAccounts([c.id])).length > 0) continue;
      await store.deleteConnection(c.id).catch(() => {});
      oauth2.forget(c.id);
      registry.get(c.method)?.forget?.(c.id);
    }
  }

  /**
   * After a failed or expired hand-off the row goes, and then:
   * - a connection that never connected goes too ("removed");
   * - a Reconnect started while the session still worked (the connection is still active) keeps
   *   working on the tokens it has ("kept"). `restore` puts back the secret a failed exchange
   *   replaced. Tokens of another login can sit in the secret only when the exchange ran and named a
   *   login other than the connection's (or the step died mid-exchange): then it expires as below;
   * - any other connection that had connected before keeps its accounts, loses any unclaimed tokens
   *   and becomes expired with `detail` ("expired").
   * @param {string} connectionId
   * @param {string} detail
   * @param {{ restore?: object, pending?: import("./db.mjs").PendingRow | null, foreign?: boolean }} [o]
   *   pending: the hand-off row when the caller already took it (a claim); foreign: whether the
   *   secret may hold another login's tokens, when the caller knows (otherwise read from the row).
   * @returns {Promise<"none" | "removed" | "kept" | "expired">}
   */
  async function abandon(connectionId, detail, o = {}) {
    const removed = await store.deletePending(connectionId).catch(() => null);
    const conn = await store.getConnection(connectionId).catch(() => null);
    if (!conn || conn.status === "disconnected") return "none";
    cache.invalidate(conn.id);
    if (conn.status === "active") {
      if (o.restore) {
        await oauth2.saveSecret(conn.id, o.restore).catch((e) => log.warn("previous tokens not restored", { connectionId: conn.id, error: e }));
        return "kept";
      }
      const p = o.pending ?? removed;
      const foreign = o.foreign ?? (!!p && (p.stage === "exchanging" || (p.stage === "claim" && p.external_ref !== conn.external_ref)));
      if (!foreign) return "kept";
    }
    const fresh = !conn.external_ref && (await store.listAccounts([conn.id])).length === 0;
    if (fresh) {
      await store.deleteConnection(conn.id).catch(() => {});
      oauth2.forget(conn.id);
      registry.get(conn.method)?.forget?.(conn.id);
      return "removed";
    }
    if (conn.method !== "snaptrade") await oauth2.dropTokens(conn.id).catch(() => {});
    await store.updateConnectionIf(conn.id, ["pending", "active"], { status: "expired", status_detail: detail }).catch(() => {});
    return "expired";
  }

  /**
   * A Reconnect must come back with the login the connection holds (connectKey refuses the same
   * with other_account). A login named by a hash of its account list ("h:", loginRef in oauth2.mjs)
   * changes when that list changes, so it may move on, but never onto another connection's login.
   * @param {ConnectionRow} conn
   * @param {string} ref the login the broker just named
   */
  async function checkSameLogin(conn, ref) {
    if (!conn.external_ref || conn.external_ref === ref) return;
    const name = nameOf(conn.broker_id);
    if (!conn.external_ref.startsWith("h:")) {
      throw conflict(
        `You logged in to a different ${name} login than the one this connection holds. Reconnect with that login, or connect the other one from Brokers as a new connection.`,
        "other_account",
      );
    }
    const dup = await store.findConnectionByRef({ workspaceId: conn.workspace_id, brokerId: conn.broker_id, environment: conn.environment, externalRef: ref });
    if (dup && dup.id !== conn.id) {
      throw conflict(`This ${name} login is already connected in this workspace as another connection. Reconnect that connection instead.`, "other_connection");
    }
  }

  /** The OAuth client a stored connection uses (null for methods without one). @param {ConnectionRow} conn */
  async function clientOfConnection(conn) {
    if (conn.method === "snaptrade" || !METHODS[conn.method]?.variants.some((v) => v.client !== null)) return null;
    const secret = await oauth2.loadSecret(conn.id).catch(() => null);
    return secret?.client === "user" ? "user" : "platform";
  }

  /**
   * When the session of an OAuth connection ends (Schwab 7 days, Tradier 24 h without refresh).
   * @param {BrokerAdapter} adapter @param {ConnectionRow} conn
   */
  async function sessionEnd(adapter, conn) {
    if (conn.method === "snaptrade" || !adapter.oauthProfile) return null;
    const secret = await oauth2.loadSecret(conn.id, { fresh: true });
    if (!secret) return null;
    return oauth2.sessionExpiry(adapter.oauthProfile(conn.environment, secret.client), secret);
  }

  /**
   * Loads the broker's account list into broker_accounts (new ones included, the user's choices
   * kept, accounts the broker no longer lists removed). On failure the connection stays active with
   * the "account list not sent yet" detail, and reads try again (lazyAccounts).
   * @param {BrokerAdapter} adapter
   * @param {ConnectionRow} row
   * @param {{ rethrow?: boolean }} [o]
   */
  async function syncAccounts(adapter, row, o = {}) {
    if (typeof adapter.listAccounts !== "function") return false;
    const name = nameOf(row.broker_id);
    try {
      const list = await adapter.listAccounts(row);
      const rows = list.map((a) => ({ ...a, connection_id: row.id, workspace_id: row.workspace_id, broker_id: row.broker_id }));
      await store.upsertAccounts(rows);
      await store.pruneAccounts(
        row.id,
        rows.map((r) => r.external_id),
      );
      if (row.status_detail === FLOW_DETAIL.accountsLater(name)) await store.updateConnectionIf(row.id, ["active"], { status_detail: null });
      return true;
    } catch (e) {
      if (o.rethrow) throw e;
      log.warn("account list failed after connecting", { connectionId: row.id, error: e });
      await store.updateConnectionIf(row.id, ["active"], { status_detail: FLOW_DETAIL.accountsLater(name) }).catch(() => {});
      return false;
    }
  }

  /**
   * Makes a finished login the workspace's connection for that broker login. When another live
   * connection of the workspace already has the same external_ref, the tokens move onto it (its
   * Included switches survive) and the new row is deleted. That row may have been connected
   * another way (an Alpaca key, then Alpaca Connect): it moves to this login's method and its
   * secret is replaced whole, so a row never holds another method's secret. Its hand-off row (a
   * Reconnect left open in another tab) goes too, or the sweep would expire the login just merged.
   * A Reconnect never merges: checkSameLogin refused that at the callback.
   * @param {BrokerAdapter} adapter
   * @param {ConnectionRow} conn
   * @param {string | null} ref
   */
  async function activate(adapter, conn, ref) {
    /** @type {Partial<ConnectionRow>} */
    const patch = { status: "active", status_detail: null, session_expires_at: await sessionEnd(adapter, conn), last_ok_at: iso(now()) };
    if (ref && ref !== conn.external_ref) {
      const dup = await store.findConnectionByRef({ workspaceId: conn.workspace_id, brokerId: conn.broker_id, environment: conn.environment, externalRef: ref });
      if (dup && dup.id !== conn.id) {
        if (conn.external_ref) {
          throw conflict(`This ${nameOf(conn.broker_id)} login is already connected in this workspace as another connection. Reconnect that connection instead.`, "other_connection");
        }
        return locks.run(dup.id, async () => {
          const moved = dup.method !== conn.method;
          const secret = await oauth2.loadSecret(conn.id, { fresh: true });
          await store.deletePending(dup.id).catch(() => {});
          // Sealed again under the kept row's id (the connection id is the AAD).
          if (secret) await oauth2.saveSecret(dup.id, secret);
          else if (moved) await store.deleteSecret(dup.id).catch(() => {});
          const row = await store.updateConnection(dup.id, {
            ...patch,
            ...(moved
              ? { method: conn.method, scope: conn.scope ?? null, data_as_of: conn.data_as_of ?? null }
              : { ...(conn.scope ? { scope: conn.scope } : {}), ...(conn.data_as_of ? { data_as_of: conn.data_as_of } : {}) }),
          });
          await store.deleteConnection(conn.id);
          oauth2.forget(conn.id);
          if (!secret) oauth2.forget(dup.id);
          adapter.forget?.(conn.id);
          adapter.forget?.(dup.id);
          if (moved) registry.get(dup.method)?.forget?.(dup.id);
          cache.invalidate(dup.id);
          cache.invalidate(conn.id);
          log.info("login already connected; merged into the existing connection", {
            connectionId: dup.id,
            merged: conn.id,
            ...(moved ? { from: dup.method, to: conn.method } : {}),
          });
          return row ?? dup;
        });
      }
    }
    const row = await store.updateConnection(conn.id, { ...patch, ...(ref ? { external_ref: ref } : {}) });
    if (!row) throw gone("This connection was removed while it was being finished. Connect again.", "removed");
    return row;
  }

  /**
   * The refusal for a connection whose environment this server no longer offers (TradeStation SIM
   * with TRADESTATION_ALLOW_SIM off, a Tradier Paper token without TRADIER_SANDBOX_TOKENS): the
   * adapter's own sentence when its OAuth profile refuses the environment, else a generic one.
   * Always 409, so the app shows it as a state of the connection rather than a bad request.
   * @param {BrokerAdapter} adapter @param {ConnectionRow} conn @param {"user" | "platform" | null} client
   */
  function environmentOff(adapter, conn, client) {
    if (adapter.oauthProfile) {
      try {
        adapter.oauthProfile(conn.environment, client ?? "platform");
      } catch (e) {
        if (e instanceof HttpError) return conflict(e.message, e.code);
      }
    }
    const kind = conn.environment === "production" ? "Live" : conn.environment === "paper" ? "Paper" : "Sandbox";
    return conflict(`${nameOf(conn.broker_id)} ${kind} connections are not offered on this server. Disconnect this connection.`, "environment_off");
  }

  /**
   * Renew for adapters without their own. Without a login binding: refresh, and say what the user
   * does when that is not enough. A connection whose environment the server no longer offers is
   * refused up front (environmentOff): no refresh, no hand-off row, its sentence and tokens kept. With one (the Reconnect button of a redirect flow): always a new
   * broker login, even while the session still works (Schwab's last 48 hours, before TradeStation's
   * 24 h or Webull's 15 days run out), because only a new login moves the end. A connection that
   * still works stays active during that login, so reads go on; the claim moves it to the new
   * tokens, and an unfinished login leaves it as it was (abandon, "kept").
   * Starting a new login (or asking for a new key) passes the BROKER_AUDIENCE gate again, so a
   * method the owner switched off or limited to superadmin cannot be logged into through Reconnect.
   * @param {BrokerAdapter} adapter
   * @param {ConnectionRow} conn
   * @param {{ returnOrigin: string | null, bindingHash: string | null, claims: Claims }} ctx
   * @returns {Promise<{ connection: ConnectionRow, next?: RenewNext }>}
   */
  async function genericRenew(adapter, conn, ctx) {
    const name = nameOf(conn.broker_id);
    const client = await clientOfConnection(conn);
    const flow = registry.flowOf(conn.method, client);
    const redirect = flow === "oauth2_user_app" || flow === "oauth2_platform" || flow === "aggregator_portal";
    const login = redirect && !!ctx.returnOrigin && !!ctx.bindingHash;
    if (!registry.environmentsOf(conn.method).includes(conn.environment)) throw environmentOff(adapter, conn, client);
    let live = false;
    if (conn.status === "active" && typeof adapter.refresh === "function") {
      const r = await adapter.refresh(conn).catch((e) => {
        if (e instanceof SessionExpiredError || e instanceof BrokerAuthError) return "expired";
        throw e;
      });
      live = r === "ok" || r === "skipped";
      if (live) {
        const row = await store.updateConnection(conn.id, { status_detail: null, last_ok_at: iso(now()) });
        if (!login) return { connection: row ?? conn };
      }
    }
    const current = (await store.getConnection(conn.id)) ?? conn;
    if (flow === "api_key") {
      registry.gate(ctx.claims, conn.broker_id, conn.method, client, { audienceOnly: true });
      return { connection: current, next: { kind: "api_key" } };
    }
    if (redirect) {
      if (!login) {
        throw badRequest(`Reconnecting ${name} needs a new login. Press Reconnect on the Brokers page.`, "needs_login");
      }
      registry.gate(ctx.claims, conn.broker_id, conn.method, client, { audienceOnly: true });
      const t = now();
      await store.putPending({
        connection_id: conn.id,
        binding_hash: /** @type {string} */ (ctx.bindingHash),
        return_origin: /** @type {string} */ (ctx.returnOrigin),
        expires_at: /** @type {string} */ (iso(t + loginWindowMs)),
      });
      if (live && current.status === "active") return { connection: current, next: { kind: "redirect" } };
      const row = await store.updateConnection(conn.id, { status: "pending", status_detail: FLOW_DETAIL.pending(name), session_expires_at: iso(t + loginWindowMs) });
      return { connection: row ?? current, next: { kind: "redirect" } };
    }
    throw conflict(`${name} cannot be renewed here. Disconnect it and connect again.`, "no_renew");
  }

  /** The binding nonce the canonical callback sent for a connection. @param {unknown} bindings @param {string} id */
  function bindingFor(bindings, id) {
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return null;
    const entries = Object.entries(bindings);
    if (entries.length > 8) return null;
    const v = /** @type {Record<string, unknown>} */ (bindings)[id];
    return typeof v === "string" && OPAQUE.test(v) ? v : null;
  }

  return {
    FLOW_DETAIL,
    syncAccounts,
    abandon,
    genericRenew,

    /** GET /v1/options. @param {Claims} claims */
    options(claims) {
      return registry.options(claims);
    },

    /**
     * POST /v1/keys/connect { brokerId, method?, environment?, keyId?, secret, connectionId? }.
     * @param {Claims} claims
     * @param {any} body
     */
    async connectKey(claims, body) {
      const wid = requireWorkspace(claims);
      const brokerId = str(body?.brokerId);
      const name = nameOf(brokerId);
      const method = str(body?.method) || registry.methodFor(brokerId, "key");
      if (!method) throw badRequest(`Nasscord does not connect ${name} with a key.`, "unknown_method");
      const opt = registry.gate(claims, brokerId, method, null);
      if (opt.flow !== "api_key") throw badRequest(`Nasscord does not connect ${name} with a key.`, "unknown_method");
      const adapter = /** @type {BrokerAdapter} */ (registry.get(method));
      const secret = str(body?.secret);
      if (!PRINTABLE.test(secret) || secret.length < 8 || secret.length > 512) throw badRequest(`Paste the ${name} secret exactly as ${name} shows it.`, "bad_secret");
      const rawKeyId = str(body?.keyId);
      if (rawKeyId && (!PRINTABLE.test(rawKeyId) || rawKeyId.length < 4 || rawKeyId.length > 256)) {
        throw badRequest(`Paste the ${name} key ID exactly as ${name} shows it.`, "bad_key_id");
      }
      const environment = str(body?.environment) ? pickEnvironment(opt, body.environment) : null;
      /** @type {ConnectionRow | null} */
      let existing = null;
      if (body?.connectionId !== undefined && body?.connectionId !== null && body?.connectionId !== "") {
        existing = await owned(claims, body.connectionId);
        if (existing.method !== method) throw badRequest(`This connection is not a ${name} key connection.`, "wrong_method");
        if (existing.status === "disconnected") throw conflict("This connection was removed. Connect the broker again.", "disconnected");
      }
      throttle(claims, existing ? "connect" : "start");

      return locks.run(`key:${wid}:${brokerId}`, () =>
        audited(
          claims,
          `broker.${brokerId}.connect`,
          existing ? target(existing) : `${brokerId} · ${environment ?? "auto"}`,
          async () => {
            const result = await adapter.connectKey?.({ claims, existing }, { environment, keyId: rawKeyId || null, secret });
            if (!result || typeof result.externalRef !== "string" || !result.externalRef) throw new Error(`${method} connectKey answered no externalRef`);
            if (!opt.environments.includes(result.environment)) {
              throw badRequest(`${name} ${result.environment === "sandbox" ? "sandbox" : result.environment} accounts are not accepted here.`, "bad_environment");
            }
            /** @type {ConnectionRow | null} */
            let into = existing;
            if (existing) {
              if (existing.external_ref && existing.external_ref !== result.externalRef) {
                throw conflict(
                  `This key belongs to a different ${name} account. Paste the key of the account this connection shows, or connect the other account as a new connection.`,
                  "other_account",
                );
              }
              if (existing.environment !== result.environment) {
                throw conflict(`This key is for another ${name} account type than this connection. Connect it as a new connection.`, "other_environment");
              }
            } else {
              into = await store.findConnectionByRef({ workspaceId: wid, brokerId, environment: result.environment, externalRef: result.externalRef });
            }
            /** @type {Partial<ConnectionRow>} */
            const patch = {
              status: "active",
              status_detail: null,
              external_ref: result.externalRef,
              scope: result.scope ?? null,
              session_expires_at: result.sessionExpiresAt ?? null,
              last_ok_at: iso(now()),
            };
            /** @type {ConnectionRow | null} */
            let row;
            if (into) {
              const { id, method: was } = into;
              // The same login connected another way before (Alpaca Connect, then a key): the row
              // moves to this method and its secret is replaced whole (activate does the same), and
              // the hand-off row of a Reconnect left open goes.
              const moved = was !== method;
              row = await locks.run(id, async () => {
                await store.deletePending(id).catch(() => {});
                await oauth2.saveSecret(id, result.secret);
                adapter.forget?.(id);
                if (moved) registry.get(was)?.forget?.(id);
                return store.updateConnection(id, moved ? { ...patch, method: /** @type {any} */ (method), data_as_of: null } : patch);
              });
              if (!row) throw gone("This connection was removed. Connect the broker again.", "removed");
            } else {
              const id = randomUUID();
              row = await store.insertConnection({ id, workspace_id: wid, user_id: claims.sub, broker_id: brokerId, method, environment: result.environment, ...patch });
              try {
                await oauth2.saveSecret(id, result.secret);
              } catch (e) {
                await store.deleteConnection(id).catch(() => {});
                oauth2.forget(id);
                throw e;
              }
            }
            const live = /** @type {ConnectionRow} */ (row);
            const accounts = result.accounts.map((a) => ({ ...a, connection_id: live.id, workspace_id: wid, broker_id: /** @type {any} */ (brokerId) }));
            await store.upsertAccounts(accounts);
            await store.pruneAccounts(
              live.id,
              accounts.map((a) => a.external_id),
            );
            cache.invalidate(live.id);
            return { connection: await view(live) };
          },
          { method },
        ),
      );
    },

    /**
     * POST /v1/oauth/start { brokerId, method?, client?, environment?, clientId?, clientSecret?,
     * returnOrigin, bindingHash } -> { connectionId }. The app then opens the canonical hop.
     * @param {Claims} claims
     * @param {any} body
     */
    async startOAuth(claims, body) {
      const wid = requireWorkspace(claims);
      const brokerId = str(body?.brokerId);
      const name = nameOf(brokerId);
      const method = str(body?.method) || registry.methodFor(brokerId, "oauth");
      if (!method) throw badRequest(`Nasscord does not connect ${name} with a login.`, "unknown_method");
      const clientId = str(body?.clientId);
      const clientSecret = str(body?.clientSecret);
      /** @type {"user" | "platform"} */
      const client = body?.client === "user" || body?.client === "platform" ? body.client : clientId ? "user" : "platform";
      const opt = registry.gate(claims, brokerId, method, client);
      if (opt.flow !== "oauth2_user_app" && opt.flow !== "oauth2_platform") throw badRequest(`Nasscord does not connect ${name} with a login.`, "unknown_method");
      const environment = pickEnvironment(opt, body?.environment);
      const returnOrigin = originOf(body?.returnOrigin);
      const bindingHash = hashOf(body?.bindingHash);
      if (client === "user") {
        if (!PRINTABLE.test(clientId) || clientId.length < 4 || clientId.length > 512) throw badRequest(`Paste the ${name} app key exactly as ${name} shows it.`, "bad_client_id");
        if (!PRINTABLE.test(clientSecret) || clientSecret.length < 4 || clientSecret.length > 512) throw badRequest(`Paste the ${name} app secret exactly as ${name} shows it.`, "bad_client_secret");
        // The adapter's own format check (TradeStation refuses legacy keys), before any row is written.
        registry.get(method)?.checkClient?.({ clientId, clientSecret });
      }
      throttle(claims, "start");
      return locks.run(`oauth-start:${wid}:${brokerId}`, () =>
        audited(
          claims,
          `broker.${brokerId}.start`,
          `${brokerId} · ${environment}`,
          async () => {
            await dropAbandoned(wid, brokerId, method, environment);
            const id = randomUUID();
            const t = now();
            await store.insertConnection({
              id,
              workspace_id: wid,
              user_id: claims.sub,
              broker_id: brokerId,
              method,
              environment,
              status: "pending",
              status_detail: FLOW_DETAIL.pending(name),
              session_expires_at: iso(t + loginWindowMs),
            });
            try {
              await oauth2.saveSecret(id, { client, ...(client === "user" ? { clientId, clientSecret } : {}), redirectUri: opt.callbackUrl });
              await store.putPending({ connection_id: id, binding_hash: bindingHash, return_origin: returnOrigin, expires_at: /** @type {string} */ (iso(t + loginWindowMs)) });
            } catch (e) {
              await store.deleteConnection(id).catch(() => {});
              oauth2.forget(id);
              throw e;
            }
            return { connectionId: id };
          },
          { method, client },
        ),
      );
    },

    /**
     * POST /v1/aggregator/start { brokerId, returnOrigin, bindingHash } -> { connectionId }.
     * @param {Claims} claims
     * @param {any} body
     */
    async startAggregator(claims, body) {
      const wid = requireWorkspace(claims);
      const brokerId = str(body?.brokerId);
      const name = nameOf(brokerId);
      const method = registry.methodFor(brokerId, "aggregator");
      if (!method) throw badRequest(`Nasscord does not connect ${name} through an aggregator.`, "unknown_method");
      const opt = registry.gate(claims, brokerId, method, null);
      const environment = pickEnvironment(opt, body?.environment);
      const returnOrigin = originOf(body?.returnOrigin);
      const bindingHash = hashOf(body?.bindingHash);
      throttle(claims, "start");
      return locks.run(`aggregator-start:${wid}:${brokerId}`, () =>
        audited(claims, `broker.${brokerId}.start`, `${brokerId} · ${environment}`, async () => {
          await dropAbandoned(wid, brokerId, method, environment);
          const id = randomUUID();
          const t = now();
          await store.insertConnection({
            id,
            workspace_id: wid,
            user_id: claims.sub,
            broker_id: brokerId,
            method,
            environment,
            status: "pending",
            status_detail: FLOW_DETAIL.pending(name),
            session_expires_at: iso(t + loginWindowMs),
          });
          try {
            await store.putPending({ connection_id: id, binding_hash: bindingHash, return_origin: returnOrigin, expires_at: /** @type {string} */ (iso(t + loginWindowMs)) });
          } catch (e) {
            await store.deleteConnection(id).catch(() => {});
            throw e;
          }
          return { connectionId: id };
        }, { method }),
      );
    },

    /**
     * POST /v1/connect/hop { connectionId, binding, repeat?, preview? } (canonical host, no user
     * session) -> { redirectUrl, brokerId, workspaceName, requestedBy }.
     * `preview: true` runs the same checks and answers only the names, for the confirmation page.
     * `repeat: true` only when the canonical host already holds this login's cookie (the user
     * pressed "Open login" again): a new state replaces the old one.
     * @param {any} body
     */
    async hop(body) {
      const id = uuidOf(body?.connectionId);
      const binding = opaqueOf(body?.binding, "binding");
      const pending = await store.getPending(id);
      if (!pending) throw gone(LINK_EXPIRED, "login_expired");
      if ((parseTime(pending.expires_at) ?? 0) <= now()) {
        await abandon(id, FLOW_DETAIL.loginTimeout);
        throw gone("This login link expired. Logins must be finished within 10 minutes. Start again from Brokers.", "login_expired");
      }
      if (!hashMatches(binding, pending.binding_hash)) throw forbidden(OTHER_BROWSER, "binding");
      /** @type {import("./db.mjs").PendingStage[]} */
      const from = body?.repeat === true ? ["start", "authorize"] : ["start"];
      if (!from.includes(pending.stage)) throw conflict("This login link was already opened. Go back to Nasscord and press Connect again.", "hop_used");
      const conn = await store.getConnection(id);
      if (!conn || conn.status === "disconnected") throw gone(LINK_EXPIRED, "login_expired");
      /** Who asked, for the confirmation page. */
      const who = async () => {
        const [workspaceName, email] = await Promise.all([store.workspaceName(conn.workspace_id).catch(() => null), store.memberEmail(conn.user_id).catch(() => null)]);
        return { brokerId: conn.broker_id, workspaceName, requestedBy: maskEmail(email) };
      };
      // The confirmation page: the same checks, nothing used up, no broker URL.
      if (body?.preview === true) return who();
      const adapter = registry.adapterFor(conn);
      const used = () => conflict("This login link was already opened. Go back to Nasscord and press Connect again.", "hop_used");
      // The row moves to "authorize" first (one atomic UPDATE, so two hops cannot both win). When
      // building the broker's URL then fails (the portal link, the PKCE save, a non-https address),
      // it goes back to where it was: the browser never got the canonical cookie, so without this
      // every retry would be refused as "already opened".
      const rollback = () =>
        store.advancePending({ connection_id: id }, ["authorize"], { stage: pending.stage, state_hash: pending.state_hash ?? null }).catch((e) => {
          log.warn("login hand-off not put back after a failed hop", { connectionId: id, error: e });
          return null;
        });

      /** @type {string} */
      let redirectUrl;
      if (conn.method === "snaptrade") {
        const back = registry.callbackUrl("snaptrade");
        if (!back || !adapter.portalUrl) throw gone(LINK_EXPIRED, "login_expired");
        const moved = await store.advancePending({ connection_id: id }, from, { stage: "authorize" });
        if (!moved) throw used();
        try {
          redirectUrl = await adapter.portalUrl({ connection: conn, brokerId: conn.broker_id, redirectUrl: `${back}?cid=${id}`, reconnect: conn.external_ref ?? null });
          if (config.production && !redirectUrl.startsWith("https://")) throw new HttpError(502, `${nameOf(conn.broker_id)} login page address is not https.`, { code: "not_https" });
        } catch (e) {
          await rollback();
          throw e;
        }
      } else {
        const secret = await oauth2.loadSecret(id, { fresh: true });
        if (!secret || !adapter.oauthProfile) throw gone(LINK_EXPIRED, "login_expired");
        const profile = adapter.oauthProfile(conn.environment, secret.client);
        const state = randomToken();
        const moved = await store.advancePending({ connection_id: id }, from, { stage: "authorize", state_hash: sha256Hex(state) });
        if (!moved) throw used();
        try {
          redirectUrl = await oauth2.authorizeUrl(id, profile, secret, state);
          if (config.production && !redirectUrl.startsWith("https://")) throw new HttpError(502, `${nameOf(conn.broker_id)} login page address is not https.`, { code: "not_https" });
        } catch (e) {
          await rollback();
          throw e;
        }
      }
      void audit.record({ actor: ownerOf(conn), action: `broker.${conn.broker_id}.login_opened`, target: target(conn) });
      return { redirectUrl, ...(await who()) };
    },

    /**
     * POST /v1/oauth/complete { brokerId, state, code?, error?, bindings: { <connectionId>: nonce } }
     * (canonical callback, no user session) -> { connectionId, returnOrigin, ticket }.
     * `bindings` is every ns_oauth_<id> cookie the canonical host holds; the state picks the one.
     * @param {any} body
     */
    async completeOAuth(body) {
      const brokerId = str(body?.brokerId);
      const state = opaqueOf(body?.state, "state");
      // Single use: one atomic UPDATE takes the row and clears the state.
      const pending = await store.advancePending({ state_hash: sha256Hex(state) }, ["authorize"], { stage: "exchanging", state_hash: null });
      if (!pending) throw gone(LINK_EXPIRED, "state_unknown");
      const id = pending.connection_id;
      /** Refused before any code exchange: the secret holds nothing new. @param {HttpError} err @param {string} detail @returns {Promise<never>} */
      const fail = async (err, detail) => {
        await abandon(id, detail, { foreign: false });
        throw err;
      };
      const conn = await store.getConnection(id);
      if (!conn || conn.status === "disconnected") return fail(gone(LINK_EXPIRED, "login_expired"), FLOW_DETAIL.loginTimeout);
      const name = nameOf(conn.broker_id);
      if (conn.broker_id !== brokerId || conn.method === "snaptrade") {
        return fail(badRequest("This login came back to the wrong address. Start again from Brokers.", "wrong_broker"), FLOW_DETAIL.otherBrowser);
      }
      if ((parseTime(pending.expires_at) ?? 0) <= now()) {
        return fail(gone("This login took longer than 10 minutes. Start again from Brokers.", "login_expired"), FLOW_DETAIL.loginTimeout);
      }
      const binding = bindingFor(body?.bindings, id);
      if (!binding || !hashMatches(binding, pending.binding_hash)) return fail(forbidden(OTHER_BROWSER, "binding"), FLOW_DETAIL.otherBrowser);
      if (str(body?.error)) {
        return fail(badRequest(`${name} did not grant access: the login was cancelled or refused. Start again from Brokers.`, "oauth_denied"), FLOW_DETAIL.denied(name));
      }
      const code = str(body?.code);
      if (!PRINTABLE.test(code) || code.length > 2048) return fail(badRequest(`${name} sent no login code. Start again from Brokers.`, "no_code"), FLOW_DETAIL.loginTimeout);
      const adapter = registry.adapterFor(conn);

      return locks.run(id, () =>
        audited(ownerOf(conn), `broker.${conn.broker_id}.authorize`, target(conn), async () => {
          // A Reconnect started while the session still worked: the connection stays active, and a
          // login that fails after the exchange puts the previous secret back (abandon, restore).
          const current = (await store.getConnection(id)) ?? conn;
          const live = current.status === "active";
          /** @type {import("./oauth2.mjs").OAuthSecret | null} */
          let before = null;
          let exchanged = false;
          try {
            const secret = await oauth2.loadSecret(id, { fresh: true });
            if (!secret || !adapter.oauthProfile) throw gone(LINK_EXPIRED, "login_expired");
            before = secret;
            const profile = adapter.oauthProfile(current.environment, secret.client);
            const { secret: saved, tokens } = await oauth2.exchange(id, profile, secret, code);
            exchanged = true;
            const identity = adapter.identify ? await adapter.identify(current, tokens, saved) : {};
            // Every login is named, so the same broker login is never connected twice (one-login index).
            if (typeof identity.externalRef !== "string" || !identity.externalRef.trim()) throw new Error(`${current.method} identify() named no login (externalRef)`);
            const ref = identity.externalRef.slice(0, 200);
            await checkSameLogin(current, ref);
            if (identity.extra) await oauth2.saveSecret(id, { ...saved, extra: { ...(saved.extra ?? {}), ...identity.extra } });
            const scope = identity.scope ?? tokens.scope ?? null;
            const ticket = randomToken();
            const moved = await store.advancePending({ connection_id: id }, ["exchanging"], {
              stage: "claim",
              ticket_hash: sha256Hex(ticket),
              external_ref: ref,
              expires_at: /** @type {string} */ (iso(now() + config.oauth.claimWindowMs)),
            });
            if (!moved) throw gone(LINK_EXPIRED, "login_expired");
            await store.updateConnection(id, {
              // A live connection already reads with the new tokens (the same login): its end moves now.
              ...(live ? { session_expires_at: await sessionEnd(adapter, current) } : { status_detail: FLOW_DETAIL.finishing(name) }),
              ...(scope ? { scope: scope.slice(0, 200) } : {}),
            });
            return { connectionId: id, returnOrigin: pending.return_origin, ticket };
          } catch (e) {
            const detail = e instanceof HttpError && e.status < 500 ? e.message : "The login could not be finished. Start again.";
            if (live && exchanged && before) {
              const restore = { ...before };
              delete restore.pkceVerifier;
              await abandon(id, detail, { restore });
            } else {
              await abandon(id, detail, { foreign: exchanged });
            }
            throw e;
          }
        }),
      );
    },

    /**
     * POST /v1/aggregator/complete { connectionId, status, authorizationId?, binding } (canonical
     * callback, no user session) -> { connectionId, returnOrigin, ticket }.
     * @param {any} body
     */
    async completeAggregator(body) {
      const id = uuidOf(body?.connectionId);
      const binding = opaqueOf(body?.binding, "binding");
      const pending = await store.advancePending({ connection_id: id }, ["authorize"], { stage: "exchanging" });
      if (!pending) throw gone(LINK_EXPIRED, "login_expired");
      const authorizationId = str(body?.authorizationId);
      const validAuthorization = /^[A-Za-z0-9_-]{1,200}$/.test(authorizationId);
      // When this login started: the adapter takes only a connection the aggregator made since (D1).
      const startedAt = parseTime(pending.created_at) ?? (parseTime(pending.expires_at) ?? now()) - config.oauth.loginWindowMs;
      /**
       * A refused login leaves no connection behind at the aggregator: the one its portal made is
       * deleted, so a forwarded portal link cannot leave a victim's login under the starter's user.
       * Best effort; the sweep removes what is missed. @param {ConnectionRow} c
       */
      const dropRefused = async (c) => {
        if (!validAuthorization) return;
        const a = registry.adapterFor(c);
        if (!a.aggregatorRefused) return;
        await a.aggregatorRefused(c, { authorizationId, startedAt }).catch((e) => log.warn("connection of a refused aggregator login not removed", { connectionId: id, error: e }));
      };
      /**
       * SnapTrade keeps no per-connection secret, so nothing of another login is left behind.
       * @param {HttpError} err @param {string} detail @param {ConnectionRow} [c] @returns {Promise<never>}
       */
      const fail = async (err, detail, c) => {
        if (c) await dropRefused(c);
        await abandon(id, detail, { foreign: false });
        throw err;
      };
      const conn = await store.getConnection(id);
      if (!conn || conn.status === "disconnected" || conn.method !== "snaptrade") return fail(gone(LINK_EXPIRED, "login_expired"), FLOW_DETAIL.loginTimeout);
      const name = nameOf(conn.broker_id);
      if ((parseTime(pending.expires_at) ?? 0) <= now()) {
        return fail(gone("This login took longer than 10 minutes. Start again from Brokers.", "login_expired"), FLOW_DETAIL.loginTimeout, conn);
      }
      if (!hashMatches(binding, pending.binding_hash)) return fail(forbidden(OTHER_BROWSER, "binding"), FLOW_DETAIL.otherBrowser, conn);
      const status = str(body?.status).toUpperCase();
      if (status !== "SUCCESS") {
        const msg =
          status === "ABANDONED"
            ? `The ${name} login was closed before it finished. Start again from Brokers.`
            : `${name} did not finish the login. Start again from Brokers.`;
        return fail(badRequest(msg, "aggregator_not_finished"), FLOW_DETAIL.denied(name), conn);
      }
      if (!validAuthorization) return fail(badRequest(`${name} sent no connection id. Start again from Brokers.`, "no_authorization"), FLOW_DETAIL.loginTimeout);
      const adapter = registry.adapterFor(conn);

      return locks.run(id, () =>
        audited(ownerOf(conn), `broker.${conn.broker_id}.authorize`, target(conn), async () => {
          try {
            if (!adapter.aggregatorComplete) throw gone(LINK_EXPIRED, "login_expired");
            const current = (await store.getConnection(id)) ?? conn;
            const identity = await adapter.aggregatorComplete(current, { authorizationId, startedAt });
            // The same contract as identify(): the login must be named (the one-login index).
            if (typeof identity?.externalRef !== "string" || !identity.externalRef.trim()) throw new Error(`${current.method} aggregatorComplete() named no login (externalRef)`);
            const ref = identity.externalRef.slice(0, 200);
            await checkSameLogin(current, ref);
            const ticket = randomToken();
            const moved = await store.advancePending({ connection_id: id }, ["exchanging"], {
              stage: "claim",
              ticket_hash: sha256Hex(ticket),
              external_ref: ref,
              expires_at: /** @type {string} */ (iso(now() + config.oauth.claimWindowMs)),
            });
            if (!moved) throw gone(LINK_EXPIRED, "login_expired");
            await store.updateConnection(id, {
              ...(current.status === "active" ? {} : { status_detail: FLOW_DETAIL.finishing(name) }),
              ...(identity.dataAsOf ? { data_as_of: identity.dataAsOf } : {}),
            });
            return { connectionId: id, returnOrigin: pending.return_origin, ticket };
          } catch (e) {
            await abandon(id, e instanceof HttpError && e.status < 500 ? e.message : "The login could not be finished. Start again.", { foreign: false });
            throw e;
          }
        }),
      );
    },

    /**
     * POST /v1/connect/claim { connectionId, ticket, binding } (the user's own host, the user's own
     * service JWT) -> { connection }.
     * @param {Claims} claims
     * @param {any} body
     */
    async claim(claims, body) {
      const conn = await owned(claims, body?.connectionId);
      const ticket = opaqueOf(body?.ticket, "ticket");
      const binding = opaqueOf(body?.binding, "binding");
      if (conn.user_id !== claims.sub) throw forbidden("Finish this login as the person who started it.", "other_user");
      throttle(claims, "verify");
      const adapter = registry.adapterFor(conn);
      return locks.run(conn.id, () =>
        audited(
          claims,
          `broker.${conn.broker_id}.connect`,
          target(conn),
          async () => {
            const pending = await store.takePendingClaim(conn.id, sha256Hex(ticket));
            if (!pending) throw gone("This connection link expired or was already used. Start again from Brokers.", "ticket_unknown");
            if ((parseTime(pending.expires_at) ?? 0) <= now()) {
              await abandon(conn.id, FLOW_DETAIL.claimTimeout, { pending });
              throw gone("This connection link expired. Start again from Brokers.", "ticket_expired");
            }
            if (!hashMatches(binding, pending.binding_hash)) {
              await abandon(conn.id, FLOW_DETAIL.otherBrowser, { pending });
              throw forbidden(OTHER_BROWSER, "binding");
            }
            const fresh = (await store.getConnection(conn.id)) ?? conn;
            /** @type {ConnectionRow} */
            let row;
            try {
              row = await activate(adapter, fresh, pending.external_ref);
            } catch (e) {
              await abandon(conn.id, e instanceof HttpError && e.status < 500 ? e.message : "The login could not be finished. Start again.", { pending });
              throw e;
            }
            await syncAccounts(adapter, row);
            row = (await store.getConnection(row.id)) ?? row;
            cache.invalidate(row.id);
            return { connection: await view(row) };
          },
          { method: conn.method },
        ),
      );
    },

    /**
     * POST /v1/connections/:id/renew { returnOrigin?, bindingHash? } -> { connection, next?, loginUrl? }.
     * @param {Claims} claims
     * @param {string} id
     * @param {any} body
     */
    async renew(claims, id, body) {
      const row = await owned(claims, id);
      if (row.status === "disconnected") throw conflict("This connection was removed. Connect the broker again.", "disconnected");
      if (config.production && row.environment === "sandbox") {
        throw badRequest(`This ${nameOf(row.broker_id)} sandbox connection holds sample data, which this server does not serve. Disconnect it.`, "sandbox_refused");
      }
      const returnOrigin = body?.returnOrigin ? originOf(body.returnOrigin) : null;
      const bindingHash = body?.bindingHash ? hashOf(body.bindingHash) : null;
      const adapter = registry.adapterFor(row);
      // An adapter's own renew (IBKR, E*TRADE, SnapTrade) may start a new login (a gateway, a request
      // token, a portal link), so every renew of theirs passes the BROKER_AUDIENCE gate first, as their
      // start routes do (docs/real-backend.md sections 6 and 9). genericRenew gates only when it starts
      // a login or asks for a new key: a plain refresh stays open.
      if (adapter.renew) registry.gate(claims, row.broker_id, row.method, await clientOfConnection(row), { audienceOnly: true });
      throttle(claims, "connect");
      return locks.run(row.id, () =>
        audited(claims, "broker.connection.renew", target(row), async () => {
          const fresh = (await store.getConnection(row.id)) ?? row;
          const out = adapter.renew ? await adapter.renew(fresh, { returnOrigin, bindingHash }) : await genericRenew(adapter, fresh, { returnOrigin, bindingHash, claims });
          cache.invalidate(row.id);
          /** @type {{ connection: any, loginUrl?: string, next?: RenewNext }} */
          const res = { connection: await view(out.connection) };
          if ("loginUrl" in out && typeof out.loginUrl === "string" && out.loginUrl) res.loginUrl = out.loginUrl;
          if (out.next) res.next = out.next;
          return res;
        }),
      );
    },
  };
}

/** @typedef {ReturnType<typeof createFlows>} Flows */
