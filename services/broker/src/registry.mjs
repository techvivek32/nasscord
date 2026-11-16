import { gateKey, SNAPTRADE_BROKER_IDS } from "./config.mjs";
import { forbidden, HttpError, unavailable } from "./errors.mjs";

/**
 * The adapter registry (docs/real-backend.md, "Adapters"): connect methods -> adapters, and who may
 * use which method on this server (GET /v1/options and every connect step).
 *
 * A method is available to a caller when all of these hold:
 * - built: its adapter is registered (a broker package whose index.mjs still says
 *   `createAdapter = null` is skipped),
 * - configured: OAuth and aggregator flows have OAUTH_CALLBACK_BASE; a platform client has its env
 *   credentials; the adapter's own configured() check passes,
 * - audience: BROKER_AUDIENCE for its gate key is "all", or "superadmin" and the caller is the
 *   platform owner (per method and client, never per broker),
 * - an environment is left once sample data is dropped in production.
 */

/**
 * @typedef {import("./adapter-types.mjs").BrokerAdapter} BrokerAdapter
 * @typedef {import("./adapter-types.mjs").ConnectFlow} ConnectFlow
 * @typedef {import("./adapter-types.mjs").OAuthClientKind} OAuthClientKind
 * @typedef {import("./db.mjs").Environment} Environment
 * @typedef {import("./jwt.mjs").ServiceClaims} Claims
 * @typedef {import("./config.mjs").Config} Config
 * @typedef {"not_built" | "not_configured" | "off" | "owner_only" | "no_environment"} ReasonCode
 * @typedef {{
 *   brokerId: string,
 *   method: string,
 *   client: OAuthClientKind | null,
 *   flow: ConnectFlow,
 *   environments: Environment[],
 *   audience: "all" | "superadmin" | "off",
 *   built: boolean,
 *   configured: boolean,
 *   available: boolean,
 *   reasonCode: ReasonCode | null,
 *   reason: string | null,
 *   callbackUrl: string | null,
 * }} ConnectOption
 */

/** Broker names in sentences. */
export const BROKER_NAMES = Object.freeze(
  /** @type {Record<string, string>} */ ({
    ibkr: "IBKR",
    etrade: "E*TRADE",
    alpaca: "Alpaca",
    tradier: "Tradier",
    schwab: "Schwab",
    tastytrade: "tastytrade",
    tradestation: "TradeStation",
    webull: "Webull",
    fidelity: "Fidelity",
    robinhood: "Robinhood",
    public: "Public",
    moomoo: "Moomoo",
  }),
);

/**
 * Every connect method the service knows, as the migration's checks pair them with brokers.
 * `variants` are the clients a method takes (null for methods without an OAuth client) and the
 * flow each one runs. ibkr_oauth is reserved in the database and has no adapter yet.
 * @type {Readonly<Record<string, { brokers: readonly string[], environments: readonly Environment[], variants: ReadonlyArray<{ client: OAuthClientKind | null, flow: ConnectFlow }> }>>}
 */
export const METHODS = Object.freeze({
  ibkr_gateway: { brokers: ["ibkr"], environments: ["production", "paper"], variants: [{ client: null, flow: "gateway_login" }] },
  etrade_oauth1: { brokers: ["etrade"], environments: ["production", "sandbox"], variants: [{ client: null, flow: "oauth1_verifier" }] },
  alpaca_key: { brokers: ["alpaca"], environments: ["production", "paper"], variants: [{ client: null, flow: "api_key" }] },
  alpaca_oauth: { brokers: ["alpaca"], environments: ["production", "paper"], variants: [{ client: "platform", flow: "oauth2_platform" }] },
  tradier_token: { brokers: ["tradier"], environments: ["production", "paper"], variants: [{ client: null, flow: "api_key" }] },
  tradier_oauth: { brokers: ["tradier"], environments: ["production"], variants: [{ client: "platform", flow: "oauth2_platform" }] },
  schwab_oauth: {
    brokers: ["schwab"],
    environments: ["production"],
    variants: [
      { client: "user", flow: "oauth2_user_app" },
      { client: "platform", flow: "oauth2_platform" },
    ],
  },
  tastytrade_oauth: { brokers: ["tastytrade"], environments: ["production", "sandbox"], variants: [{ client: "platform", flow: "oauth2_platform" }] },
  tradestation_oauth: {
    brokers: ["tradestation"],
    environments: ["production", "paper"],
    variants: [
      { client: "user", flow: "oauth2_user_app" },
      { client: "platform", flow: "oauth2_platform" },
    ],
  },
  webull_oauth: { brokers: ["webull"], environments: ["production", "sandbox"], variants: [{ client: "platform", flow: "oauth2_platform" }] },
  snaptrade: { brokers: SNAPTRADE_BROKER_IDS, environments: ["production"], variants: [{ client: null, flow: "aggregator_portal" }] },
});

const REDIRECT_FLOWS = new Set(["oauth2_user_app", "oauth2_platform", "aggregator_portal"]);

/**
 * Platform credentials each platform client needs (names only: the message is for the owner).
 * @type {Record<string, (c: Config) => string | null>}
 */
const PLATFORM_SETUP = {
  alpaca_oauth: (c) => (c.brokers.alpaca.clientId ? null : "ALPACA_CLIENT_ID and ALPACA_CLIENT_SECRET are not set"),
  tradier_oauth: (c) => (c.brokers.tradier.clientId ? null : "TRADIER_CLIENT_ID and TRADIER_CLIENT_SECRET are not set"),
  schwab_oauth: (c) => (c.brokers.schwab.clientId ? null : "SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET are not set"),
  tastytrade_oauth: (c) => (c.brokers.tastytrade.clientId ? null : "TASTYTRADE_CLIENT_ID and TASTYTRADE_CLIENT_SECRET are not set"),
  tradestation_oauth: (c) => (c.brokers.tradestation.clientId ? null : "TRADESTATION_CLIENT_ID and TRADESTATION_CLIENT_SECRET are not set"),
  webull_oauth: (c) =>
    c.brokers.webull.clientId && c.brokers.webull.appKey ? null : "WEBULL_CLIENT_ID, WEBULL_CLIENT_SECRET, WEBULL_APP_KEY and WEBULL_APP_SECRET are not set",
};

/** @param {string} method @param {Config} c */
function snaptradeSetup(method, c) {
  if (method !== "snaptrade") return null;
  return c.brokers.snaptrade.clientId ? null : "SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY are not set";
}

/**
 * Checks a descriptor and the functions its flow needs. Throws at boot, so a broken adapter never
 * serves a request.
 * @param {BrokerAdapter} a
 */
export function validateAdapter(a) {
  const d = a?.descriptor;
  const where = `adapter ${d?.method ?? "(no method)"}`;
  /** @param {string} why */
  const bad = (why) => {
    throw new Error(`${where}: ${why}`);
  };
  if (!d || typeof d !== "object") bad("has no descriptor");
  const m = METHODS[d.method];
  if (!m) bad("serves a method the database does not know");
  if (typeof d.name !== "string" || !d.name.trim()) bad("needs a name");
  if (!Array.isArray(d.brokers) || d.brokers.length === 0 || !d.brokers.every((b) => m.brokers.includes(b))) bad("lists a broker its method cannot serve");
  if (!Array.isArray(d.environments) || d.environments.length === 0 || !d.environments.every((e) => m.environments.includes(e))) {
    bad("lists an environment its method cannot offer");
  }
  const ttl = d.readTtlMs;
  if (!ttl || !["portfolio", "orders", "executions"].every((k) => Number.isFinite(/** @type {any} */ (ttl)[k]) && /** @type {any} */ (ttl)[k] >= 0)) {
    bad("needs readTtlMs for portfolio, orders and executions");
  }
  if (d.sweepEveryMs !== undefined && d.sweepEveryMs !== null && !(Number.isInteger(d.sweepEveryMs) && d.sweepEveryMs >= 1_000)) {
    bad("sweepEveryMs must be at least 1000 or null");
  }
  if (d.lazyAccounts !== undefined && typeof d.lazyAccounts !== "boolean") bad("lazyAccounts must be true or false");
  const clients = d.clients ?? m.variants.map((v) => v.client);
  if (!clients.every((c) => m.variants.some((v) => v.client === c))) bad("lists a client its method does not take");
  if (typeof a.orders !== "function" || typeof a.executions !== "function") bad("needs orders() and executions()");
  if (typeof a.portfolio !== "function" && (typeof a.balances !== "function" || typeof a.positions !== "function")) {
    bad("needs portfolio(), or balances() and positions()");
  }
  const flows = m.variants.filter((v) => clients.includes(v.client)).map((v) => v.flow);
  if (flows.includes("api_key") && typeof a.connectKey !== "function") bad("needs connectKey() for the api_key flow");
  if (flows.some((f) => f === "oauth2_user_app" || f === "oauth2_platform") && (typeof a.oauthProfile !== "function" || typeof a.identify !== "function")) {
    bad("needs oauthProfile() and identify() (every OAuth login is named by its external_ref)");
  }
  if (flows.includes("aggregator_portal") && (typeof a.portalUrl !== "function" || typeof a.aggregatorComplete !== "function")) {
    bad("needs portalUrl() and aggregatorComplete()");
  }
}

/**
 * @param {BrokerAdapter[]} adapters the built adapters (nulls already left out)
 * @param {Config} config
 */
export function createRegistry(adapters, config) {
  /** @type {Map<string, BrokerAdapter>} */
  const byMethod = new Map();
  for (const a of adapters) {
    validateAdapter(a);
    if (byMethod.has(a.descriptor.method)) throw new Error(`adapter ${a.descriptor.method}: registered twice`);
    byMethod.set(a.descriptor.method, a);
  }

  /** @param {string} segment broker id (OAuth) or "snaptrade" */
  const callbackUrl = (segment) => (config.oauth.callbackBase ? `${config.oauth.callbackBase}/api/broker/callback/${segment}` : null);

  /** @param {string} method @param {OAuthClientKind | null} client */
  function flowOf(method, client) {
    const v = METHODS[method]?.variants.find((x) => x.client === client) ?? METHODS[method]?.variants[0];
    if (!v) throw new HttpError(400, "Nasscord does not know this way of connecting.", { code: "unknown_method" });
    return v.flow;
  }

  /**
   * Environments the method offers on this server: the adapter's runtime list (or its descriptor's),
   * without sample data in production.
   * @param {string} method
   */
  function environmentsOf(method) {
    const a = byMethod.get(method);
    const all = a ? (a.environmentsFor?.(config) ?? a.descriptor.environments) : [...(METHODS[method]?.environments ?? [])];
    return all.filter((e) => !(config.production && e === "sandbox"));
  }

  /**
   * One connect option as GET /v1/options answers it.
   * @param {Claims | null} claims
   * @param {string} brokerId
   * @param {string} method
   * @param {OAuthClientKind | null} client
   * @returns {ConnectOption}
   */
  function option(claims, brokerId, method, client) {
    const name = BROKER_NAMES[brokerId] ?? brokerId;
    const owner = claims?.role === "superadmin";
    const flow = flowOf(method, client);
    const adapter = byMethod.get(method) ?? null;
    const built = !!adapter && (adapter.descriptor.clients ?? METHODS[method].variants.map((v) => v.client)).includes(client) && adapter.descriptor.brokers.includes(/** @type {any} */ (brokerId));
    const redirect = REDIRECT_FLOWS.has(flow);
    const setup =
      (redirect && !config.oauth.callbackBase ? "OAUTH_CALLBACK_BASE is not set" : null) ??
      (client === "platform" ? (PLATFORM_SETUP[method]?.(config) ?? null) : null) ??
      snaptradeSetup(method, config) ??
      (method === "snaptrade" && !config.brokers.snaptrade.brokers.includes(brokerId) ? `SNAPTRADE_BROKERS does not list ${brokerId}` : null) ??
      (adapter?.configured?.(client) ?? null);
    const audience = config.audience[gateKey(method, client)] ?? "off";
    const environments = environmentsOf(method);

    /** @type {ReasonCode | null} */
    let reasonCode = null;
    /** @type {string | null} */
    let reason = null;
    if (!built) {
      reasonCode = "not_built";
      reason = `Nasscord cannot connect to ${name} this way yet.`;
    } else if (audience === "off") {
      reasonCode = "off";
      reason = `Connecting ${name} this way is not available yet.`;
    } else if (setup) {
      reasonCode = "not_configured";
      reason = owner ? `Not set up on this server: ${setup}.` : `${name} is not set up on this server yet.`;
    } else if (audience === "superadmin" && !owner) {
      reasonCode = "owner_only";
      reason = `Not available yet: Nasscord is waiting for ${name}'s approval before everyone can connect this way.`;
    } else if (environments.length === 0) {
      reasonCode = "no_environment";
      reason = `${name} has no account type Nasscord can connect on this server.`;
    }
    return {
      brokerId,
      method,
      client,
      flow,
      environments,
      audience,
      built,
      configured: built && !setup,
      available: reasonCode === null,
      reasonCode,
      reason,
      callbackUrl: redirect ? callbackUrl(method === "snaptrade" ? "snaptrade" : brokerId) : null,
    };
  }

  /** @param {Claims | null} claims */
  function options(claims) {
    /** @type {ConnectOption[]} */
    const out = [];
    for (const [method, m] of Object.entries(METHODS)) {
      for (const brokerId of m.brokers) for (const v of m.variants) out.push(option(claims, brokerId, method, v.client));
    }
    return { callbackBase: config.oauth.callbackBase, options: out };
  }

  return {
    callbackUrl,
    flowOf,
    environmentsOf,
    options,

    /** @returns {BrokerAdapter[]} */
    list: () => [...byMethod.values()],

    /** @param {string} method */
    get: (method) => byMethod.get(method) ?? null,

    /**
     * The adapter of a stored connection.
     * @param {{ method: string, broker_id: string }} row
     */
    adapterFor(row) {
      const a = byMethod.get(row.method);
      if (!a) {
        const name = BROKER_NAMES[row.broker_id] ?? row.broker_id;
        throw unavailable(`Nasscord cannot read ${name} connections on this server yet.`, "not_built");
      }
      return a;
    },

    /**
     * The method of a broker for a flow family ("key", "oauth" or "aggregator"), or null.
     * @param {string} brokerId
     * @param {"key" | "oauth" | "aggregator"} family
     */
    methodFor(brokerId, family) {
      for (const [method, m] of Object.entries(METHODS)) {
        if (!m.brokers.includes(brokerId)) continue;
        const flows = m.variants.map((v) => v.flow);
        if (family === "key" && flows.includes("api_key")) return method;
        if (family === "oauth" && flows.some((f) => f === "oauth2_user_app" || f === "oauth2_platform")) return method;
        if (family === "aggregator" && flows.includes("aggregator_portal")) return method;
      }
      return null;
    },

    /**
     * Throws unless the caller may use this method and client now; returns the option.
     * `audienceOnly` checks the BROKER_AUDIENCE gate alone (the IBKR and E*TRADE start routes keep
     * their own setup errors).
     * @param {Claims} claims
     * @param {string} brokerId
     * @param {string} method
     * @param {OAuthClientKind | null} client
     * @param {{ audienceOnly?: boolean }} [o]
     */
    gate(claims, brokerId, method, client, o = {}) {
      if (!METHODS[method]?.brokers.includes(brokerId) || !METHODS[method].variants.some((v) => v.client === client)) {
        throw new HttpError(400, "Nasscord does not connect this broker that way.", { code: "unknown_method" });
      }
      const opt = option(claims, brokerId, method, client);
      if (opt.available) return opt;
      if (o.audienceOnly) {
        const name = BROKER_NAMES[brokerId] ?? brokerId;
        if (opt.audience === "off") throw forbidden(`Connecting ${name} is not available yet.`, "off");
        if (opt.audience === "superadmin" && claims.role !== "superadmin") {
          throw forbidden(`Not available yet: Nasscord is waiting for ${name}'s approval before everyone can connect.`, "owner_only");
        }
        return opt;
      }
      if (opt.reasonCode === "off" || opt.reasonCode === "owner_only") throw forbidden(/** @type {string} */ (opt.reason), opt.reasonCode);
      throw unavailable(/** @type {string} */ (opt.reason), opt.reasonCode ?? "unavailable");
    },

    /**
     * The adapter that takes POST /hooks/<name> (a method or a broker id), or null.
     * @param {string} name
     */
    webhookFor(name) {
      for (const a of byMethod.values()) {
        if (typeof a.webhook !== "function") continue;
        if (a.descriptor.method === name || (a.descriptor.brokers.length === 1 && a.descriptor.brokers[0] === name)) return a;
      }
      return null;
    },
  };
}

/** @typedef {ReturnType<typeof createRegistry>} Registry */
