import { badRequest, forbidden, HttpError, notFound, userMessage } from "./errors.mjs";
import { createFlows, FLOW_DETAIL } from "./flows.mjs";
import { createWindowCounter } from "./limits.mjs";
import { createLocks } from "./locks.mjs";
import { connectionView } from "./mapping.mjs";
import { BROKER_NAMES } from "./registry.mjs";

/**
 * What the API routes call. Checks the workspace on every connection id, serialises changes per
 * connection, writes audit events, and fans reads out over the workspace's active connections
 * through the coalescing cache (each adapter's own TTL). Every broker is reached through the
 * registry; the IBKR and E*TRADE start, verify and ticket steps keep their own routes, and the
 * generic connect steps live in flows.mjs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_ROLES = new Set(["superadmin", "trader", "tenant_user"]);
const TEN_MINUTES = 10 * 60_000;

/**
 * Connect steps per user. Every IBKR start or Reconnect can hold a gateway JVM, and every other
 * start sends a call to a broker from this server, so they are counted per user (`sub`) and, for
 * new connections, for the whole process.
 * @typedef {{ connectPerUser: number, connectGlobalPerMin: number, verifyPerUser: number, ticketPerUser: number }} StepLimits
 */
export const DEFAULT_STEP_LIMITS = Object.freeze({ connectPerUser: 20, connectGlobalPerMin: 60, verifyPerUser: 20, ticketPerUser: 60 });
const TOO_MANY_STEPS = "Too many connection attempts from your account. Wait a few minutes and try again.";
const TOO_MANY_STARTS = "Many people are connecting brokers right now. Try again in a minute.";

/**
 * @typedef {import("./jwt.mjs").ServiceClaims} Claims
 * @typedef {import("./db.mjs").ConnectionRow} ConnectionRow
 * @typedef {import("./db.mjs").AccountRow} AccountRow
 * @typedef {import("./adapter-types.mjs").BrokerAdapter} BrokerAdapter
 */

/**
 * @param {{
 *   config: import("./config.mjs").Config,
 *   registry: import("./registry.mjs").Registry,
 *   store: import("./db.mjs").Store,
 *   oauth2: import("./oauth2.mjs").OAuth2Engine,
 *   etrade: import("./etrade/adapter.mjs").EtradeAdapter,
 *   ibkr: import("./ibkr/adapter.mjs").IbkrAdapter,
 *   sessions: import("./ibkr/session.mjs").IbkrSessions,
 *   manager: import("./ibkr/gateway-manager.mjs").GatewayManager,
 *   audit: import("./audit.mjs").Audit,
 *   cache: import("./cache.mjs").CoalescingCache,
 *   limiter: import("./limits.mjs").Limiter,
 *   log: import("./log.mjs").Logger,
 *   locks?: import("./locks.mjs").Locks,
 *   steps?: import("./limits.mjs").WindowCounter,
 *   stepLimits?: Partial<StepLimits>,
 *   now?: () => number,
 * }} deps
 */
export function createConnectionService(deps) {
  const { config, registry, store, oauth2, etrade, ibkr, sessions, manager, audit, cache, limiter, log } = deps;
  // Shared with the adapters, the keepalive and the scheduler: one change at a time per
  // connection (double clicks, two tabs, a gateway restart, a slot release, a token refresh sweep).
  const locks = deps.locks ?? createLocks();
  const withLock = locks.run;
  const steps = deps.steps ?? createWindowCounter();
  const stepLimits = { ...DEFAULT_STEP_LIMITS, ...(deps.stepLimits ?? {}) };

  /**
   * Counts one connect step of the caller, or throws a 429. Checked before the step is audited, so
   * a flood of refused attempts does not flood audit_events as well.
   * @param {Claims} claims
   * @param {"connect" | "start" | "verify" | "ticket"} kind start = a new connection (also counted as connect)
   */
  function throttle(claims, kind) {
    const who = String(claims.sub);
    if (kind === "verify") {
      steps.take(`verify:${who}`, stepLimits.verifyPerUser, TEN_MINUTES, TOO_MANY_STEPS);
    } else if (kind === "ticket") {
      steps.take(`ticket:${who}`, stepLimits.ticketPerUser, TEN_MINUTES, TOO_MANY_STEPS);
    } else {
      steps.take(`connect:${who}`, stepLimits.connectPerUser, TEN_MINUTES, TOO_MANY_STEPS);
      if (kind === "start") steps.take("start:*", stepLimits.connectGlobalPerMin, 60_000, TOO_MANY_STARTS);
    }
  }

  /** @param {Claims} claims */
  function requireWorkspace(claims) {
    if (!TERMINAL_ROLES.has(claims.role)) throw forbidden("Broker connections belong to a trading workspace.");
    if (!claims.wid) throw forbidden("Finish creating your workspace before connecting a broker.", "no_workspace");
    return claims.wid;
  }

  /**
   * Loads a connection and checks it belongs to the caller's workspace. A connection in another
   * workspace looks exactly like one that does not exist.
   * @param {Claims} claims
   * @param {unknown} id
   */
  async function owned(claims, id) {
    const wid = requireWorkspace(claims);
    if (typeof id !== "string" || !UUID.test(id)) throw notFound();
    const row = await store.getConnection(id.toLowerCase());
    if (!row || row.workspace_id !== wid) throw notFound();
    return row;
  }

  /** @param {ConnectionRow} row */
  async function view(row) {
    return connectionView(row, await store.listAccounts([row.id]));
  }

  /** @param {ConnectionRow} c */
  const target = (c) => `${c.broker_id} · ${c.environment} · ${c.id}`;

  /**
   * Runs `fn`, auditing the outcome either way.
   * @template T
   * @param {Claims} claims
   * @param {string} action
   * @param {string} targetText
   * @param {() => Promise<T>} fn
   * @param {Record<string, unknown>} [meta]
   */
  async function audited(claims, action, targetText, fn, meta) {
    try {
      const out = await fn();
      void audit.record({ actor: claims, action, target: targetText, meta });
      return out;
    } catch (e) {
      const denied = e instanceof HttpError && e.status < 500 && e.status !== 429;
      void audit.record({
        actor: claims,
        action,
        target: targetText,
        result: denied ? "denied" : "error",
        meta: { ...(meta ?? {}), reason: e instanceof HttpError ? e.code : "internal" },
      });
      throw e;
    }
  }

  const flows = createFlows({
    config,
    registry,
    store,
    oauth2,
    audit,
    cache,
    locks,
    log,
    now: deps.now,
    helpers: { requireWorkspace, owned, audited, throttle, view, target },
  });

  /** @param {ConnectionRow} c */
  const adapterOf = (c) => registry.adapterFor(c);

  /**
   * Whether reads load the account list of a connection first: its adapter loads them lazily, or
   * the list failed right after connecting ("it loads on the next refresh", flows.syncAccounts),
   * whatever the adapter declares.
   * @param {ConnectionRow} c
   */
  const loadsAccounts = (c) => !!registry.get(c.method)?.descriptor.lazyAccounts || c.status_detail === FLOW_DETAIL.accountsLater(BROKER_NAMES[c.broker_id] ?? c.broker_id);

  /**
   * Active connections of the workspace with their included accounts. A connection without
   * accounts stays in when its accounts are loaded on read (loadsAccounts).
   * @param {string} wid
   */
  async function activeWithAccounts(wid) {
    const conns = await store.listConnections({ workspace_id: wid, status: "active" });
    const accounts = await store.listAccounts(conns.map((c) => c.id), { includedOnly: true });
    return conns
      .map((c) => ({ connection: c, accounts: accounts.filter((a) => a.connection_id === c.id) }))
      .filter((x) => x.accounts.length > 0 || loadsAccounts(x.connection));
  }

  /** Sample data never reaches users: a sandbox row left from before is not read in production. */
  const SANDBOX_NOT_READ = "This is a sandbox connection with sample data, which this server does not serve. Disconnect it.";

  /** @param {AccountRow[]} accounts */
  const accountsKey = (accounts) => accounts.map((a) => a.id).sort().join(",");

  /**
   * The account list could not be loaded when the connection was made: load it now. With accounts
   * already stored the reads go ahead even if this fails; the list is tried again next time.
   * @param {BrokerAdapter} adapter
   * @param {ConnectionRow} connection
   * @param {AccountRow[]} included
   */
  async function lazyAccounts(adapter, connection, included) {
    const name = BROKER_NAMES[connection.broker_id] ?? connection.broker_id;
    const pending = adapter.accountsPending ? adapter.accountsPending(connection) : connection.status_detail === FLOW_DETAIL.accountsLater(name);
    if (included.length > 0 && !pending) return included;
    const all = await store.listAccounts([connection.id]);
    if (all.length === 0 || pending) {
      try {
        if (adapter.syncAccounts) await adapter.syncAccounts(connection);
        else await flows.syncAccounts(adapter, connection, { rethrow: true });
      } catch (e) {
        if (all.length === 0) throw e;
        log.info("account list still not available", { connectionId: connection.id, error: e });
      }
    }
    return store.listAccounts([connection.id], { includedOnly: true });
  }

  /**
   * Fans a read out over every active connection; one broker's failure becomes an entry in
   * `errors` instead of failing the whole answer.
   * @template T
   * @param {Claims} claims
   * @param {"portfolio" | "orders" | "executions"} what
   * @param {(adapter: BrokerAdapter, c: ConnectionRow, a: AccountRow[]) => Promise<T>} read
   * @returns {Promise<{ results: T[], errors: Array<{ connectionId: string, message: string }> }>}
   */
  async function fanOut(claims, what, read) {
    const wid = requireWorkspace(claims);
    const items = await activeWithAccounts(wid);
    /** @type {T[]} */
    const results = [];
    /** @type {Array<{ connectionId: string, message: string }>} */
    const errors = [];
    await Promise.all(
      items.map(async ({ connection, accounts }) => {
        if (config.production && connection.environment === "sandbox") {
          errors.push({ connectionId: connection.id, message: SANDBOX_NOT_READ });
          return;
        }
        /** @type {BrokerAdapter} */
        let adapter;
        let accs = accounts;
        try {
          adapter = adapterOf(connection);
          if (loadsAccounts(connection)) accs = await lazyAccounts(adapter, connection, accounts);
        } catch (e) {
          errors.push({ connectionId: connection.id, message: userMessage(e) });
          return;
        }
        if (accs.length === 0) return;
        try {
          const key = `${connection.id}:${what}:${accountsKey(accs)}`;
          results.push(await cache.get(key, () => read(adapter, connection, accs), adapter.descriptor.readTtlMs[what]));
        } catch (e) {
          if (!(e instanceof HttpError)) log.error(`${what} read failed`, { connectionId: connection.id, error: e });
          errors.push({ connectionId: connection.id, message: userMessage(e) });
        }
      }),
    );
    return { results, errors };
  }

  /**
   * Balances and positions of one connection: the adapter's combined call, or its two calls in
   * parallel.
   * @param {BrokerAdapter} adapter @param {ConnectionRow} c @param {AccountRow[]} a
   */
  async function portfolioOf(adapter, c, a) {
    if (adapter.portfolio) return adapter.portfolio(c, a);
    const [b, positions] = await Promise.all([/** @type {NonNullable<BrokerAdapter["balances"]>} */ (adapter.balances)(c, a), /** @type {NonNullable<BrokerAdapter["positions"]>} */ (adapter.positions)(c, a)]);
    return { accounts: b.accounts, positions, errors: b.errors ?? [] };
  }

  return {
    flows,

    /** GET /v1/options. @param {Claims} claims */
    async options(claims) {
      return flows.options(claims);
    },

    connectKey: flows.connectKey,
    startOAuth: flows.startOAuth,
    startAggregator: flows.startAggregator,
    hop: flows.hop,
    completeOAuth: flows.completeOAuth,
    completeAggregator: flows.completeAggregator,
    claim: flows.claim,

    /** @param {Claims} claims @param {any} body */
    async startEtrade(claims, body) {
      requireWorkspace(claims);
      registry.gate(claims, "etrade", "etrade_oauth1", null, { audienceOnly: true });
      throttle(claims, "start");
      const environment = body?.environment;
      return audited(claims, "broker.etrade.start", `etrade · ${String(environment)}`, async () => {
        const { connection, authorizeUrl } = await etrade.start({
          claims,
          environment,
          consumerKey: body?.consumerKey,
          consumerSecret: body?.consumerSecret,
        });
        return { connectionId: connection.id, authorizeUrl };
      });
    },

    /** @param {Claims} claims @param {any} body */
    async verifyEtrade(claims, body) {
      const row = await owned(claims, body?.connectionId);
      if (row.broker_id !== "etrade") throw badRequest("This connection is not an E*TRADE connection.");
      throttle(claims, "verify");
      return withLock(row.id, () =>
        audited(claims, "broker.etrade.verify", target(row), async () => {
          const fresh = (await store.getConnection(row.id)) ?? row;
          const updated = await etrade.verify(fresh, body?.verifier);
          cache.invalidate(row.id);
          return { connection: await view(updated) };
        }),
      );
    },

    /** @param {Claims} claims @param {any} body */
    async startIbkr(claims, body) {
      const wid = requireWorkspace(claims);
      registry.gate(claims, "ibkr", "ibkr_gateway", null, { audienceOnly: true });
      throttle(claims, "start");
      const environment = body?.environment;
      // Serialised per workspace so two quick clicks do not start two gateways.
      return withLock(`ibkr-start:${wid}`, () =>
        audited(claims, "broker.ibkr.start", `ibkr · ${String(environment)}`, async () => {
          const { connection, loginUrl } = await ibkr.start({ claims, environment });
          return { connectionId: connection.id, loginUrl };
        }),
      );
    },

    /**
     * A fresh one-time IBKR login link for a connection of the caller's workspace whose gateway
     * is running. The app asks for it when the user opens the login, instead of handing out the
     * link that start or renew returned.
     * @param {Claims} claims @param {string} id
     */
    async ibkrTicket(claims, id) {
      const row = await owned(claims, id);
      if (row.broker_id !== "ibkr") throw badRequest("This connection is not an IBKR connection.");
      throttle(claims, "ticket");
      return audited(claims, "broker.ibkr.login_link", target(row), async () => ibkr.loginLink(row));
    },

    /** @param {Claims} claims @param {string} id */
    async get(claims, id) {
      let row = await owned(claims, id);
      if (row.broker_id === "ibkr" && (row.status === "pending" || row.status === "active")) {
        sessions.ensure(row.id);
        await sessions.checkNow(row.id);
        row = (await store.getConnection(row.id)) ?? row;
      }
      return { connection: await view(row) };
    },

    /** @param {Claims} claims @param {string} id @param {any} [body] */
    async renew(claims, id, body = {}) {
      return flows.renew(claims, id, body);
    },

    /** @param {Claims} claims @param {string} id */
    async disconnect(claims, id) {
      const row = await owned(claims, id);
      return withLock(row.id, () =>
        audited(claims, "broker.connection.disconnect", target(row), async () => {
          /** @type {BrokerAdapter | null} */
          const adapter = registry.get(row.method);
          try {
            await adapter?.revoke?.(row);
          } catch (e) {
            // The user asked to disconnect: local clean-up goes ahead even if the broker call failed.
            log.warn("broker-side disconnect failed", { connectionId: row.id, error: e });
          }
          await store.deletePending(row.id).catch(() => {});
          await store.deleteSecret(row.id).catch(() => {});
          await store.deleteAccounts(row.id);
          await store.updateConnection(row.id, {
            status: "disconnected",
            status_detail: null,
            session_expires_at: null,
          });
          cache.invalidate(row.id);
          limiter.forget(row.id);
          oauth2.forget(row.id);
          adapter?.forget?.(row.id);
          return { ok: true };
        }),
      );
    },

    /** @param {Claims} claims */
    async portfolio(claims) {
      const { results, errors } = await fanOut(claims, "portfolio", portfolioOf);
      return {
        accounts: results.flatMap((r) => r.accounts),
        positions: results.flatMap((r) => r.positions),
        // a connection that answered for some accounts and not for others reports those here
        errors: [...errors, ...results.flatMap((r) => r.errors ?? [])],
      };
    },

    /** @param {Claims} claims */
    async orders(claims) {
      const { results, errors } = await fanOut(claims, "orders", (adapter, c, a) => adapter.orders(c, a));
      const orders = results.flat().sort((x, y) => (x.placedAt < y.placedAt ? 1 : x.placedAt > y.placedAt ? -1 : 0));
      return { orders, errors };
    },

    /** @param {Claims} claims */
    async executions(claims) {
      const { results, errors } = await fanOut(claims, "executions", (adapter, c, a) => adapter.executions(c, a));
      const executions = results.flat().sort((x, y) => (x.tradedAt < y.tradedAt ? 1 : x.tradedAt > y.tradedAt ? -1 : 0));
      return { executions, errors };
    },

    /** Superadmin view: connection counts for every broker, the built adapters, and gateways. */
    async health() {
      /** @type {Record<string, Record<string, number>>} */
      const connections = {};
      for (const id of Object.keys(BROKER_NAMES)) connections[id] = {};
      for (const r of await store.connectionStatuses()) {
        const b = (connections[r.broker_id] ??= {});
        b[r.status] = (b[r.status] ?? 0) + 1;
      }
      const slots = manager.list().map((s) => ({
        port: s.port,
        connectionId: s.connectionId,
        ready: s.ready,
        authenticated: sessions.isAuthenticated(s.connectionId),
        competing: sessions.state(s.connectionId)?.competing ?? false,
        startedAt: new Date(s.startedAt).toISOString(),
        expiredAt: s.expiredAt ? new Date(s.expiredAt).toISOString() : null,
      }));
      return {
        connections,
        adapters: registry.list().map((a) => a.descriptor.method),
        gateways: { ...manager.stats(), bundle: manager.bundleAvailable(), slots },
      };
    },
  };
}

/** @typedef {ReturnType<typeof createConnectionService>} ConnectionService */
