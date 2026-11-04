import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

/**
 * A stand-in for the IBKR Client Portal Gateway, started by a fake `spawn` so the real gateway
 * manager, keepalive, adapter and login proxy all run against it. It reads its port from the
 * conf.yaml the manager rendered, like the real JVM does.
 */

export const GATEWAY_TEMPLATE = `    ip2loc: "US"
    proxyRemoteHost: "https://api.ibkr.com"
    listenPort: 5000
    listenSsl: true
    sslCert: "vertx.jks"
    sslPwd: "test-only-password"
    ips:
      allow:
        - 192.*
        - 127.0.0.1
      deny:
        - 212.90.324.10
`;

/** A folder shaped like the gateway bundle (no real jars needed with the fake spawn). */
export function fakeBundle() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nasscord-bundle-"));
  mkdirSync(path.join(dir, "root"));
  mkdirSync(path.join(dir, "dist"));
  mkdirSync(path.join(dir, "build", "lib", "runtime"), { recursive: true });
  writeFileSync(path.join(dir, "root", "conf.yaml"), GATEWAY_TEMPLATE);
  writeFileSync(path.join(dir, "dist", "ibgroup.web.core.iblink.router.clientportal.gw.jar"), "");
  return dir;
}

/** @param {number} n @param {string} acct */
const positions = (n, acct, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    acctId: acct,
    conid: 1000 + offset + i,
    contractDesc: `SYM${offset + i}`,
    ticker: `SYM${offset + i}`,
    position: 10,
    mktPrice: 50,
    mktValue: 500,
    currency: "USD",
    avgCost: 45,
    avgPrice: 45,
    unrealizedPnl: 50,
    assetClass: "STK",
  }));

export function createGatewayState() {
  return {
    /** the user finished the IBKR login page */
    loggedIn: false,
    competing: false,
    /** ssodh/init has opened the brokerage session */
    bridge: false,
    /** @type {Array<{ method: string, path: string, body: string, headers: http.IncomingHttpHeaders }>} */
    requests: [],
    /** @type {any[]} */
    procs: [],
    accounts: ["U1234567", "U7654321"],
    /** accounts whose /portfolio/{acct}/summary answers 500 */
    /** @type {Set<string>} */
    failSummary: new Set(),
    /** how long a killed JVM takes to exit (a real one can take seconds) */
    exitDelayMs: 0,
  };
}

/**
 * @param {ReturnType<typeof createGatewayState>} state
 * @returns {http.RequestListener}
 */
function handler(state) {
  return (req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://gw.invalid");
      const p = url.pathname;
      const body = Buffer.concat(chunks).toString();
      state.requests.push({ method: req.method ?? "", path: `${p}${url.search}`, body, headers: req.headers });
      /** @param {number} status @param {unknown} json */
      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };
      if (req.method === "POST" && req.headers["content-length"] === undefined) {
        res.writeHead(411, { "content-type": "text/html" });
        return res.end("<HTML><TITLE>Bad Request</TITLE></HTML>");
      }
      if (p === "/") {
        res.writeHead(302, { location: "/sso/Login?forwardTo=22&RL=1&ip2loc=US" });
        return res.end();
      }
      if (p === "/sso/Login") {
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "JSESSIONID=J; Path=/sso; HttpOnly;Secure;SameSite=None" });
        return res.end('<html><title>Login</title><div class="loginformWrapper"></div></html>');
      }
      if (!p.startsWith("/v1/api/")) return send(404, { error: "no" });
      const api = p.slice("/v1/api".length);
      if (api === "/tickle") return send(state.loggedIn ? 200 : 401, state.loggedIn ? { session: "x", iserver: { authStatus: { authenticated: state.bridge } } } : undefined);
      if (api === "/iserver/auth/status") {
        if (!state.loggedIn) return send(401, undefined);
        return send(200, { authenticated: !state.competing, competing: state.competing, connected: true, message: "", MAC: "00:00", serverInfo: {} });
      }
      if (!state.loggedIn) return send(401, undefined);
      if (api === "/iserver/auth/ssodh/init") {
        state.bridge = true;
        return send(200, { authenticated: true, competing: false, connected: true });
      }
      if (api === "/logout") {
        state.loggedIn = false;
        state.bridge = false;
        return send(200, { status: true });
      }
      if (api === "/iserver/accounts") {
        if (!state.bridge) return send(400, { error: "no bridge" });
        return send(200, { accounts: state.accounts, aliases: { U7654321: "Swing" }, selectedAccount: state.accounts[0] });
      }
      if (api === "/portfolio/accounts") {
        return send(200, state.accounts.map((id) => ({ id, accountId: id, accountAlias: null, desc: id, type: "INDIVIDUAL", tradingType: id === "U1234567" ? "STKMRGN" : "STKCASH", currency: "USD" })));
      }
      let m = /^\/portfolio\/([^/]+)\/summary$/.exec(api);
      if (m) {
        if (state.failSummary.has(m[1])) return send(500, { error: "internal" });
        return send(200, {
          netliquidation: { amount: m[1] === "U1234567" ? 250000.5 : 10000, currency: "USD" },
          buyingpower: { amount: 1000000 },
          totalcashvalue: { amount: 50000 },
        });
      }
      m = /^\/portfolio\/([^/]+)\/positions\/(\d+)$/.exec(api);
      if (m) {
        if (m[1] !== "U1234567") return send(200, []);
        const page = Number(m[2]);
        return send(200, page === 0 ? positions(30, m[1]) : page === 1 ? positions(2, m[1], 30) : []);
      }
      if (api === "/iserver/account/pnl/partitioned") return send(200, { upnl: { "U1234567.Core": { rowType: 1, dpl: 812.5, nl: 250000.5, upl: 1500 } } });
      if (api === "/iserver/account/orders") {
        if (!state.bridge) return send(400, { error: "no bridge" });
        return send(200, {
          orders: [
            { acct: "U1234567", orderId: 1290035, ticker: "AVGO", side: "SELL", totalSize: 12, filledQuantity: 0, remainingQuantity: 12, orderType: "Limit", price: "189.9", timeInForce: "GTC", status: "Submitted", lastExecutionTime_r: Date.parse("2026-11-03T14:30:00Z") },
            { acct: "U9999999", orderId: 1, ticker: "XYZ", side: "BUY", totalSize: 1, orderType: "Market", status: "Filled" },
          ],
          snapshot: true,
        });
      }
      if (api === "/iserver/account/trades") {
        return send(200, [
          { execution_id: "0000e0d5.6543.01.01", symbol: "AVGO", side: "B", size: 12, price: "172.77", commission: "1.00", net_amount: 2073.24, account: "U1234567", trade_time_r: Date.parse("2026-11-03T14:20:00Z") },
          { execution_id: "other", symbol: "XYZ", side: "S", size: 1, price: "1", account: "U9999999", trade_time_r: 1 },
        ]);
      }
      return send(404, { error: `no route ${api}` });
    });
  };
}

/**
 * `spawn` replacement: listens on the port from <cwd>/conf.yaml and behaves like a gateway.
 * @param {ReturnType<typeof createGatewayState>} state
 */
export function fakeGatewaySpawner(state) {
  let pid = 5000;
  /** @param {string} _cmd @param {string[]} _args @param {{ cwd: string }} opts */
  return (_cmd, _args, opts) => {
    const conf = readFileSync(path.join(opts.cwd, "conf.yaml"), "utf8");
    const port = Number(/listenPort:\s*(\d+)/.exec(conf)?.[1]);
    const p = /** @type {any} */ (new EventEmitter());
    p.pid = ++pid;
    p.port = port;
    p.exitCode = null;
    p.signalCode = null;
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    const server = http.createServer(handler(state));
    server.on("error", (e) => p.emit("error", e));
    server.listen(port, "127.0.0.1", () => p.emit("spawn"));
    /** @param {number | null} code @param {string | null} sig */
    const exit = (code, sig) => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      server.closeAllConnections();
      server.close(() => {
        p.exitCode = code;
        p.signalCode = sig;
        p.emit("exit", code, sig);
      });
    };
    p.kill = (/** @type {string} */ sig = "SIGTERM") => {
      if (state.exitDelayMs) setTimeout(() => exit(null, sig), state.exitDelayMs);
      else exit(null, sig);
      return true;
    };
    p.crash = () => exit(1, null);
    state.procs.push(p);
    return p;
  };
}

/**
 * Two adjacent free ports for the slot range.
 * @returns {Promise<number[]>}
 */
export async function freePorts(count = 2) {
  const net = await import("node:net");
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 40000 + Math.floor(Math.random() * 20000);
    const ports = Array.from({ length: count }, (_, i) => base + i);
    const ok = await Promise.all(
      ports.map(
        (port) =>
          new Promise((resolve) => {
            const s = net.createServer();
            s.once("error", () => resolve(false));
            s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
          }),
      ),
    );
    if (ok.every(Boolean)) return ports;
  }
  throw new Error("no free ports");
}
