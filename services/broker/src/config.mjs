import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The service folder (services/broker). */
export const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(SERVICE_ROOT, "package.json"), "utf8")).version);
  } catch {
    return "0.0.0";
  }
})();

/**
 * Who may use a connect method (contract section "Who may connect"): everyone with a trading
 * workspace, the platform owner only, or nobody.
 * @typedef {"all" | "superadmin" | "off"} Audience
 */
export const AUDIENCES = /** @type {const} */ (["all", "superadmin", "off"]);

/**
 * BROKER_AUDIENCE gate keys and their defaults. One key per connect method, and for the two OAuth
 * methods that take either the user's own app or Nasscord's registered client, one per client
 * ("schwab_oauth.user", "schwab_oauth.platform"). A gate only opens a method that is also built
 * and configured: a platform OAuth client stays unavailable until its env credentials exist, and
 * SnapTrade until SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY are set.
 * - Users' own credentials that each broker allows for third parties: all.
 * - The owner's own testing (Schwab Individual app, TradeStation key, Tradier personal token,
 *   tastytrade personal app) and every platform client until the broker approves Nasscord:
 *   superadmin. The owner opens one to everyone with BROKER_AUDIENCE once the approval is in writing.
 */
export const AUDIENCE_DEFAULTS = Object.freeze(
  /** @type {Record<string, Audience>} */ ({
    ibkr_gateway: "all",
    etrade_oauth1: "all",
    alpaca_key: "all",
    alpaca_oauth: "superadmin",
    tradier_token: "superadmin",
    tradier_oauth: "superadmin",
    "schwab_oauth.user": "superadmin",
    "schwab_oauth.platform": "superadmin",
    tastytrade_oauth: "superadmin",
    "tradestation_oauth.user": "superadmin",
    "tradestation_oauth.platform": "superadmin",
    webull_oauth: "superadmin",
    snaptrade: "all",
  }),
);

/** Methods whose connect step takes either the user's own OAuth app or Nasscord's own client. */
export const TWO_CLIENT_METHODS = Object.freeze(["schwab_oauth", "tradestation_oauth"]);

/**
 * The BROKER_AUDIENCE key of a method and client.
 * @param {string} method
 * @param {"user" | "platform" | null} [client]
 */
export function gateKey(method, client = null) {
  return TWO_CLIENT_METHODS.includes(method) ? `${method}.${client ?? "user"}` : method;
}

/**
 * Brokers SnapTrade may connect for Nasscord (the migration's snaptrade pairs). Schwab (read only) and
 * tastytrade need their own SnapTrade profile approvals, so they are not in the default
 * SNAPTRADE_BROKERS: the owner adds them once SnapTrade enables them.
 */
export const SNAPTRADE_BROKER_IDS = Object.freeze(["fidelity", "robinhood", "public", "moomoo", "webull", "schwab", "tastytrade"]);
export const DEFAULT_SNAPTRADE_BROKERS = Object.freeze(["fidelity", "robinhood", "public", "moomoo", "webull"]);

/**
 * @typedef {{
 *   version: string,
 *   nodeEnv: string,
 *   production: boolean,
 *   logLevel: string,
 *   apiHost: string,
 *   apiPort: number,
 *   loginHost: string,
 *   loginPort: number,
 *   publicLoginUrl: string,
 *   loginCookieSecure: boolean,
 *   appUrl: string | null,
 *   supabaseUrl: string,
 *   supabaseServiceRoleKey: string,
 *   serviceSecret: string,
 *   tokenKey: Buffer,
 *   tokenKeyVersion: number,
 *   previousTokenKeys: Map<number, Buffer>,
 *   ibkr: {
 *     bundle: string,
 *     runtime: string,
 *     ports: number[],
 *     javaBin: string,
 *     xmx: string,
 *     loginWindowMs: number,
 *     releaseAfterExpiryMs: number,
 *     maxPendingLogins: number,
 *     keepaliveMs: number,
 *     sessionHours: number,
 *   },
 *   etrade: {
 *     allowSandbox: boolean,
 *     oauthBase: string,
 *     apiBase: { production: string, sandbox: string },
 *     authorizeUrl: string,
 *   },
 *   oauth: { callbackBase: string | null, loginWindowMs: number, claimWindowMs: number },
 *   audience: Readonly<Record<string, Audience>>,
 *   urlOverrides: Readonly<Record<string, Readonly<Record<string, string>>>>,
 *   brokers: {
 *     alpaca: { clientId: string | null, clientSecret: string | null },
 *     tradier: { clientId: string | null, clientSecret: string | null, refreshTokens: boolean, sandboxTokens: boolean },
 *     schwab: { clientId: string | null, clientSecret: string | null },
 *     tastytrade: { clientId: string | null, clientSecret: string | null, env: "production" | "cert", apiVersion: string },
 *     tradestation: { clientId: string | null, clientSecret: string | null, allowSim: boolean },
 *     webull: { clientId: string | null, clientSecret: string | null, appKey: string | null, appSecret: string | null, env: "production" | "sandbox" },
 *     snaptrade: { clientId: string | null, consumerKey: string | null, brokers: readonly string[], plan: "realtime" | "daily" },
 *   },
 *   limits: { ibkrPerSec: number, etradePerSec: number, globalPerSec: number, maxWaitMs: number },
 *   steps: { connectPerUser: number, connectGlobalPerMin: number },
 *   orders: OrdersConfig,
 *   cacheMs: number,
 *   warnings: readonly string[],
 * }} Config
 */

/**
 * Order entry (docs/real-backend.md section 13).
 * - entry: ORDER_ENTRY, the server-wide switch: "off" refuses every preview and place (cancel and
 *   status keep working).
 * - maxQty, maxNotional: ORDER_MAX_QTY shares and ORDER_MAX_NOTIONAL US dollars per order.
 * - ibkrStopOrders, ibkrBrackets: IBKR_STOP_ORDERS and IBKR_BRACKETS: "paper" allows them on paper
 *   accounts only, "on" on live accounts too.
 * - etradeBody: ETRADE_ORDER_BODY, the request body format of E*TRADE order calls.
 * @typedef {{
 *   entry: "on" | "off",
 *   maxQty: number,
 *   maxNotional: number,
 *   ibkrStopOrders: "off" | "paper" | "on",
 *   ibkrBrackets: "off" | "paper" | "on",
 *   etradeBody: "xml" | "json",
 * }} OrdersConfig
 */

export class ConfigError extends Error {
  /** @param {string[]} problems names and rules only, never values */
  constructor(problems) {
    super(`The broker service configuration is not valid:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * "7200-7249" or "7200,7201,7210-7215" -> sorted unique ports.
 * @param {string} text
 * @returns {number[]}
 */
export function parsePortRange(text) {
  /** @type {Set<number>} */
  const ports = new Set();
  for (const part of String(text).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a port or a range`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1024 || to > 65535 || to < from) throw new Error(`"${part}" is outside 1024-65535 or reversed`);
    if (to - from > 1000) throw new Error(`"${part}" is wider than 1000 ports`);
    for (let p = from; p <= to; p++) ports.add(p);
  }
  if (ports.size === 0) throw new Error("no ports given");
  return [...ports].sort((a, b) => a - b);
}

/**
 * BROKER_AUDIENCE ("alpaca_key=all,schwab_oauth.user=superadmin,tradier_token=off") on top of the
 * defaults. "all=<audience>" (or "*") sets every gate first; a bare two-client method
 * ("schwab_oauth=all") sets both of its clients. Unknown keys and audiences are problems; the
 * message names the key (a method name, not a secret).
 * @param {string | undefined} raw
 * @param {string[]} problems
 * @returns {Record<string, Audience>}
 */
export function parseAudience(raw, problems) {
  /** @type {Record<string, Audience>} */
  const out = { ...AUDIENCE_DEFAULTS };
  const keys = Object.keys(AUDIENCE_DEFAULTS);
  const entries = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  /** @type {Array<[string, Audience]>} */
  const parsed = [];
  for (const entry of entries) {
    const m = /^([a-z0-9_.*]{1,40})\s*=\s*([a-z]+)$/.exec(entry);
    if (!m) {
      problems.push("BROKER_AUDIENCE must look like method=all|superadmin|off, comma-separated");
      continue;
    }
    const value = /** @type {Audience} */ (m[2]);
    if (!AUDIENCES.includes(value)) {
      problems.push(`BROKER_AUDIENCE: ${m[1]} must be all, superadmin or off`);
      continue;
    }
    parsed.push([m[1], value]);
  }
  // "all" first, so a specific key after it (or before it) always wins.
  for (const [key, value] of parsed) if (key === "all" || key === "*") for (const k of keys) out[k] = value;
  for (const [key, value] of parsed) {
    if (key === "all" || key === "*") continue;
    if (TWO_CLIENT_METHODS.includes(key)) {
      out[`${key}.user`] = value;
      out[`${key}.platform`] = value;
    } else if (keys.includes(key)) {
      out[key] = value;
    } else {
      problems.push(`BROKER_AUDIENCE: ${key} is not a connect method this service knows`);
    }
  }
  return out;
}

/**
 * @param {string | undefined} value
 * @param {boolean} fallback
 */
function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Reads and validates the environment. Problems are collected and thrown together,
 * naming the variable and the rule but never echoing a value.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  const nodeEnv = env.NODE_ENV || "development";
  const production = nodeEnv === "production";

  /** @param {string} name @param {number} fallback */
  const port = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      problems.push(`${name} must be a port number (1-65535)`);
      return fallback;
    }
    return n;
  };
  /** @param {string} name @param {number} fallback @param {number} min @param {number} max */
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };
  /** @param {string} name */
  const required = (name) => {
    const v = (env[name] ?? "").trim();
    if (!v) problems.push(`${name} is required`);
    return v;
  };
  /**
   * An optional credential: printable, no spaces, at most 512 characters. Null when unset.
   * @param {string} name
   */
  const credential = (name) => {
    const v = (env[name] ?? "").trim();
    if (!v) return null;
    if (!/^[\x21-\x7e]{1,512}$/.test(v)) {
      problems.push(`${name} must be printable characters without spaces (at most 512)`);
      return null;
    }
    return v;
  };
  /**
   * Two credentials that only work together (a client id and its secret).
   * @param {string} a @param {string} b
   * @returns {[string | null, string | null]}
   */
  const pair = (a, b) => {
    const x = credential(a);
    const y = credential(b);
    if ((x === null) !== (y === null)) {
      problems.push(`${a} and ${b} must be set together`);
      return [null, null];
    }
    return [x, y];
  };
  /**
   * An http(s) origin with no path. Null when unset.
   * @param {string} name
   * @param {{ httpsInProduction?: boolean }} [opts]
   */
  const origin = (name, opts = {}) => {
    const raw = (env[name] ?? "").trim().replace(/\/+$/, "");
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
        problems.push(`${name} must be an origin with no path, like https://nasscord.com`);
        return null;
      }
      if (opts.httpsInProduction && production && u.protocol !== "https:") {
        problems.push(`${name} must use https in production`);
        return null;
      }
      return u.origin;
    } catch {
      problems.push(`${name} must be an http(s) URL`);
      return null;
    }
  };
  /**
   * @template {string} T
   * @param {string} name @param {readonly T[]} allowed @param {T} fallback
   * @returns {T}
   */
  const oneOf = (name, allowed, fallback) => {
    const raw = (env[name] ?? "").trim();
    if (!raw) return fallback;
    if (!allowed.includes(/** @type {T} */ (raw))) {
      problems.push(`${name} must be one of ${allowed.join(", ")}`);
      return fallback;
    }
    return /** @type {T} */ (raw);
  };

  const apiPort = port("API_PORT", 8710);
  const loginPort = port("LOGIN_PORT", 8711);
  if (apiPort === loginPort) problems.push("API_PORT and LOGIN_PORT must differ");

  let publicLoginUrl = (env.PUBLIC_LOGIN_URL || `http://localhost:${loginPort}`).trim().replace(/\/+$/, "");
  try {
    const u = new URL(publicLoginUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    if (u.pathname !== "/" || u.search || u.hash) problems.push("PUBLIC_LOGIN_URL must be an origin with no path");
    if (production && u.protocol !== "https:") problems.push("PUBLIC_LOGIN_URL must use https in production");
    publicLoginUrl = u.origin;
  } catch {
    problems.push("PUBLIC_LOGIN_URL must be an http(s) URL");
  }

  let appUrl = (env.NASSCORD_APP_URL || "").trim().replace(/\/+$/, "") || null;
  if (appUrl) {
    try {
      appUrl = new URL(appUrl).origin;
    } catch {
      problems.push("NASSCORD_APP_URL must be a URL");
      appUrl = null;
    }
  }

  const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
  if (supabaseUrl && !/^https?:\/\/[^/]+$/.test(supabaseUrl)) problems.push("SUPABASE_URL must be the project origin, e.g. https://xyz.supabase.co");
  const supabaseServiceRoleKey = required("SUPABASE_SERVICE_ROLE_KEY");

  const serviceSecret = required("BROKER_SERVICE_SECRET");
  if (serviceSecret && Buffer.byteLength(serviceSecret, "utf8") < 32) {
    problems.push("BROKER_SERVICE_SECRET must be at least 32 bytes");
  }

  /** @param {string} name @param {string} raw */
  const aesKey = (name, raw) => {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32 || buf.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
      problems.push(`${name} must be base64 of exactly 32 bytes`);
      return Buffer.alloc(32);
    }
    return buf;
  };
  const tokenKeyRaw = required("BROKER_TOKEN_KEY");
  const tokenKey = tokenKeyRaw ? aesKey("BROKER_TOKEN_KEY", tokenKeyRaw) : Buffer.alloc(32);
  const tokenKeyVersion = int("BROKER_TOKEN_KEY_VERSION", 1, 1, 1_000_000);

  /** @type {Map<number, Buffer>} */
  const previousTokenKeys = new Map();
  for (const item of (env.BROKER_TOKEN_KEYS_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+):(.+)$/.exec(item);
    if (!m) {
      problems.push("BROKER_TOKEN_KEYS_PREVIOUS must look like 1:<base64>,2:<base64>");
      continue;
    }
    const v = Number(m[1]);
    if (v === tokenKeyVersion) problems.push("BROKER_TOKEN_KEYS_PREVIOUS must not repeat the current key version");
    previousTokenKeys.set(v, aesKey(`BROKER_TOKEN_KEYS_PREVIOUS (version ${v})`, m[2]));
  }

  let ports = [];
  try {
    ports = parsePortRange(env.IBKR_GATEWAY_PORTS || "7200-7249");
  } catch (e) {
    problems.push(`IBKR_GATEWAY_PORTS: ${/** @type {Error} */ (e).message}`);
  }
  if (ports.includes(apiPort) || ports.includes(loginPort)) {
    problems.push("IBKR_GATEWAY_PORTS must not include API_PORT or LOGIN_PORT");
  }

  const xmx = (env.IBKR_GATEWAY_XMX || "256m").trim();
  if (!/^\d{2,5}[mMgG]$/.test(xmx)) problems.push("IBKR_GATEWAY_XMX must look like 256m or 1g");

  const javaBin = (env.JAVA_BIN || "java").trim();
  if (/[\r\n\0]/.test(javaBin)) problems.push("JAVA_BIN must be a single path");

  const bundle = path.resolve(SERVICE_ROOT, env.IBKR_GATEWAY_BUNDLE || "vendor/clientportal.gw");
  const runtime = path.resolve(SERVICE_ROOT, env.IBKR_GATEWAY_RUNTIME || "runtime");
  if (bundle === runtime || runtime.startsWith(bundle + path.sep)) {
    problems.push("IBKR_GATEWAY_RUNTIME must be outside IBKR_GATEWAY_BUNDLE");
  }

  const logLevel = (env.LOG_LEVEL || "info").trim();
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
    problems.push("LOG_LEVEL must be debug, info, warn, error or silent");
  }

  const globalPerSec = int("BROKER_GLOBAL_RPS", 50, 1, 10_000);
  // Connect steps (starts, Reconnect) per user in 10 minutes, and new connections per minute for
  // the whole process.
  const connectPerUser = int("BROKER_CONNECT_PER_USER", 20, 1, 1_000);
  const connectGlobalPerMin = int("BROKER_CONNECT_GLOBAL_PER_MIN", 60, 1, 10_000);
  // IBKR gateways waiting for a login (not logged in yet) at one time. Default: half the slots,
  // so logins that are never finished cannot take every slot.
  const maxPendingLogins = int("IBKR_MAX_PENDING_LOGINS", Math.max(2, Math.ceil(ports.length / 2)), 1, 1_000);

  // ── Sample-data environments are for developers only: never in production.
  const etradeSandboxAsked = bool(env.ETRADE_ALLOW_SANDBOX, !production);
  if (production && etradeSandboxAsked) {
    warnings.push("ETRADE_ALLOW_SANDBOX is ignored in production: E*TRADE sandbox keys serve sample data");
  }

  // ── OAuth and aggregator returns. Every broker redirects to OAUTH_CALLBACK_BASE +
  // /api/broker/callback/<broker>: one canonical host, registered with each broker once.
  const callbackBase = origin("OAUTH_CALLBACK_BASE", { httpsInProduction: true }) ?? (production ? null : appUrl ?? "http://localhost:3000");

  const audience = parseAudience(env.BROKER_AUDIENCE, problems);

  /** @type {Record<string, Record<string, string>>} */
  const urlOverrides = {};
  const overridesRaw = (env.BROKER_URL_OVERRIDES ?? "").trim();
  if (overridesRaw) {
    if (production) {
      problems.push("BROKER_URL_OVERRIDES is for local fake brokers and is refused in production");
    } else {
      try {
        const parsed = JSON.parse(overridesRaw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        for (const [broker, urls] of Object.entries(parsed)) {
          if (!/^[a-z]{2,20}$/.test(broker) || !urls || typeof urls !== "object" || Array.isArray(urls)) throw new Error("shape");
          /** @type {Record<string, string>} */
          const out = {};
          for (const [name, url] of Object.entries(urls)) {
            if (!/^[a-zA-Z]{1,30}$/.test(name) || typeof url !== "string" || !/^https?:\/\/[^\s]+$/.test(url)) throw new Error("shape");
            out[name] = url.replace(/\/+$/, "");
          }
          urlOverrides[broker] = Object.freeze(out);
        }
      } catch {
        problems.push('BROKER_URL_OVERRIDES must be JSON like {"alpaca":{"live":"http://127.0.0.1:9001"}}');
      }
    }
  }

  // ── Broker credentials (all optional; a method without its credentials is "not configured").
  const [alpacaId, alpacaSecret] = pair("ALPACA_CLIENT_ID", "ALPACA_CLIENT_SECRET");
  const [tradierId, tradierSecret] = pair("TRADIER_CLIENT_ID", "TRADIER_CLIENT_SECRET");
  const [schwabId, schwabSecret] = pair("SCHWAB_CLIENT_ID", "SCHWAB_CLIENT_SECRET");
  const [tastyId, tastySecret] = pair("TASTYTRADE_CLIENT_ID", "TASTYTRADE_CLIENT_SECRET");
  const [tsId, tsSecret] = pair("TRADESTATION_CLIENT_ID", "TRADESTATION_CLIENT_SECRET");
  const [webullId, webullSecret] = pair("WEBULL_CLIENT_ID", "WEBULL_CLIENT_SECRET");
  const [webullAppKey, webullAppSecret] = pair("WEBULL_APP_KEY", "WEBULL_APP_SECRET");
  const [snapId, snapKey] = pair("SNAPTRADE_CLIENT_ID", "SNAPTRADE_CONSUMER_KEY");

  const tastyEnv = oneOf("TASTYTRADE_ENV", /** @type {const} */ (["production", "cert"]), "production");
  if (production && tastyEnv === "cert") problems.push("TASTYTRADE_ENV=cert is sample data and is refused in production");
  const tastyVersion = (env.TASTYTRADE_API_VERSION ?? "").trim() || "20261012";
  if (!/^\d{8}$/.test(tastyVersion)) problems.push("TASTYTRADE_API_VERSION must be a date like 20261012");

  const webullEnv = oneOf("WEBULL_ENV", /** @type {const} */ (["production", "sandbox"]), "production");
  if (production && webullEnv === "sandbox") problems.push("WEBULL_ENV=sandbox is sample data and is refused in production");

  /** @type {string[]} */
  let snapBrokers = [...DEFAULT_SNAPTRADE_BROKERS];
  const snapBrokersRaw = (env.SNAPTRADE_BROKERS ?? "").trim();
  if (snapBrokersRaw) {
    const list = snapBrokersRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.every((b) => SNAPTRADE_BROKER_IDS.includes(b))) {
      problems.push(`SNAPTRADE_BROKERS must list only ${SNAPTRADE_BROKER_IDS.join(", ")}`);
    } else {
      snapBrokers = [...new Set(list)];
    }
  }
  const snapPlan = oneOf("SNAPTRADE_PLAN", /** @type {const} */ (["realtime", "daily"]), "daily");

  // ── Order entry (section 13). Off per workspace until the super admin switches it on; these are
  // the server-wide switch and limits on top of that.
  const orderEntry = oneOf("ORDER_ENTRY", /** @type {const} */ (["on", "off"]), "on");
  const orderMaxQty = int("ORDER_MAX_QTY", 10_000, 1, 1_000_000);
  const orderMaxNotional = int("ORDER_MAX_NOTIONAL", 250_000, 1_000, 100_000_000);
  const ibkrStopOrders = oneOf("IBKR_STOP_ORDERS", /** @type {const} */ (["off", "paper", "on"]), "paper");
  const ibkrBrackets = oneOf("IBKR_BRACKETS", /** @type {const} */ (["off", "paper", "on"]), "paper");
  const etradeBody = oneOf("ETRADE_ORDER_BODY", /** @type {const} */ (["xml", "json"]), "xml");
  if (orderEntry === "off") warnings.push("ORDER_ENTRY=off: every preview and place is refused");
  if (ibkrBrackets === "on" && ibkrStopOrders !== "on") {
    warnings.push("IBKR_BRACKETS=on needs IBKR_STOP_ORDERS=on: live IBKR accounts get no brackets until both are on");
  }

  if (problems.length) throw new ConfigError(problems);

  return Object.freeze({
    version: VERSION,
    nodeEnv,
    production,
    logLevel,
    // Behind Caddy on the same host: listen on loopback unless told otherwise.
    apiHost: (env.API_HOST || "127.0.0.1").trim(),
    apiPort,
    loginHost: (env.LOGIN_HOST || "127.0.0.1").trim(),
    loginPort,
    publicLoginUrl,
    loginCookieSecure: publicLoginUrl.startsWith("https:"),
    appUrl,
    supabaseUrl,
    supabaseServiceRoleKey,
    serviceSecret,
    tokenKey,
    tokenKeyVersion,
    previousTokenKeys,
    ibkr: Object.freeze({
      bundle,
      runtime,
      ports,
      javaBin,
      xmx,
      loginWindowMs: 20 * 60_000,
      releaseAfterExpiryMs: 30 * 60_000,
      maxPendingLogins: Math.min(maxPendingLogins, Math.max(1, ports.length)),
      keepaliveMs: 55_000,
      sessionHours: 24,
    }),
    etrade: Object.freeze({
      // Sandbox keys serve E*TRADE's sample accounts: developers only, never in production.
      allowSandbox: !production && etradeSandboxAsked,
      oauthBase: "https://api.etrade.com",
      apiBase: Object.freeze({ production: "https://api.etrade.com", sandbox: "https://apisb.etrade.com" }),
      authorizeUrl: "https://us.etrade.com/e/t/etws/authorize",
    }),
    oauth: Object.freeze({
      callbackBase,
      // A login started and not finished at the broker within this window is dropped.
      loginWindowMs: 10 * 60_000,
      // After the code exchange on the canonical host, the user's own host claims it within this.
      claimWindowMs: 5 * 60_000,
    }),
    audience: Object.freeze(audience),
    urlOverrides: Object.freeze(urlOverrides),
    brokers: Object.freeze({
      alpaca: Object.freeze({ clientId: alpacaId, clientSecret: alpacaSecret }),
      tradier: Object.freeze({
        clientId: tradierId,
        clientSecret: tradierSecret,
        refreshTokens: bool(env.TRADIER_REFRESH_TOKENS, false),
        sandboxTokens: bool(env.TRADIER_SANDBOX_TOKENS, false),
      }),
      schwab: Object.freeze({ clientId: schwabId, clientSecret: schwabSecret }),
      tastytrade: Object.freeze({ clientId: tastyId, clientSecret: tastySecret, env: tastyEnv, apiVersion: tastyVersion }),
      tradestation: Object.freeze({ clientId: tsId, clientSecret: tsSecret, allowSim: bool(env.TRADESTATION_ALLOW_SIM, false) }),
      webull: Object.freeze({ clientId: webullId, clientSecret: webullSecret, appKey: webullAppKey, appSecret: webullAppSecret, env: webullEnv }),
      snaptrade: Object.freeze({ clientId: snapId, consumerKey: snapKey, brokers: Object.freeze(snapBrokers), plan: snapPlan }),
    }),
    limits: Object.freeze({
      ibkrPerSec: 8,
      etradePerSec: 2,
      globalPerSec,
      maxWaitMs: 5_000,
    }),
    steps: Object.freeze({ connectPerUser, connectGlobalPerMin }),
    orders: Object.freeze({
      entry: orderEntry,
      maxQty: orderMaxQty,
      maxNotional: orderMaxNotional,
      ibkrStopOrders,
      ibkrBrackets,
      etradeBody,
    }),
    cacheMs: 5_000,
    warnings: Object.freeze(warnings),
  });
}

/**
 * True when the gateway bundle has the files the service needs to start a JVM.
 * @param {string} bundle
 */
export function bundleLooksValid(bundle) {
  return (
    existsSync(path.join(bundle, "root", "conf.yaml")) &&
    existsSync(path.join(bundle, "dist", "ibgroup.web.core.iblink.router.clientportal.gw.jar")) &&
    existsSync(path.join(bundle, "build", "lib", "runtime"))
  );
}
