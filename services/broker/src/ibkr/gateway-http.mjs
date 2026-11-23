import http from "node:http";
import { ReadOnlyViolation } from "../errors.mjs";

/**
 * Calls from the service to a gateway on 127.0.0.1.
 *
 * Two doors, each with its own allowlist (docs/real-backend.md section 13):
 * - request() (and get / post): keepalive, bootstrap, reads and logout. IBKR_READ_ALLOW only.
 * - trade() and pacedGet(): the order calls of src/ibkr/orders.mjs, and nothing else calls them.
 *   IBKR_TRADE_ALLOW only. A logged-in gateway takes orders from whoever reaches its port, so a
 *   path that is not on a list never leaves the process (ReadOnlyViolation).
 *
 * Lessons carried over from NOVA's proxy:
 * - a fresh loopback connection per request (keepAlive off): the Java gateway closes pooled sockets
 *   on its own schedule, and a reused socket returns the tail of one answer as the head of the next
 *   ("Parse Error: Expected HTTP/"); a GET is retried once when that happens (never a POST or a
 *   DELETE, and never a paced path)
 * - every POST carries a body and a Content-Length: without one, IBKR's edge answers 411 / "Bad Request"
 *
 * IBKR allows one call per 5 s to /iserver/account/orders and /iserver/account/trades per session,
 * and a violation can put the whole server address in IBKR's penalty box. Both paths go through one
 * pacing gate per connection, shared by reads and order calls (answers are reused, a 429 is never
 * retried).
 */

// keepAlive off AND maxSockets left unbounded: with a finite maxSockets Node sends
// "Connection: keep-alive" and hands a finished socket to the next queued request, which is the
// exact reuse that broke NOVA's login page.
export const gatewayAgent = new http.Agent({ keepAlive: false });

export class GatewayHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: string }} [opts]
   *   code "not_sent", "bad_port" or "bad_path": nothing left the process. "paced": the pacing gate
   *   refused before calling. "timeout" or "socket": the call may have reached the gateway.
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "GatewayHttpError";
    this.status = opts.status ?? 0;
    this.code = opts.code ?? "";
    this.body = opts.body ?? "";
  }
}

/** @param {unknown} err */
export const isParseError = (err) => {
  const e = /** @type {{ code?: string, message?: string }} */ (err);
  return !!e && (String(e.code ?? "").startsWith("HPE_") || /Parse Error/i.test(e.message ?? ""));
};

/**
 * @typedef {readonly [string, RegExp, RegExp | null]} GatewayRule
 *   method, the whole pathname, and the whole query (null: no query allowed).
 */

const READ_ACCT = "[A-Za-z0-9]{1,32}";
/** What request() may call: session upkeep and the reads of the read path. @type {ReadonlyArray<GatewayRule>} */
export const IBKR_READ_ALLOW = Object.freeze([
  ["GET", /^\/iserver\/auth\/status$/, null],
  ["POST", /^\/iserver\/auth\/ssodh\/init$/, null],
  ["POST", /^\/tickle$/, null],
  ["POST", /^\/logout$/, null],
  ["GET", /^\/iserver\/accounts$/, null],
  ["GET", /^\/portfolio\/accounts$/, null],
  ["GET", /^\/iserver\/account\/pnl\/partitioned$/, null],
  ["GET", new RegExp(`^/portfolio/${READ_ACCT}/summary$`), null],
  ["GET", new RegExp(`^/portfolio/${READ_ACCT}/positions/[0-9]{1,3}$`), null],
  ["GET", /^\/iserver\/account\/orders$/, null],
  ["GET", /^\/iserver\/account\/trades$/, /^days=[1-7]$/],
]);

const ACCT = "[A-Z0-9]{2,20}";
const CONID = "[1-9][0-9]{0,11}";
const ORDER_ID = "[1-9][0-9]{0,18}";
/** What trade() and pacedGet() may call: the order path of src/ibkr/orders.mjs. @type {ReadonlyArray<GatewayRule>} */
export const IBKR_TRADE_ALLOW = Object.freeze([
  ["GET", /^\/iserver\/auth\/status$/, null],
  ["GET", /^\/iserver\/accounts$/, null],
  ["GET", /^\/trsrv\/stocks$/, /^symbols=[A-Z]{1,5}$/],
  ["GET", new RegExp(`^/iserver/contract/${CONID}/info$`), null],
  ["POST", /^\/iserver\/contract\/rules$/, null],
  ["GET", /^\/iserver\/marketdata\/snapshot$/, new RegExp(`^conids=${CONID}&fields=31,84,86$`)],
  ["GET", new RegExp(`^/portfolio2/${ACCT}/positions$`), null],
  ["POST", new RegExp(`^/iserver/account/${ACCT}/orders/whatif$`), null],
  ["POST", new RegExp(`^/iserver/account/${ACCT}/orders$`), null],
  ["POST", /^\/iserver\/reply\/[0-9a-fA-F-]{36}$/, null],
  ["GET", new RegExp(`^/iserver/account/order/status/${ORDER_ID}$`), null],
  ["DELETE", new RegExp(`^/iserver/account/${ACCT}/order/${ORDER_ID}$`), null],
  ["GET", /^\/iserver\/account\/orders$/, null],
  ["GET", /^\/iserver\/account\/trades$/, /^days=[1-7]$/],
]);

/** IBKR allows one call per 5 s to these, per session (pacing table); a violation can block the whole server address. */
export const PACED_PATHS = Object.freeze(["/iserver/account/orders", "/iserver/account/trades"]);

/** The calls that change something at IBKR: an order, a reply to an order question, a cancel. @type {ReadonlyArray<readonly [string, RegExp]>} */
const ORDER_WRITES = Object.freeze([
  ["POST", new RegExp(`^/iserver/account/${ACCT}/orders$`)],
  ["POST", /^\/iserver\/reply\/[0-9a-fA-F-]{36}$/],
  ["DELETE", new RegExp(`^/iserver/account/${ACCT}/order/${ORDER_ID}$`)],
]);

/** IBKR's pacing window of a paced path: an answer younger than this is reused. */
export const PACE_MS = 5_000;
/**
 * The gap between two calls of a paced path: IBKR's 5 s plus a margin, because IBKR counts when a
 * call arrives and the way there (the gateway, the network) does not take the same time each call.
 */
const PACE_GAP_MS = 5_500;
/** After IBKR answered 429 on a paced path, the next call waits this long from the refused one. */
const PACE_AFTER_429_MS = 15_000;
/** A read waits at most this long for an order reply in flight on its connection. */
const HOLD_MAX_MS = 20_000;
/** Waits for the pacing gate are taken in steps this short, so the clock is read again often. */
const POLL_MS = 100;

const BAD_GATEWAY_PATH = /(^|\/)\.\.?(\/|$)|\/\/|\\|[?#\s\x00-\x1f]|%2e|%2f|%5c/i;
const BAD_QUERY = /[#?\s\x00-\x1f]/;

/** @param {string} path */
function splitPath(path) {
  const i = path.indexOf("?");
  return i < 0 ? { pathname: path, query: "" } : { pathname: path.slice(0, i), query: path.slice(i + 1) };
}

/**
 * The rule must cover the whole text.
 * @param {RegExp} re @param {string} s
 */
function fullMatch(re, s) {
  const m = new RegExp(re.source, re.flags.replace(/[gy]/g, "")).exec(s);
  return !!m && m.index === 0 && m[0].length === s.length;
}

/**
 * Whether `method path` is on `allow`. The pathname must match a rule as a whole and hold no dot
 * segment, double slash, backslash, encoded dot, slash or backslash, whitespace or control
 * character; the query must match the rule's query pattern as a whole (a rule without one allows
 * no query) and hold no "#", "?", whitespace or control character.
 * @param {ReadonlyArray<GatewayRule>} allow
 * @param {string} method
 * @param {string} path
 */
export function isGatewayAllowed(allow, method, path) {
  if (typeof path !== "string" || typeof method !== "string" || !path.startsWith("/")) return false;
  const { pathname, query } = splitPath(path);
  if (BAD_GATEWAY_PATH.test(pathname) || BAD_QUERY.test(query)) return false;
  const m = method.toUpperCase();
  return allow.some(([am, re, qre]) => am === m && fullMatch(re, pathname) && (qre === null ? query === "" : fullMatch(qre, query)));
}

/** @param {string} method @param {string} pathname */
const isOrderWrite = (method, pathname) => ORDER_WRITES.some(([m, re]) => m === method && fullMatch(re, pathname));

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @typedef {{ status: number, body: string, json: any }} GatewayAnswer
 * @typedef {GatewayAnswer & { at: number, first: boolean }} PacedAnswer
 *   at: when its call started. first: it was the first call of that path in the session (IBKR's
 *   pre-flight answer, which is not a complete list).
 * @typedef {{ path: string, createdAt: number, promise: Promise<PacedAnswer> }} PacedCall
 * @typedef {{ nextAt: number, calls: number, gen: number, inflight: PacedCall | null, answers: Map<string, PacedAnswer> }} PaceState
 */

/**
 * @param {{
 *   isSlotPort: (port: number) => boolean,
 *   limiter?: import("../limits.mjs").Limiter,
 *   timeoutMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: import("../log.mjs").Logger | null,
 * }} opts
 *   now: the service clock (the pacing gate and the order-write times use it).
 */
export function createGatewayHttp({ isSlotPort, limiter, timeoutMs = 15_000, now = Date.now, sleep = defaultSleep, log = null }) {
  /** @type {Map<string, Map<string, PaceState>>} per connection, per paced pathname */
  const pacing = new Map();
  /** @type {Map<string, number>} when the last order write of a connection was about to be sent */
  const lastWriteAt = new Map();
  /** @type {Map<string, { count: number, done: Promise<void>, release: () => void }>} */
  const holds = new Map();

  /**
   * @param {number} port
   * @param {string} method
   * @param {string} path under /v1/api, e.g. "/iserver/auth/status"
   * @param {unknown} body
   * @param {number} [ms] the socket timeout
   * @returns {Promise<GatewayAnswer>}
   */
  function once(port, method, path, body, ms = timeoutMs) {
    return new Promise((resolve, reject) => {
      // GET and DELETE carry no body (IBKR's cancel takes none); a POST always carries one.
      const payload = method === "GET" || method === "DELETE" ? null : Buffer.from(JSON.stringify(body ?? {}), "utf8");
      /** @type {Record<string, string | number>} */
      const headers = { accept: "application/json", "user-agent": "nasscord-broker" };
      if (payload) {
        headers["content-type"] = "application/json";
        headers["content-length"] = payload.length;
      } else if (method === "DELETE") {
        headers["content-length"] = 0;
      }
      const req = http.request(
        // insecureHTTPParser: the gateway sends bytes after `Connection: close` (loopback only).
        { host: "127.0.0.1", port, method, path: `/v1/api${path}`, headers, agent: gatewayAgent, timeout: ms, insecureHTTPParser: true },
        (res) => {
          /** @type {Buffer[]} */
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json = null;
            if (text) {
              try {
                json = JSON.parse(text);
              } catch {
                /* not JSON (an HTML error page) */
              }
            }
            resolve({ status: res.statusCode ?? 0, body: text, json });
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new GatewayHttpError("gateway timeout", { code: "timeout" })));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** @param {unknown} e */
  const asGatewayError = (e) =>
    e instanceof GatewayHttpError ? e : new GatewayHttpError(e instanceof Error ? e.message : "gateway call failed", { code: "socket" });

  // ───────────────────────────── holding reads while an order waits for its reply

  /**
   * Runs `fn` while request() calls of this connection wait (IBKR: "submitting other requests
   * will cancel the order" while a reply is pending). Each held read waits at most 20 s.
   * @template T
   * @param {string} cid
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function holdReads(cid, fn) {
    let h = holds.get(cid);
    if (!h) {
      /** @type {() => void} */
      let release = () => {};
      const done = new Promise((r) => {
        release = () => r(undefined);
      });
      h = { count: 0, done: /** @type {Promise<void>} */ (done), release };
      holds.set(cid, h);
    }
    h.count++;
    try {
      return await fn();
    } finally {
      h.count--;
      if (h.count === 0) {
        if (holds.get(cid) === h) holds.delete(cid);
        h.release();
      }
    }
  }

  /** @param {string} cid */
  async function waitForHold(cid) {
    const h = holds.get(cid);
    if (!h) return;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const timedOut = new Promise((r) => {
      timer = setTimeout(() => r(true), HOLD_MAX_MS);
    });
    const late = await Promise.race([h.done.then(() => false), timedOut]);
    clearTimeout(timer);
    if (late) log?.warn("read waited for an order reply", { connectionId: cid });
  }

  // ───────────────────────────── pacing gate

  /** @param {string} cid @param {string} pathname @returns {PaceState} */
  function paceState(cid, pathname) {
    let byPath = pacing.get(cid);
    if (!byPath) {
      byPath = new Map();
      pacing.set(cid, byPath);
    }
    let st = byPath.get(pathname);
    if (!st) {
      st = { nextAt: 0, calls: 0, gen: 0, inflight: null, answers: new Map() };
      byPath.set(pathname, st);
    }
    return st;
  }

  /**
   * A new brokerage session starts with IBKR's pre-flight again: kept answers go and the next call
   * counts as the first. The time of the next allowed call is kept (the safe side of IBKR's pacing).
   * @param {string} cid
   */
  function newSession(cid) {
    const byPath = pacing.get(cid);
    if (!byPath) return;
    for (const st of byPath.values()) {
      st.calls = 0;
      st.gen += 1;
      st.answers.clear();
    }
  }

  /**
   * Starts the one call of a paced path. Its promise rejects with the limiter's refusal (a reader)
   * or GatewayHttpError "not_sent" (order code) when no token was given: then no call was made.
   * @param {string} cid @param {number} port @param {PaceState} st @param {string} path
   * @param {"read" | "trade"} who
   * @returns {PacedCall}
   */
  function startCall(cid, port, st, path, who) {
    const gen = st.gen;
    const promise = (async () => {
      if (limiter) {
        try {
          await limiter.ibkr(cid);
        } catch (e) {
          if (who === "trade") throw new GatewayHttpError("rate limited before sending", { code: "not_sent" });
          throw e;
        }
      }
      const at = now();
      const first = st.calls === 0;
      st.calls += 1;
      st.nextAt = Math.max(st.nextAt, at + PACE_GAP_MS);
      /** @type {GatewayAnswer} */
      let res;
      try {
        res = await once(port, "GET", path, undefined);
      } catch (e) {
        throw asGatewayError(e);
      }
      if (res.status === 429) st.nextAt = Math.max(st.nextAt, at + PACE_AFTER_429_MS);
      /** @type {PacedAnswer} */
      const answer = { status: res.status, body: res.body, json: res.json, at, first };
      if (st.gen === gen) st.answers.set(path, answer);
      return answer;
    })();
    /** @type {PacedCall} */
    const call = { path, createdAt: now(), promise };
    st.inflight = call;
    const clear = () => {
      if (st.inflight === call) st.inflight = null;
    };
    promise.then(clear, clear);
    return call;
  }

  /**
   * A read of a paced path (request()): the last answer when it is younger than 5 s, a call in
   * flight, or the next slot when it opens within 5 s; otherwise the last answer whatever its age.
   * @param {string} cid @param {number} port @param {string} path
   * @returns {Promise<GatewayAnswer>}
   */
  async function pacedRead(cid, port, path) {
    const { pathname } = splitPath(path);
    for (;;) {
      const st = paceState(cid, pathname);
      const t = now();
      const last = st.answers.get(path);
      if (last && t - last.at < PACE_MS) return last;
      const flight = st.inflight;
      if (flight) {
        if (flight.path === path) return flight.promise;
        await flight.promise.catch(() => {});
        continue;
      }
      const wait = st.nextAt - t;
      if (wait <= 0) return startCall(cid, port, st, path, "read").promise;
      if (wait <= PACE_GAP_MS) {
        await sleep(Math.min(wait, POLL_MS));
        continue;
      }
      if (last) return last;
      throw new GatewayHttpError("paced", { code: "paced" });
    }
  }

  /**
   * A paced read for order code: only an answer whose call started after `notBefore` and after the
   * connection's last order write. Takes the last answer when it qualifies and is younger than 5 s,
   * joins a qualifying call in flight, otherwise waits for the next slot when it opens within
   * `maxWaitMs` and calls. A slot further away throws GatewayHttpError "paced" without calling.
   * @param {string} cid
   * @param {number} port
   * @param {string} path "/iserver/account/orders" or "/iserver/account/trades?days=N"
   * @param {{ notBefore?: number, maxWaitMs?: number }} [opts]
   * @returns {Promise<PacedAnswer>}
   */
  async function pacedGet(cid, port, path, { notBefore = 0, maxWaitMs = 0 } = {}) {
    if (!isSlotPort(port)) throw new GatewayHttpError(`port ${port} is not a gateway slot`, { code: "bad_port" });
    if (!isGatewayAllowed(IBKR_TRADE_ALLOW, "GET", path)) throw new ReadOnlyViolation("IBKR", "GET");
    const { pathname } = splitPath(path);
    if (!PACED_PATHS.includes(pathname)) throw new GatewayHttpError("not a paced path", { code: "bad_path" });
    const written = lastWriteAt.get(cid);
    // Strictly after the write: a call started in the same millisecond may have gone out before it.
    const nb = Math.max(notBefore, written === undefined ? 0 : written + 1);
    const until = now() + Math.max(0, maxWaitMs);
    for (;;) {
      const st = paceState(cid, pathname);
      const t = now();
      const last = st.answers.get(path);
      if (last && last.at >= nb && t - last.at < PACE_MS) return last;
      const flight = st.inflight;
      if (flight) {
        if (flight.path === path && flight.createdAt >= nb) {
          try {
            return await flight.promise;
          } catch (e) {
            throw e instanceof GatewayHttpError ? e : new GatewayHttpError("rate limited before sending", { code: "not_sent" });
          }
        }
        const left = until - t;
        if (left <= 0) throw new GatewayHttpError("paced", { code: "paced" });
        await Promise.race([flight.promise.catch(() => {}), sleep(Math.min(left, POLL_MS))]);
        continue;
      }
      const wait = st.nextAt - t;
      if (wait <= 0) return startCall(cid, port, st, path, "trade").promise;
      if (t + wait <= until) {
        await sleep(Math.min(wait, POLL_MS));
        continue;
      }
      throw new GatewayHttpError("paced", { code: "paced" });
    }
  }

  // ───────────────────────────── the two doors

  /**
   * Keepalive, bootstrap, reads and logout (IBKR_READ_ALLOW). Waits while an order reply of the
   * same connection is in flight (at most 20 s per call).
   * @param {string} connectionId for the rate limiter
   * @param {number} port
   * @param {"GET" | "POST" | "DELETE"} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<GatewayAnswer>}
   */
  async function request(connectionId, port, method, path, body) {
    // The service only ever talks to its own gateways on loopback.
    if (!isSlotPort(port)) throw new GatewayHttpError(`port ${port} is not a gateway slot`, { code: "bad_port" });
    if (!isGatewayAllowed(IBKR_READ_ALLOW, method, path)) throw new ReadOnlyViolation("IBKR", method);
    const { pathname } = splitPath(path);
    // The service never takes the brokerage session from TWS or the mobile app.
    if (method === "POST" && pathname === "/iserver/auth/ssodh/init" && /** @type {any} */ (body)?.compete === true) {
      throw new ReadOnlyViolation("IBKR", method);
    }
    await waitForHold(connectionId);
    if (method === "GET" && PACED_PATHS.includes(pathname)) return pacedRead(connectionId, port, path);
    if (limiter) await limiter.ibkr(connectionId);
    /** @type {GatewayAnswer} */
    let res;
    try {
      res = await once(port, method, path, body);
    } catch (e) {
      if (method === "GET" && isParseError(e)) res = await once(port, method, path, body);
      else throw e;
    }
    if ((pathname === "/iserver/auth/ssodh/init" && res.status >= 200 && res.status < 300) || pathname === "/logout") {
      newSession(connectionId);
    }
    return res;
  }

  /**
   * The order door (IBKR_TRADE_ALLOW), called only by src/ibkr/orders.mjs. Sends once: a GET is
   * retried once on a parse error, a POST or a DELETE never. Paced paths go through pacedGet.
   * Throws GatewayHttpError "not_sent" (the limiter refused, or no time was left), "bad_port",
   * "bad_path", or a ReadOnlyViolation before anything leaves the process; "timeout" or "socket"
   * after the call started.
   * @param {string} cid
   * @param {number} port
   * @param {"GET" | "POST" | "DELETE"} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ timeoutMs?: number, notAfter?: number, minLeftMs?: number }} [opts]
   *   notAfter: the caller's deadline (service clock). The time left is computed again after the
   *   limiter's wait: under `minLeftMs` (default 1 ms) nothing is sent ("not_sent"), else the socket
   *   timeout is at most what is left, so no step starts after the deadline (design 1.10).
   * @returns {Promise<GatewayAnswer>}
   */
  async function trade(cid, port, method, path, body, { timeoutMs = 20_000, notAfter, minLeftMs = 1 } = {}) {
    let ms = timeoutMs;
    if (!isSlotPort(port)) throw new GatewayHttpError(`port ${port} is not a gateway slot`, { code: "bad_port" });
    if (!isGatewayAllowed(IBKR_TRADE_ALLOW, method, path)) throw new ReadOnlyViolation("IBKR", method);
    const { pathname } = splitPath(path);
    if (method === "GET" && PACED_PATHS.includes(pathname)) throw new GatewayHttpError("use pacedGet", { code: "bad_path" });
    // A socket timeout of 0 would mean no timeout at all.
    if (!(ms >= 1)) throw new GatewayHttpError("no time left before sending", { code: "not_sent" });
    if (limiter) {
      try {
        await limiter.ibkr(cid);
      } catch {
        throw new GatewayHttpError("rate limited before sending", { code: "not_sent" });
      }
    }
    if (typeof notAfter === "number" && Number.isFinite(notAfter)) {
      // The limiter may have waited (a back-off after a 429, a busy bucket): measure again.
      const left = notAfter - now();
      if (!(left >= Math.max(1, minLeftMs))) throw new GatewayHttpError("no time left before sending", { code: "not_sent" });
      ms = Math.min(ms, left);
    }
    if (isOrderWrite(method, pathname)) lastWriteAt.set(cid, now());
    try {
      return await once(port, method, path, body, ms);
    } catch (e) {
      if (method === "GET" && isParseError(e)) {
        try {
          return await once(port, method, path, body, ms);
        } catch (e2) {
          throw asGatewayError(e2);
        }
      }
      throw asGatewayError(e);
    }
  }

  return {
    request,
    /** @param {string} cid @param {number} port @param {string} path */
    get: (cid, port, path) => request(cid, port, "GET", path),
    /** @param {string} cid @param {number} port @param {string} path @param {unknown} [body] */
    post: (cid, port, path, body) => request(cid, port, "POST", path, body ?? {}),
    trade,
    pacedGet,
    holdReads,
  };
}

/** @typedef {ReturnType<typeof createGatewayHttp>} GatewayHttp */
