import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { isParseError } from "./gateway-http.mjs";

/**
 * The public IBKR login host (contract section 7, LOGIN_PORT / PUBLIC_LOGIN_URL).
 *
 * GET  /start?t=<ticket>  checks the ticket WITHOUT using it and shows a confirmation page naming the
 *                         Nasscord workspace and the (masked) email of the user who pressed Connect,
 *                         with a Continue button. Nothing of IBKR is shown yet.
 * POST /start (t=<ticket>) same-origin only: uses the one-time ticket (2 minutes) -> cookie
 *                         nsibkr=<cid>.<exp>.<sig> -> redirect to /
 * everything else         routed by that cookie to the connection's gateway on 127.0.0.1, through an
 *                         allowlist of the login paths only. Any other /v1/api path is a 403 here.
 *
 * Why the confirmation: the login link is a bearer link. Whoever opens it gets IBKR's real login
 * page, and whatever IBKR login happens there is attached to the workspace of the user who made the
 * link. Someone could send their link to another person ("connect your IBKR to Nasscord") and read
 * that person's account. The page says whose workspace this is and tells anyone who did not just
 * press Connect to close it; the short ticket life narrows the window; the same-origin check keeps
 * another site from submitting the Continue form for the victim.
 *
 * Proxy hardening ported from NOVA (quant-forge-os/server-proxy.cjs):
 * - X-Forwarded-For, X-Real-IP and X-Forwarded-Host are stripped. The gateway keys its session on
 *   the client address it sees; with the browser's real IP passed along, the browser and the
 *   service's keepalive saw two different sessions and fought over it.
 * - a fresh loopback connection per request (keepAlive off) and one GET retry on a parse error:
 *   the Java gateway closes pooled sockets on its own, which showed up as "Parse Error: Expected
 *   HTTP/" and a login page without its CSS and JS.
 * - Set-Cookie becomes host-only (Domain dropped, Path=/), Location becomes relative.
 * - only 127.0.0.1 and only slot ports are ever proxied to.
 *
 * Login allowlist (found by loading the real gateway's login page, 2026-11-03):
 *   GET  /                                   302 -> /sso/Login?forwardTo=22&RL=1&ip2loc=US
 *   GET/POST /sso/...                        Login, lib/xyz.bundle.min.js, Authenticator, Dispatcher, report, ping
 *   GET  /css/..., /scripts/..., /images/..., /fonts/..., /stylesheet/...   page assets
 *   POST /portal.proxy/v1/gstat/bulletins    maintenance notice on the login form
 *   GET  /v1/api/iserver/auth/status         login state
 */

export const LOGIN_COOKIE = "nsibkr";
/** The app opens the login link right away; a forwarded link dies quickly. */
export const TICKET_TTL_MS = 2 * 60_000;
export const COOKIE_TTL_MS = 60 * 60_000;
const MAX_POST_BYTES = 64 * 1024;
const MAX_FORM_BYTES = 4 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ─────────────────────────────────────────────────────────── tickets and cookies

/**
 * HMAC-SHA256 with BROKER_SERVICE_SECRET. Every message starts with its own label, so a ticket,
 * a cookie and a service JWT (whose signing input starts with "eyJ") can never stand in for
 * one another.
 * @param {string | Buffer} secret
 * @param {{ now?: () => number }} [opts]
 */
export function createLoginTokens(secret, opts = {}) {
  const now = opts.now ?? Date.now;
  /** @type {Map<string, number>} ticket nonce -> exp (ms), to make tickets one-time */
  const used = new Map();

  /** @param {string} msg */
  const mac = (msg) => createHmac("sha256", secret).update(msg).digest();
  /** @param {Buffer} a @param {Buffer} b */
  const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

  function sweep() {
    const t = now();
    for (const [n, exp] of used) if (exp < t) used.delete(n);
  }

  /**
   * A ticket's payload when its signature and expiry check out and it has not been used.
   * @param {unknown} ticket
   * @returns {{ cid: string, exp: number, n: string } | null}
   */
  function check(ticket) {
    if (typeof ticket !== "string" || ticket.length > 512) return null;
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(ticket);
    if (!m) return null;
    if (!same(Buffer.from(m[2], "base64url"), mac(`nsibkr-ticket.v1.${m[1]}`))) return null;
    let body;
    try {
      body = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!body || typeof body.cid !== "string" || !UUID.test(body.cid) || !Number.isInteger(body.exp) || typeof body.n !== "string") {
      return null;
    }
    if (body.exp * 1000 <= now()) return null;
    if (used.has(body.n)) return null;
    return body;
  }

  return {
    /**
     * @param {string} cid connection id
     * @param {number} [ttlMs]
     */
    issueTicket(cid, ttlMs = TICKET_TTL_MS) {
      const payload = Buffer.from(
        JSON.stringify({ cid, exp: Math.floor((now() + ttlMs) / 1000), n: randomBytes(9).toString("base64url") }),
      ).toString("base64url");
      return `${payload}.${mac(`nsibkr-ticket.v1.${payload}`).toString("base64url")}`;
    },

    /**
     * Checks a ticket without using it (the confirmation page). Returns the connection id, or null.
     * @param {unknown} ticket
     */
    peekTicket(ticket) {
      return check(ticket)?.cid ?? null;
    },

    /**
     * Checks a ticket and burns it. Returns the connection id, or null.
     * @param {unknown} ticket
     */
    redeemTicket(ticket) {
      const body = check(ticket);
      if (!body) return null;
      if (used.size > 10_000) sweep();
      used.set(body.n, body.exp * 1000);
      return body.cid;
    },

    /**
     * @param {string} cid
     * @param {number} [ttlMs]
     */
    cookieValue(cid, ttlMs = COOKIE_TTL_MS) {
      const exp = Math.floor((now() + ttlMs) / 1000);
      return `${cid}.${exp}.${mac(`nsibkr-cookie.v1.${cid}.${exp}`).toString("base64url")}`;
    },

    /**
     * @param {string | undefined} value
     * @returns {string | null} connection id
     */
    readCookie(value) {
      if (typeof value !== "string") return null;
      const m = /^([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (!m || !UUID.test(m[1])) return null;
      if (!same(Buffer.from(m[3], "base64url"), mac(`nsibkr-cookie.v1.${m[1]}.${m[2]}`))) return null;
      if (Number(m[2]) * 1000 <= now()) return null;
      return m[1];
    },

    sweep,
  };
}

/** @typedef {ReturnType<typeof createLoginTokens>} LoginTokens */

// ─────────────────────────────────────────────────────────── allowlist and rewrites

const SSO_PATH = /^\/sso(?:\/[A-Za-z0-9._~-]+)*\/?$/;
const ASSET_PATH = /^\/(?:css|scripts|stylesheet|images|fonts)(?:\/[A-Za-z0-9._~@+-]+)+$/;

/**
 * Is this request part of the IBKR login? Everything else is refused on the public host.
 * @param {string} method
 * @param {string} pathname already normalised by the URL parser
 */
export function isAllowedLoginPath(method, pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  if (pathname.includes("..") || pathname.includes("//") || pathname.includes("\\") || /%(?:2e|2f|5c|00)/i.test(pathname)) {
    return false;
  }
  const read = method === "GET" || method === "HEAD";
  if (read && pathname === "/") return true;
  if (read && pathname === "/v1/api/iserver/auth/status") return true;
  if ((read || method === "POST") && SSO_PATH.test(pathname)) return true;
  if (read && ASSET_PATH.test(pathname)) return true;
  if (method === "POST" && pathname === "/portal.proxy/v1/gstat/bulletins") return true;
  return false;
}

/**
 * Host-only cookie on the login host: Domain dropped, Path=/, SameSite=Lax, Secure on https.
 * @param {string} cookie
 * @param {boolean} secure
 */
export function rewriteSetCookie(cookie, secure) {
  const base = cookie
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*Path=[^;]*/gi, "")
    .replace(/;\s*SameSite=[^;]*/gi, "")
    .replace(/;\s*Secure(?=;|$)/gi, "")
    .replace(/;\s*$/, "");
  return `${base}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Absolute redirects to the gateway itself (localhost / 127.0.0.1, any port) become relative;
 * redirects to IBKR's own sites stay as they are.
 * @param {string} location
 */
export function rewriteLocation(location) {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("//")) return location;
  try {
    const u = new URL(location, "http://placeholder.invalid");
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") {
      return `${u.pathname}${u.search}${u.hash}` || "/";
    }
  } catch {
    /* leave it */
  }
  return location;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
]);
const FORWARDING = new Set([
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "forwarded",
  "via",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
]);

/**
 * Headers sent on to the gateway.
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {number} port
 */
export function gatewayRequestHeaders(headers, port) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || FORWARDING.has(key) || key === "host" || key === "cookie") continue;
    out[key] = v;
  }
  out.host = `localhost:${port}`;
  const cookies = String(headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${LOGIN_COOKIE}=`));
  if (cookies.length) out.cookie = cookies.join("; ");
  return out;
}

/**
 * Headers sent back to the browser.
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @param {boolean} secure
 */
export function browserResponseHeaders(headers, secure) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "set-cookie") {
      out[key] = (Array.isArray(v) ? v : [v]).map((c) => rewriteSetCookie(c, secure));
    } else if (key === "location") {
      out[key] = rewriteLocation(String(v));
    } else {
      out[key] = v;
    }
  }
  // The credential form is never framed by another site.
  if (!out["x-frame-options"]) out["x-frame-options"] = "DENY";
  out["x-robots-tag"] = "noindex, nofollow";
  return out;
}

/**
 * "trader.one@example.com" -> "t•••@example.com": enough for the owner to recognise, not a full address
 * for whoever holds the link.
 * @param {string | null | undefined} email
 */
export function maskEmail(email) {
  const at = typeof email === "string" ? email.lastIndexOf("@") : -1;
  if (!email || at < 1) return null;
  return `${email[0]}•••${email.slice(at)}`;
}

/**
 * A form POST from our own confirmation page. Browsers send Sec-Fetch-Site and Origin on a POST;
 * another site's auto-submitting form gets "cross-site" and its own (or a "null") origin.
 * @param {import("node:http").IncomingMessage} req
 */
export function isSameOriginPost(req) {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(String(origin)).host === String(req.headers.host ?? "");
  } catch {
    return false; // "null"
  }
}

/** @param {string | undefined} header @param {string} name */
function readCookieHeader(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────── pages

/** @param {string} s */
const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A plain page in Nasscord's voice. No scripts, no external assets.
 * @param {string} title
 * @param {string} body HTML (already escaped)
 * @param {{ refreshSec?: number }} [opts]
 */
function page(title, body, opts = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">${opts.refreshSec ? `<meta http-equiv="refresh" content="${opts.refreshSec}">` : ""}
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#0f172a;--muted:#475569;--line:#e2e8f0;--accent:#0f172a}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--fg:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--accent:#e2e8f0}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;padding:3rem 1rem}h1{font-size:1.375rem;letter-spacing:-.01em;margin:0 0 .75rem}
p{color:var(--muted);margin:0 0 1rem}a{color:var(--accent)}.brand{font-weight:600;margin-bottom:2rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
strong{color:var(--fg)}.warn{border-left:3px solid var(--line);padding-left:.75rem}form{margin:1.5rem 0}
button{font:inherit;font-weight:600;padding:.625rem 1rem;border-radius:.375rem;border:0;background:var(--accent);color:var(--bg);cursor:pointer}
</style></head><body><main><div class="brand">Nasscord</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};
/** The confirmation page posts its form to itself; "same-origin" keeps the Origin header on that POST. */
const CONFIRM_HEADERS = {
  ...PAGE_HEADERS,
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
};

// ─────────────────────────────────────────────────────────── the proxy

/**
 * @param {{
 *   tokens: LoginTokens,
 *   resolvePort: (cid: string) => number | null,
 *   isSlotPort: (port: number) => boolean,
 *   whenReady: (cid: string) => Promise<boolean>,
 *   isAuthenticated: (cid: string) => boolean,
 *   describe?: (cid: string) => Promise<{ workspace: string | null, email: string | null } | null>,
 *   cookieSecure: boolean,
 *   appUrl?: string | null,
 *   log: import("../log.mjs").Logger,
 *   timeoutMs?: number,
 *   readyTimeoutMs?: number,
 * }} opts
 */
export function createLoginProxy(opts) {
  const { tokens, resolvePort, isSlotPort, whenReady, isAuthenticated, cookieSecure, log } = opts;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 45_000;
  // No pooling at all (keepAlive off, maxSockets unbounded): see gateway-http.mjs.
  const agent = new http.Agent({ keepAlive: false });
  const back = opts.appUrl ? `<p><a href="${esc(opts.appUrl)}/app">Back to Nasscord</a></p>` : "";

  /**
   * @param {import("node:http").ServerResponse} res
   * @param {number} status
   * @param {string} title
   * @param {string} body
   * @param {{ refreshSec?: number }} [o]
   */
  function sendPage(res, status, title, body, o) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, PAGE_HEADERS);
    res.end(page(title, body, o));
  }

  const expiredBody =
    "<p>Login links work once and only for 2 minutes. Go back to Nasscord and press Connect (or Reconnect) on IBKR again.</p>";
  const endedBody = "<p>Go back to Nasscord and press Reconnect on IBKR to start a new login.</p>";

  /**
   * The urlencoded body of the Continue form (small, or null when it is not one).
   * @param {import("node:http").IncomingMessage} req
   * @returns {Promise<URLSearchParams | null>}
   */
  function readForm(req) {
    return new Promise((resolve) => {
      const type = String(req.headers["content-type"] ?? "application/x-www-form-urlencoded");
      if (!/^application\/x-www-form-urlencoded\b/i.test(type)) {
        req.resume();
        return resolve(null);
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_FORM_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
      req.on("error", () => resolve(null));
    });
  }

  /**
   * GET /start: the ticket is checked but kept; the page says whose workspace this login joins.
   * @param {import("node:http").ServerResponse} res
   * @param {string | null} ticket
   */
  async function confirmPage(res, ticket) {
    const cid = tokens.peekTicket(ticket);
    if (!cid) return sendPage(res, 400, "This login link has expired", expiredBody + back);
    if (!resolvePort(cid)) return sendPage(res, 410, "This IBKR login has ended", endedBody + back);
    const who = opts.describe ? await opts.describe(cid) : { workspace: null, email: null };
    if (!who) return sendPage(res, 410, "This IBKR login has ended", endedBody + back);
    // The workspace name is free text its owner chose ("Your IBKR account" is possible), so the page
    // says so; the masked email of whoever started the connection is the part to check.
    const workspace = who.workspace
      ? `the Nasscord workspace <strong>${esc(who.workspace)}</strong> (a name its owner chose)`
      : "a Nasscord workspace";
    const email = maskEmail(who.email);
    const body =
      `<p>The next page is IBKR's login. The IBKR account you log in with there is connected to ${workspace}` +
      `${email ? `, at the request of <strong>${esc(email)}</strong>` : ""}. That workspace then sees its balances, positions and orders.</p>` +
      "<p class=\"warn\"><strong>If you did not press Connect in Nasscord just now, close this page.</strong> " +
      "Do not log in here from a link someone else sent you.</p>" +
      `<form method="post" action="/start"><input type="hidden" name="t" value="${esc(String(ticket))}">` +
      "<button type=\"submit\">Continue to the IBKR login</button></form>" +
      back;
    res.writeHead(200, CONFIRM_HEADERS);
    res.end(page("Connect IBKR to Nasscord", body));
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {number} port
   * @param {string} path
   * @param {number} attempt
   */
  function forward(req, res, port, path, attempt) {
    // Belt and braces: the target is fixed to loopback and must be one of our slot ports.
    if (!isSlotPort(port)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not available.");
      return;
    }
    const method = req.method ?? "GET";
    const proxyReq = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: gatewayRequestHeaders(req.headers, port),
      agent,
      timeout: timeoutMs,
    });
    proxyReq.on("response", (pres) => {
      res.writeHead(pres.statusCode ?? 502, browserResponseHeaders(pres.headers, cookieSecure));
      pres.pipe(res);
      pres.on("error", () => res.destroy());
    });
    proxyReq.on("timeout", () => proxyReq.destroy(new Error("gateway timeout")));
    proxyReq.on("error", (err) => {
      if ((method === "GET" || method === "HEAD") && attempt === 0 && isParseError(err) && !res.headersSent) {
        log.info("login proxy retry after parse error", { path });
        forward(req, res, port, path, 1);
        return;
      }
      log.warn("login proxy error", { path, error: err });
      if (!res.headersSent) {
        sendPage(res, 502, "The IBKR page did not load", "<p>Refresh this page to try again.</p>");
      } else {
        res.destroy();
      }
    });

    if (method === "GET" || method === "HEAD") {
      proxyReq.end();
      return;
    }
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_POST_BYTES) {
        proxyReq.destroy();
        req.destroy();
      }
    });
    req.pipe(proxyReq);
  }

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function handle(req, res) {
    const method = req.method ?? "GET";
    const raw = req.url ?? "/";
    if (!raw.startsWith("/")) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request.");
      return;
    }
    let url;
    try {
      url = new URL(raw, "http://login.invalid");
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request.");
      return;
    }
    const pathname = url.pathname;

    if (pathname === "/start" && method === "GET") {
      return confirmPage(res, url.searchParams.get("t"));
    }

    if (pathname === "/start" && method === "POST") {
      if (!isSameOriginPost(req)) {
        req.resume();
        return sendPage(res, 403, "Open this page from Nasscord",
          "<p>The IBKR login opens from Nasscord. Go to Brokers, choose IBKR and press Connect.</p>" + back);
      }
      const form = await readForm(req);
      const cid = tokens.redeemTicket(form?.get("t") ?? null);
      if (!cid) return sendPage(res, 400, "This login link has expired", expiredBody + back);
      if (!resolvePort(cid)) return sendPage(res, 410, "This IBKR login has ended", endedBody + back);
      const attrs = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}${cookieSecure ? "; Secure" : ""}`;
      res.writeHead(303, {
        location: "/",
        "set-cookie": `${LOGIN_COOKIE}=${tokens.cookieValue(cid)}; ${attrs}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end();
      return;
    }

    const cid = tokens.readCookie(readCookieHeader(req.headers.cookie, LOGIN_COOKIE));

    if (pathname === "/done" && method === "GET") {
      if (cid && isAuthenticated(cid)) {
        return sendPage(res, 200, "You are logged in to IBKR",
          "<p>Nasscord is loading your accounts now. You can close this tab and go back to Nasscord.</p>" + back);
      }
      return sendPage(res, 200, "Finishing the IBKR login",
        "<p>Waiting for IBKR to confirm the login. This page refreshes on its own.</p>" +
          "<p>If nothing changes within a minute, go back to Nasscord and press Reconnect on IBKR.</p>" + back,
        { refreshSec: 3 });
    }

    if (!cid) {
      if (pathname.startsWith("/v1/api/")) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Open the IBKR login from Nasscord." }));
        return;
      }
      return sendPage(res, 401, "Open this page from Nasscord",
        "<p>The IBKR login opens from Nasscord. Go to Brokers, choose IBKR and press Connect.</p>" + back);
    }

    if (!isAllowedLoginPath(method, pathname)) {
      // A page navigation outside the login (IBKR's own post-login redirect, a link on the form)
      // lands on our status page instead of a bare 403. Nothing is proxied.
      if (method === "GET" && /text\/html/i.test(String(req.headers.accept ?? "")) && !pathname.startsWith("/v1/")) {
        res.writeHead(302, { location: "/done", "cache-control": "no-store" });
        res.end();
        return;
      }
      if (pathname.startsWith("/v1/api")) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Not available on the login host." }));
        return;
      }
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("Not available on the login host.");
      return;
    }

    const port = resolvePort(cid);
    if (!port || !isSlotPort(port)) {
      return sendPage(res, 410, "This IBKR login has ended",
        "<p>Go back to Nasscord and press Reconnect on IBKR to start a new login.</p>" + back);
    }

    if (pathname === "/" && (method === "GET" || method === "HEAD") && isAuthenticated(cid)) {
      res.writeHead(302, { location: "/done", "cache-control": "no-store" });
      res.end();
      return;
    }

    const ready = await Promise.race([
      whenReady(cid),
      new Promise((r) => setTimeout(() => r(false), readyTimeoutMs).unref()),
    ]);
    if (!ready) {
      return sendPage(res, 503, "The IBKR login is starting",
        "<p>This takes a few seconds. The page refreshes on its own.</p>", { refreshSec: 3 });
    }

    forward(req, res, port, `${pathname}${url.search}`, 0);
  }

  return {
    /**
     * @param {import("node:http").IncomingMessage} req
     * @param {import("node:http").ServerResponse} res
     */
    handle(req, res) {
      handle(req, res).catch((e) => {
        log.error("login host error", { error: e });
        if (!res.headersSent) sendPage(res, 500, "Something went wrong", "<p>Refresh this page to try again.</p>");
        else res.destroy();
      });
    },

    /**
     * WebSockets are not part of the login.
     * @param {import("node:http").IncomingMessage} _req
     * @param {import("node:stream").Duplex} socket
     */
    upgrade(_req, socket) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    },
  };
}
