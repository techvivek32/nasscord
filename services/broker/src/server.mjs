import { randomUUID } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createAudit } from "./audit.mjs";
import { createCoalescingCache } from "./cache.mjs";
import { ConfigError, loadConfig } from "./config.mjs";
import { createConnectionService } from "./connections.mjs";
import { createDb, createStore } from "./db.mjs";
import { forbidden, HttpError, unauthorized, userMessage } from "./errors.mjs";
import { createEtradeAdapter } from "./etrade/adapter.mjs";
import { createIbkrAdapter } from "./ibkr/adapter.mjs";
import { createGatewayHttp } from "./ibkr/gateway-http.mjs";
import { createGatewayManager } from "./ibkr/gateway-manager.mjs";
import { createLoginProxy, createLoginTokens } from "./ibkr/login-proxy.mjs";
import { createIbkrSessions } from "./ibkr/session.mjs";
import { bearerToken, JwtError, verifyServiceJwt } from "./jwt.mjs";
import { createLimiter, createWindowCounter } from "./limits.mjs";
import { createLocks } from "./locks.mjs";
import { createLogger } from "./log.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createSecretBox } from "./secrets.mjs";

/**
 * Two listeners in one process:
 * - API_PORT: JSON API for the Nasscord app (contract section 6). Everything under /v1 needs the
 *   service JWT.
 * - LOGIN_PORT: the public IBKR login host (contract section 7).
 */

const MAX_BODY_BYTES = 32 * 1024;

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, "The request is too large."));
      req.resume();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "The request is too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      const type = String(req.headers["content-type"] ?? "");
      if (type && !/application\/json/i.test(type)) return reject(new HttpError(415, "Send the request body as JSON."));
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
        resolve(v);
      } catch {
        reject(new HttpError(400, "The request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

/**
 * @typedef {import("./jwt.mjs").ServiceClaims} Claims
 * @typedef {{ method: string, pattern: RegExp, auth: boolean,
 *   run: (ctx: { claims: Claims | null, params: string[], body: any }) => Promise<unknown> }} Route
 */

/**
 * The JSON API as a request handler (tests call it without a socket of their own).
 * @param {{
 *   config: { serviceSecret: string, version: string },
 *   service: import("./connections.mjs").ConnectionService,
 *   log: import("./log.mjs").Logger,
 *   now?: () => number,
 *   startedAt?: number,
 * }} deps
 */
export function createApiHandler(deps) {
  const { config, service, log, now = Date.now } = deps;
  const startedAt = deps.startedAt ?? now();
  const ID = "([0-9a-fA-F-]{36})";

  /** @type {Route[]} */
  const routes = [
    {
      // Public (Caddy publishes it): liveness only. Gateway counts and free slots are in /v1/health
      // for the super admin, so nobody can watch the slots run out from outside.
      method: "GET",
      pattern: /^\/health$/,
      auth: false,
      run: async () => ({ ok: true, version: config.version, uptimeSec: Math.floor((now() - startedAt) / 1000) }),
    },
    {
      method: "GET",
      pattern: /^\/v1\/health$/,
      auth: true,
      run: async ({ claims }) => {
        if (claims?.role !== "superadmin") throw forbidden("Only the platform owner can read service health.");
        return { ok: true, version: config.version, uptimeSec: Math.floor((now() - startedAt) / 1000), ...(await service.health()) };
      },
    },
    { method: "POST", pattern: /^\/v1\/etrade\/start$/, auth: true, run: ({ claims, body }) => service.startEtrade(/** @type {Claims} */ (claims), body) },
    { method: "POST", pattern: /^\/v1\/etrade\/verify$/, auth: true, run: ({ claims, body }) => service.verifyEtrade(/** @type {Claims} */ (claims), body) },
    { method: "POST", pattern: /^\/v1\/ibkr\/start$/, auth: true, run: ({ claims, body }) => service.startIbkr(/** @type {Claims} */ (claims), body) },
    { method: "POST", pattern: new RegExp(`^/v1/ibkr/${ID}/ticket$`), auth: true, run: ({ claims, params }) => service.ibkrTicket(/** @type {Claims} */ (claims), params[0]) },
    { method: "GET", pattern: new RegExp(`^/v1/connections/${ID}$`), auth: true, run: ({ claims, params }) => service.get(/** @type {Claims} */ (claims), params[0]) },
    { method: "POST", pattern: new RegExp(`^/v1/connections/${ID}/renew$`), auth: true, run: ({ claims, params }) => service.renew(/** @type {Claims} */ (claims), params[0]) },
    { method: "DELETE", pattern: new RegExp(`^/v1/connections/${ID}$`), auth: true, run: ({ claims, params }) => service.disconnect(/** @type {Claims} */ (claims), params[0]) },
    { method: "GET", pattern: /^\/v1\/portfolio$/, auth: true, run: ({ claims }) => service.portfolio(/** @type {Claims} */ (claims)) },
    { method: "GET", pattern: /^\/v1\/orders$/, auth: true, run: ({ claims }) => service.orders(/** @type {Claims} */ (claims)) },
    { method: "GET", pattern: /^\/v1\/executions$/, auth: true, run: ({ claims }) => service.executions(/** @type {Claims} */ (claims)) },
  ];

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function handle(req, res) {
    const started = now();
    const rid = randomUUID().slice(0, 8);
    const method = req.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://api.invalid").pathname;
    } catch {
      return sendJson(res, 400, { error: "Bad request." });
    }
    let status = 500;
    try {
      const matching = routes.filter((r) => r.pattern.test(pathname));
      if (!matching.length) throw new HttpError(404, "Not found.", { code: "no_route" });
      const route = matching.find((r) => r.method === method);
      if (!route) throw new HttpError(405, "Method not allowed.", { code: "method" });

      /** @type {Claims | null} */
      let claims = null;
      if (route.auth) {
        const token = bearerToken(req.headers.authorization);
        if (!token) throw unauthorized("The service token is missing.", "no_token");
        try {
          claims = verifyServiceJwt(token, config.serviceSecret, { now });
        } catch (e) {
          if (e instanceof JwtError) {
            log.info("service token rejected", { rid, reason: e.reason });
            throw unauthorized("The service token was not accepted.", "bad_token");
          }
          throw e;
        }
      }
      const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readJson(req) : {};
      const params = /** @type {RegExpExecArray} */ (route.pattern.exec(pathname)).slice(1);
      const out = await route.run({ claims, params, body });
      status = 200;
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        /** @type {Record<string, string>} */
        const headers = e.retryAfterSec ? { "retry-after": String(e.retryAfterSec) } : {};
        sendJson(res, e.status, { error: e.message, code: e.code }, headers);
      } else {
        status = 500;
        log.error("unhandled API error", { rid, method, path: pathname, error: e });
        sendJson(res, 500, { error: userMessage(e) });
      }
    } finally {
      // Health checks every few seconds would drown the log; they go at debug.
      const line = { rid, method, path: pathname.replace(/[0-9a-f-]{36}/gi, ":id"), status, ms: now() - started };
      if (pathname === "/health" && status === 200) log.debug("api", line);
      else log.info("api", line);
    }
  }

  return {
    /**
     * @param {import("node:http").IncomingMessage} req
     * @param {import("node:http").ServerResponse} res
     */
    handle(req, res) {
      handle(req, res).catch((e) => {
        log.error("api handler crashed", { error: e });
        sendJson(res, 500, { error: userMessage(e) });
      });
    },
  };
}

/**
 * Builds every part from the config. `overrides` lets tests swap the database, fetch, spawn, clock.
 * @param {import("./config.mjs").Config} config
 * @param {{
 *   db?: import("./db.mjs").Db,
 *   fetch?: typeof fetch,
 *   log?: import("./log.mjs").Logger,
 *   now?: () => number,
 *   spawn?: any,
 *   etradeUrls?: import("./etrade/client.mjs").EtradeUrls,
 *   signer?: import("./etrade/oauth1.mjs").OAuth1Signer,
 * }} [overrides]
 */
export function createBrokerService(config, overrides = {}) {
  const now = overrides.now ?? Date.now;
  const log = overrides.log ?? createLogger({ level: config.logLevel });
  const db = overrides.db ?? createDb({ url: config.supabaseUrl, serviceRoleKey: config.supabaseServiceRoleKey, fetch: overrides.fetch });
  const store = createStore(db);
  const secretBox = createSecretBox({ key: config.tokenKey, keyVersion: config.tokenKeyVersion, previousKeys: config.previousTokenKeys });
  const limiter = createLimiter({ ...config.limits, now });
  const cache = createCoalescingCache({ ttlMs: config.cacheMs, now });
  const audit = createAudit({ store, log, now });
  // One lock per connection for Connect, Reconnect, Disconnect, a gateway restart and a slot release.
  const locks = createLocks();
  const manager = createGatewayManager({
    bundle: config.ibkr.bundle,
    runtime: config.ibkr.runtime,
    ports: config.ibkr.ports,
    javaBin: config.ibkr.javaBin,
    xmx: config.ibkr.xmx,
    log: log.child({ part: "gateway" }),
    spawn: overrides.spawn,
    now,
  });
  const gw = createGatewayHttp({ isSlotPort: manager.isSlotPort, limiter });
  const sessions = createIbkrSessions({
    manager,
    gw,
    store,
    log: log.child({ part: "ibkr" }),
    cache,
    audit,
    locks,
    now,
    keepaliveMs: config.ibkr.keepaliveMs,
    sessionHours: config.ibkr.sessionHours,
  });
  const tokens = createLoginTokens(config.serviceSecret, { now });
  const ibkr = createIbkrAdapter({
    store,
    manager,
    sessions,
    gw,
    tokens,
    cache,
    locks,
    publicLoginUrl: config.publicLoginUrl,
    loginWindowMs: config.ibkr.loginWindowMs,
    maxPendingLogins: config.ibkr.maxPendingLogins,
    log: log.child({ part: "ibkr" }),
    now,
  });
  const etrade = createEtradeAdapter({
    store,
    secretBox,
    limiter,
    cache,
    log: log.child({ part: "etrade" }),
    allowSandbox: config.etrade.allowSandbox,
    now,
    urls: overrides.etradeUrls ?? config.etrade,
    fetch: overrides.fetch,
    signer: overrides.signer,
  });
  const service = createConnectionService({
    store,
    etrade,
    ibkr,
    sessions,
    manager,
    audit,
    cache,
    limiter,
    log,
    locks,
    steps: createWindowCounter({ now }),
    stepLimits: { connectPerUser: config.steps.connectPerUser, connectGlobalPerMin: config.steps.connectGlobalPerMin },
  });
  const scheduler = createScheduler({
    store,
    etrade,
    manager,
    sessions,
    audit,
    cache,
    log: log.child({ part: "scheduler" }),
    locks,
    now,
    releaseAfterExpiryMs: config.ibkr.releaseAfterExpiryMs,
  });
  const api = createApiHandler({ config, service, log, now });
  const login = createLoginProxy({
    tokens,
    resolvePort: (cid) => manager.portFor(cid),
    isSlotPort: manager.isSlotPort,
    whenReady: (cid) => manager.whenReady(cid),
    isAuthenticated: (cid) => sessions.isAuthenticated(cid),
    // Named on the confirmation page before any IBKR page is shown.
    describe: async (cid) => {
      const row = await store.getConnection(cid);
      if (!row || row.broker_id !== "ibkr" || row.status === "disconnected") return null;
      const [workspace, email] = await Promise.all([store.workspaceName(row.workspace_id), store.memberEmail(row.user_id)]);
      return { workspace, email };
    },
    cookieSecure: config.loginCookieSecure,
    appUrl: config.appUrl,
    log: log.child({ part: "login" }),
  });

  return { config, log, db, store, secretBox, limiter, cache, audit, locks, manager, gw, sessions, tokens, ibkr, etrade, service, scheduler, api, login };
}

/**
 * Starts both listeners and wires graceful shutdown (SIGINT, SIGTERM): stop taking requests, stop
 * the keepalives and the scheduler, stop every gateway JVM, then exit.
 * @param {import("./config.mjs").Config} config
 * @param {Parameters<typeof createBrokerService>[1]} [overrides]
 */
export async function startBrokerService(config, overrides = {}) {
  const svc = createBrokerService(config, overrides);
  const { log, manager, scheduler, sessions } = svc;

  if (!manager.bundleAvailable()) {
    log.warn("IBKR gateway bundle not found; IBKR connections answer 503 until IBKR_GATEWAY_BUNDLE points at it", {
      bundle: config.ibkr.bundle,
    });
  }
  await manager.cleanupRuntime();
  await scheduler.recoverOnBoot().catch((e) => log.warn("boot recovery failed", { error: e }));

  const apiServer = http.createServer({ requestTimeout: 60_000, headersTimeout: 20_000 }, (req, res) => svc.api.handle(req, res));
  const loginServer = http.createServer({ requestTimeout: 120_000, headersTimeout: 20_000 }, (req, res) => svc.login.handle(req, res));
  loginServer.on("upgrade", (req, socket) => svc.login.upgrade(req, socket));
  apiServer.keepAliveTimeout = 5_000;

  /** @param {http.Server} server @param {number} port @param {string} host */
  const listen = (server, port, host) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
  await listen(apiServer, config.apiPort, config.apiHost);
  await listen(loginServer, config.loginPort, config.loginHost);
  scheduler.start();
  log.info("broker service listening", {
    version: config.version,
    api: `${config.apiHost}:${config.apiPort}`,
    login: `${config.loginHost}:${config.loginPort}`,
    publicLoginUrl: config.publicLoginUrl,
    gatewaySlots: config.ibkr.ports.length,
  });

  let stopping = false;
  /** @param {string} reason */
  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { reason });
    scheduler.stop();
    sessions.stopAll();
    const closed = Promise.all([
      new Promise((r) => apiServer.close(() => r(undefined))),
      new Promise((r) => loginServer.close(() => r(undefined))),
    ]);
    apiServer.closeIdleConnections();
    loginServer.closeIdleConnections();
    await manager.stopAll();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 5_000).unref())]);
    apiServer.closeAllConnections();
    loginServer.closeAllConnections();
    log.info("stopped");
  }

  return { ...svc, apiServer, loginServer, stop };
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(78); // EX_CONFIG: systemd will not hammer restarts on a bad config
    }
    throw e;
  }
  const running = await startBrokerService(config);
  const { log, manager } = running;

  /**
   * Graceful stop. SIGINT and SIGTERM end with 0 (asked to stop). A crash ends with 1, so systemd's
   * Restart=on-failure brings the service back instead of leaving every connection offline.
   * @param {string} reason
   * @param {number} code
   */
  const shutdown = (reason, code) => {
    const hard = setTimeout(() => {
      log.error("shutdown took too long; exiting");
      manager.killAllSync();
      process.exit(1);
    }, 20_000);
    hard.unref();
    running.stop(reason).then(
      () => process.exit(code),
      (e) => {
        log.error("shutdown failed", { error: e });
        manager.killAllSync();
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT", 0));
  process.once("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("uncaughtException", (e) => {
    log.error("uncaught exception", { error: e });
    process.exitCode = 1;
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandled rejection", { error: e });
  });
  // Last resort: never leave a JVM behind when the process goes away.
  process.on("exit", () => manager.killAllSync());
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`broker service failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
