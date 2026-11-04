import http from "node:http";

/**
 * Calls from the service to a gateway on 127.0.0.1 (keepalive, bootstrap, reads).
 *
 * Lessons carried over from NOVA's proxy:
 * - a fresh loopback connection per request (keepAlive off): the Java gateway closes pooled sockets
 *   on its own schedule, and a reused socket returns the tail of one answer as the head of the next
 *   ("Parse Error: Expected HTTP/"); a GET is retried once when that happens
 * - every POST carries a body and a Content-Length: without one, IBKR's edge answers 411 / "Bad Request"
 */

// keepAlive off AND maxSockets left unbounded: with a finite maxSockets Node sends
// "Connection: keep-alive" and hands a finished socket to the next queued request, which is the
// exact reuse that broke NOVA's login page.
export const gatewayAgent = new http.Agent({ keepAlive: false });

export class GatewayHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, body?: string }} [opts]
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
 * @param {{
 *   isSlotPort: (port: number) => boolean,
 *   limiter?: import("../limits.mjs").Limiter,
 *   timeoutMs?: number,
 * }} opts
 */
export function createGatewayHttp({ isSlotPort, limiter, timeoutMs = 15_000 }) {
  /**
   * @param {number} port
   * @param {string} method
   * @param {string} path under /v1/api, e.g. "/iserver/auth/status"
   * @param {unknown} body
   * @returns {Promise<{ status: number, body: string, json: any }>}
   */
  function once(port, method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = method === "GET" ? null : Buffer.from(JSON.stringify(body ?? {}), "utf8");
      /** @type {Record<string, string | number>} */
      const headers = { accept: "application/json", "user-agent": "nasscord-broker" };
      if (payload) {
        headers["content-type"] = "application/json";
        headers["content-length"] = payload.length;
      }
      const req = http.request(
        { host: "127.0.0.1", port, method, path: `/v1/api${path}`, headers, agent: gatewayAgent, timeout: timeoutMs },
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

  /**
   * @param {string} connectionId for the rate limiter
   * @param {number} port
   * @param {"GET" | "POST" | "DELETE"} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(connectionId, port, method, path, body) {
    // The service only ever talks to its own gateways on loopback.
    if (!isSlotPort(port)) throw new GatewayHttpError(`port ${port} is not a gateway slot`, { code: "bad_port" });
    if (!path.startsWith("/") || path.includes("..")) throw new GatewayHttpError("bad path", { code: "bad_path" });
    if (limiter) await limiter.ibkr(connectionId);
    try {
      return await once(port, method, path, body);
    } catch (e) {
      if (method === "GET" && isParseError(e)) return once(port, method, path, body);
      throw e;
    }
  }

  return {
    request,
    /** @param {string} cid @param {number} port @param {string} path */
    get: (cid, port, path) => request(cid, port, "GET", path),
    /** @param {string} cid @param {number} port @param {string} path @param {unknown} [body] */
    post: (cid, port, path, body) => request(cid, port, "POST", path, body ?? {}),
  };
}

/** @typedef {ReturnType<typeof createGatewayHttp>} GatewayHttp */
