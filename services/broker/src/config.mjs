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
 *   limits: { ibkrPerSec: number, etradePerSec: number, globalPerSec: number, maxWaitMs: number },
 *   steps: { connectPerUser: number, connectGlobalPerMin: number },
 *   cacheMs: number,
 * }} Config
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
  // Connect steps (IBKR and E*TRADE start, Reconnect) per user in 10 minutes, and new connections
  // (IBKR and E*TRADE starts) per minute for the whole process.
  const connectPerUser = int("BROKER_CONNECT_PER_USER", 20, 1, 1_000);
  const connectGlobalPerMin = int("BROKER_CONNECT_GLOBAL_PER_MIN", 60, 1, 10_000);
  // IBKR gateways waiting for a login (not logged in yet) at one time. Default: half the slots,
  // so logins that are never finished cannot take every slot.
  const maxPendingLogins = int("IBKR_MAX_PENDING_LOGINS", Math.max(2, Math.ceil(ports.length / 2)), 1, 1_000);

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
      // Sandbox keys hold no real money; allowed by default only outside production.
      allowSandbox: bool(env.ETRADE_ALLOW_SANDBOX, !production),
      oauthBase: "https://api.etrade.com",
      apiBase: Object.freeze({ production: "https://api.etrade.com", sandbox: "https://apisb.etrade.com" }),
      authorizeUrl: "https://us.etrade.com/e/t/etws/authorize",
    }),
    limits: Object.freeze({
      ibkrPerSec: 8,
      etradePerSec: 2,
      globalPerSec,
      maxWaitMs: 5_000,
    }),
    steps: Object.freeze({ connectPerUser, connectGlobalPerMin }),
    cacheMs: 5_000,
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
