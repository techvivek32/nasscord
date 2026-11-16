import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { CONNECT_SPECS, METHOD_BROKERS } from "@/lib/broker-connect";
import { APP_DOMAIN } from "@/lib/branding";
import { getBroker } from "@/lib/brokers";
import { RESERVED_SLUGS } from "@/lib/signup";
import { getOptions, type ServiceActor } from "@/lib/server/broker-service";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenantByDomain } from "@/lib/tenant-server";
import type { BrokerId, BrokerOptions, ConnectFlow, ConnectionMethod, ConnectOption, Role } from "@/lib/types";

/*
 * The canonical-host hand-off of OAuth and SnapTrade logins (docs/real-backend.md section 8). Server only.
 *
 * Supabase cookies are host-only, and a user may sit on nasscord.com, a workspace subdomain or a
 * white-label tenant domain, while every broker returns to one registered URL on the canonical host
 * (NEXT_PUBLIC_SITE_URL, equal to the broker service's OAUTH_CALLBACK_BASE). A tenant controls its own
 * domain's DNS, so a code or a portal result must never travel to a host other than the canonical one:
 *
 *   start    (user's host, signed in)  random nonce N; the service keeps sha256(N); cookie ns_oauth_<cid>=N
 *   hop      (canonical, no session)   proves N, sets the same cookie on the canonical host, 303 to the broker
 *   callback (canonical, no session)   code + the canonical cookie -> the service exchanges the code there and
 *                                      answers an opaque one-time ticket, the only thing sent to the user's host
 *   finish   (user's host, signed in)  ticket + the user-host cookie + the starter's session -> connected
 *
 * Nothing here logs a query string, a nonce, a state, a code or a ticket.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server/oauth-return.ts is server only.");

const production = () => process.env.NODE_ENV === "production";

/* ---------------------------------------------------------------- constants */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Nonces, states and tickets as the broker service makes them: base64url, 32 to 128 characters. */
export const OPAQUE_RE = /^[A-Za-z0-9_-]{32,128}$/;
/** The shape broker_oauth_pending.return_origin accepts (and the service checks). */
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;
/** workspaces.slug and tenants.slug. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const BINDING_COOKIE_PREFIX = "ns_oauth_";
/** Same window as the service's hand-off row (10 minutes). */
const BINDING_MAX_AGE_S = 600;
/** The service reads at most 8 binding cookies per callback; extra ones make it refuse every one. */
const MAX_BINDINGS = 8;

const REDIRECT_FLOWS: ReadonlySet<ConnectFlow> = new Set(["oauth2_user_app", "oauth2_platform", "aggregator_portal"]);

/** Every broker id and connect method, at runtime (for zod enums). */
export const BROKER_IDS = Object.keys(CONNECT_SPECS) as [BrokerId, ...BrokerId[]];
export const CONNECTION_METHODS = Object.keys(METHOD_BROKERS) as [ConnectionMethod, ...ConnectionMethod[]];

/** Methods whose login is a redirect through the hand-off: OAuth (user app or platform) and SnapTrade. */
export const REDIRECT_METHODS: ReadonlySet<ConnectionMethod> = new Set(
  Object.values(CONNECT_SPECS)
    .flat()
    .filter((s) => REDIRECT_FLOWS.has(s.flow))
    .map((s) => s.method),
);

/** Brokers with their own OAuth login, so with a callback path of their own. */
export const OAUTH_BROKER_IDS: ReadonlySet<BrokerId> = new Set(
  BROKER_IDS.filter((id) => CONNECT_SPECS[id].some((s) => s.flow === "oauth2_user_app" || s.flow === "oauth2_platform")),
);

/** "/api/broker/callback/<segment>": an OAuth broker id, or "snaptrade" for every SnapTrade broker. */
export type CallbackSegment = BrokerId | "snaptrade";

export function callbackSegment(raw: string): CallbackSegment | null {
  const s = raw.toLowerCase();
  if (s === "snaptrade") return "snaptrade";
  return OAUTH_BROKER_IDS.has(s as BrokerId) ? (s as BrokerId) : null;
}

export const LOGIN_NOT_SET_UP =
  "Broker logins are not set up on this server yet: NEXT_PUBLIC_SITE_URL must be the site's own https address (see docs/SETUP.md).";
const CALLBACK_MISMATCH =
  "Broker logins are not set up correctly on this server: OAUTH_CALLBACK_BASE on the broker service and NEXT_PUBLIC_SITE_URL must name the same address (see docs/SETUP.md).";

/* ---------------------------------------------------------------- origins */

/** "https://Nasscord.com/" -> "https://nasscord.com"; null for anything that is not a bare http(s) origin. */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  const origin = u.origin.toLowerCase();
  return ORIGIN_RE.test(origin) ? origin : null;
}

/** The canonical origin every broker returns to (NEXT_PUBLIC_SITE_URL), or null when it is unusable here. */
export function canonicalOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim() || (production() ? "" : "http://localhost:3000");
  const origin = normalizeOrigin(raw);
  if (!origin || (production() && !origin.startsWith("https://"))) return null;
  return origin;
}

/**
 * The origin this request was made to, as the browser sees it. Behind Caddy the Host header passes
 * unchanged and X-Forwarded-Proto is Caddy's own (it drops a client's copy); Next fills both when
 * no proxy sent them. Whatever comes out is checked against the allowlist before it is used.
 */
export function requestOrigin(request: Request): string | null {
  const h = request.headers;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  if (!host) return null;
  let proto = h.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  if (proto !== "https" && proto !== "http") {
    try {
      proto = new URL(request.url).protocol.replace(":", "");
    } catch {
      return null;
    }
  }
  return normalizeOrigin(`${proto}://${host}`);
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
}

export type ReturnOriginKind = "canonical" | "workspace" | "tenant" | "development";

/** The tenant fields the allowlist needs (getTenantByDomain in production, a fake in tests). */
export type TenantLookup = (domain: string) => Promise<{ status: string; whiteLabel: boolean; branding?: { domain?: string } | null } | null>;
/** Whether a workspace holds this subdomain slug. */
export type WorkspaceLookup = (slug: string) => Promise<boolean>;

/**
 * Whether a workspace holds `slug` (service role, deduplicated per request). A failed read answers
 * false: a login then cannot return to that subdomain, which is the safe side.
 */
export const workspaceSlugExists: WorkspaceLookup = cache(async (slug: string): Promise<boolean> => {
  try {
    const { data, error } = await createAdminClient().from("workspaces").select("id").eq("slug", slug).maybeSingle();
    return !error && !!data;
  } catch {
    return false;
  }
});

/**
 * Whether a login may return to `origin`, and why: the canonical site, https://<slug>.<APP_DOMAIN>
 * for a slug a workspace holds (never a name the platform reserves, such as ibkr-login, status, mail
 * or docs, which may point at infrastructure or a third party), the domain of an active tenant with
 * white-label, or localhost outside production. Plain http and explicit ports are refused in
 * production, and so is every other host (a foreign site, a suspended or pending tenant, a tenant
 * without white-label, a subdomain no workspace holds).
 */
export async function returnOriginKind(
  origin: string | null,
  lookupTenant: TenantLookup = getTenantByDomain,
  lookupWorkspace: WorkspaceLookup = workspaceSlugExists,
): Promise<ReturnOriginKind | null> {
  const clean = normalizeOrigin(origin);
  if (!clean) return null;
  const canonical = canonicalOrigin();
  if (canonical && clean === canonical) return "canonical";
  const u = new URL(clean);
  const host = u.hostname;
  if (!production() && isLoopbackHost(host)) return "development";
  if (production() && (u.protocol !== "https:" || u.port)) return null;

  const apex = APP_DOMAIN.toLowerCase();
  if (host === apex || host === `www.${apex}`) return null;
  if (host.endsWith(`.${apex}`)) {
    const sub = host.slice(0, -(apex.length + 1));
    if (sub === "www" || RESERVED_SLUGS.has(sub) || !SLUG_RE.test(sub)) return null;
    return (await lookupWorkspace(sub).catch(() => false)) ? "workspace" : null;
  }
  // An IP address is never a tenant domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const tenant = await lookupTenant(host).catch(() => null);
  if (!tenant || !tenant.whiteLabel || tenant.status !== "active") return null;
  return tenant.branding?.domain?.toLowerCase() === host ? "tenant" : null;
}

/* ---------------------------------------------------------------- binding nonce and cookie */

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A fresh binding: the nonce for the cookie and the hash the broker service keeps. */
export function newBinding(): { nonce: string; hash: string } {
  const nonce = randomBytes(32).toString("base64url");
  return { nonce, hash: sha256Hex(nonce) };
}

/** Constant-time comparison of two nonces. */
export function sameNonce(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(a), "hex"), Buffer.from(sha256Hex(b), "hex"));
}

export function bindingCookieName(connectionId: string): string {
  return `${BINDING_COOKIE_PREFIX}${connectionId.toLowerCase()}`;
}

/** ns_oauth_<cid>=<nonce>: HttpOnly, SameSite=Lax (sent on the broker's top-level redirect), Path=/api/broker, 10 minutes. */
export function bindingCookie(connectionId: string, nonce: string, origin: string): string {
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return `${bindingCookieName(connectionId)}=${nonce}; Path=/api/broker; Max-Age=${BINDING_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure}`;
}

export function clearBindingCookie(connectionId: string, origin: string): string {
  const secure = origin.startsWith("https://") ? "; Secure" : "";
  return `${bindingCookieName(connectionId)}=; Path=/api/broker; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

/** Cookies of the request in header order (the browser sends older cookies of the same path first). */
function requestCookies(request: Request): Array<[string, string]> {
  const header = request.headers.get("cookie");
  if (!header) return [];
  const out: Array<[string, string]> = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return out;
}

/** The binding nonce this browser holds on this host for one connection. */
export function bindingFromCookies(request: Request, connectionId: string): string | null {
  const name = bindingCookieName(connectionId);
  let found: string | null = null;
  for (const [k, v] of requestCookies(request)) if (k === name && OPAQUE_RE.test(v)) found = v;
  return found;
}

/** Every binding cookie on this host by connection id, at most the 8 newest (what the service reads). */
export function allBindings(request: Request): Record<string, string> {
  const found = new Map<string, string>();
  for (const [k, v] of requestCookies(request)) {
    if (!k.startsWith(BINDING_COOKIE_PREFIX) || !OPAQUE_RE.test(v)) continue;
    const id = k.slice(BINDING_COOKIE_PREFIX.length).toLowerCase();
    if (!UUID_RE.test(id)) continue;
    found.delete(id);
    found.set(id, v);
  }
  return Object.fromEntries([...found.entries()].slice(-MAX_BINDINGS));
}

/* ---------------------------------------------------------------- URLs */

/** The canonical-host hop the dialog opens in a new tab. */
export function hopUrl(canonical: string, connectionId: string, nonce: string): string {
  return `${canonical}/api/broker/oauth/go?cid=${encodeURIComponent(connectionId)}&n=${encodeURIComponent(nonce)}`;
}

/** Where the canonical callback sends the browser: the user's own host, with the one-time ticket only. */
export function finishUrl(returnOrigin: string, connectionId: string, ticket: string): string {
  return `${returnOrigin}/api/broker/oauth/finish?cid=${encodeURIComponent(connectionId)}&ticket=${encodeURIComponent(ticket)}`;
}

/** The broker's login page the hop redirects to: https only (plain http to localhost for local fakes outside production). */
export function brokerRedirect(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 8192) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return url;
  if (!production() && u.protocol === "http:" && isLoopbackHost(u.hostname)) return url;
  return null;
}

/* ---------------------------------------------------------------- request checks */

/**
 * A fetch from a Nasscord page on this very host. Browsers send Sec-Fetch-Site (and Origin on a
 * POST); a value from another site means the call did not come from the user's own page.
 */
export function sameOriginCall(request: Request, own: string | null): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin && normalizeOrigin(origin) !== own) return false;
  // A POST from a browser carries at least one of the two.
  return Boolean(site || origin);
}

/** The client address for the no-session steps' rate limit (Caddy sets X-Forwarded-For). */
export function clientAddress(request: Request): string {
  const h = request.headers;
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip")?.trim() || "unknown";
}

/* ---------------------------------------------------------------- options (cached per role) */

const OPTIONS_TTL_MS = 60_000;
const optionsCache = new Map<Role, { at: number; value: BrokerOptions }>();

function cleanOption(o: ConnectOption): ConnectOption {
  return {
    brokerId: o.brokerId,
    method: o.method,
    client: o.client ?? null,
    flow: o.flow,
    environments: Array.isArray(o.environments) ? o.environments : [],
    audience: o.audience,
    built: !!o.built,
    configured: !!o.configured,
    available: !!o.available,
    reasonCode: o.reasonCode ?? null,
    reason: typeof o.reason === "string" ? o.reason : null,
    callbackUrl: typeof o.callbackUrl === "string" ? o.callbackUrl : null,
  };
}

/**
 * GET /v1/options for this user, kept 60 s per role and instance. The answer depends only on the
 * role (the owner sees which setting is missing, and `superadmin` methods open for them).
 */
export async function cachedOptions(actor: ServiceActor & { role: Role }): Promise<BrokerOptions> {
  const hit = optionsCache.get(actor.role);
  const now = Date.now();
  if (hit && now - hit.at < OPTIONS_TTL_MS) return hit.value;
  const raw = await getOptions(actor);
  const value: BrokerOptions = {
    callbackBase: typeof raw?.callbackBase === "string" ? raw.callbackBase : null,
    options: Array.isArray(raw?.options) ? raw.options.filter((o) => o && typeof o === "object").map(cleanOption) : [],
  };
  optionsCache.set(actor.role, { at: now, value });
  return value;
}

/* ---------------------------------------------------------------- starting a login */

export interface LoginPrep {
  canonical: string;
  returnOrigin: string;
  binding: { nonce: string; hash: string };
}

/** A JSON error the route answers as is. */
function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Everything a new OAuth or SnapTrade login needs before the service is called: the canonical host,
 * the user's own origin (on the allowlist), a fresh binding, and the service's callback base equal to
 * the canonical host (otherwise the hop's cookie would sit on another host than the callback).
 */
export async function prepareLogin(request: Request, actor: ServiceActor & { role: Role }): Promise<LoginPrep | Response> {
  const canonical = canonicalOrigin();
  if (!canonical) return jsonError(503, LOGIN_NOT_SET_UP);
  const own = requestOrigin(request);
  if (!sameOriginCall(request, own)) return jsonError(403, "Start the connection from the Brokers page in Nasscord.");
  if (!(await returnOriginKind(own))) {
    return jsonError(400, `Brokers cannot return to this address. Open Nasscord at ${canonical} and connect from Brokers there.`);
  }
  const options = await cachedOptions(actor);
  if (normalizeOrigin(options.callbackBase) !== canonical) return jsonError(503, CALLBACK_MISMATCH);
  return { canonical, returnOrigin: own as string, binding: newBinding() };
}

/** The start answer: the pending connection, the hop to open, and the binding cookie on the user's host. */
export function loginStarted(connectionId: unknown, prep: LoginPrep): Response {
  if (typeof connectionId !== "string" || !UUID_RE.test(connectionId)) {
    return jsonError(502, "The broker service sent a reply the app could not read.");
  }
  const id = connectionId.toLowerCase();
  return jsonWithCookies({ connectionId: id, openUrl: hopUrl(prep.canonical, id, prep.binding.nonce) }, [
    bindingCookie(id, prep.binding.nonce, prep.returnOrigin),
  ]);
}

/** The connection's method and broker when it belongs to the workspace (disconnected ones included). */
export async function connectionInWorkspaceWithMethod(
  connectionId: string,
  workspaceId: string,
): Promise<{ method: ConnectionMethod; brokerId: BrokerId } | null> {
  const { data, error } = await createAdminClient()
    .from("broker_connections")
    .select("id, method, broker_id")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(`broker_connections: ${error.code ?? "read failed"}`);
  if (!data) return null;
  const row = data as { method: ConnectionMethod; broker_id: BrokerId };
  return { method: row.method, brokerId: row.broker_id };
}

/**
 * Whether a login runs through SnapTrade, for the hop's wording (the hop answer names the broker,
 * not the method). A broker without an OAuth login of its own is reached through SnapTrade only;
 * for one with both (Schwab, Webull, tastytrade) the connection row says. Call it only after the
 * service accepted the binding. Null when the row cannot be read: the page then stays neutral.
 */
export async function loginViaSnapTrade(connectionId: string, brokerId: BrokerId): Promise<boolean | null> {
  if (!OAUTH_BROKER_IDS.has(brokerId)) return true;
  try {
    const { data, error } = await createAdminClient().from("broker_connections").select("method").eq("id", connectionId).maybeSingle();
    if (error || !data) return null;
    return (data as { method: ConnectionMethod }).method === "snaptrade";
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- responses */

const NAV_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/** 303 to `location` with no cache and no referrer (the URL that led here may hold a code or a state). */
export function seeOther(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...NAV_HEADERS, "Referrer-Policy": "no-referrer", Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * HEAD on the login-tab routes. Next answers HEAD with the GET handler when a route exports none,
 * which here would use up a state, a hop or a ticket for a link checker. Nothing is done.
 */
export function headOnly(): Response {
  return new Response(null, { status: 200, headers: { ...NAV_HEADERS, "Referrer-Policy": "no-referrer" } });
}

/** JSON with Set-Cookie (the start and renew answers). */
export function jsonWithCookies<T>(body: T, cookies: string[]): Response {
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return Response.json(body, { status: 200, headers });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Disables the Continue button once pressed, so a double click cannot use the hop twice. */
const SUBMIT_ONCE = `document.addEventListener("submit",function(e){var b=e.target.querySelector("button");setTimeout(function(){if(b)b.disabled=true},0)});`;
const SUBMIT_ONCE_HASH = createHash("sha256").update(SUBMIT_ONCE).digest("base64");

export interface FlowPage {
  status: number;
  title: string;
  heading: string;
  paragraphs: string[];
  /** A link back into Nasscord (only where the session lives on this host). */
  link?: { href: string; label: string };
  /** The hop's confirmation form (posts back to the same host). */
  form?: { action: string; fields: Record<string, string>; button: string };
  cookies?: string[];
}

/**
 * A short page for the login tab. System colors only, so it follows the visitor's theme; no frames,
 * no outside resources. The referrer is never sent off this host.
 */
export function flowPage(p: FlowPage): Response {
  const form = p.form
    ? `<form method="post" action="${esc(p.form.action)}">${Object.entries(p.form.fields)
        .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
        .join("")}<button type="submit">${esc(p.form.button)}</button></form>`
    : "";
  const link = p.link ? `<p><a href="${esc(p.link.href)}">${esc(p.link.label)}</a></p>` : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(p.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 3rem 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
  p { margin: 0 0 1rem; }
  a { color: LinkText; }
  button { font: inherit; padding: 0.55rem 1rem; border: 1px solid ButtonBorder; background: ButtonFace; color: ButtonText; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
<main>
<h1>${esc(p.heading)}</h1>
${p.paragraphs.map((t) => `<p>${esc(t)}</p>`).join("\n")}
${form}
${link}
</main>
${p.form ? `<script>${SUBMIT_ONCE}</script>` : ""}
</body>
</html>`;
  const headers = new Headers({
    ...NAV_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    // same-origin: the confirmation form posts back here with its Origin; nothing leaves this host.
    "Referrer-Policy": p.form ? "same-origin" : "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SUBMIT_ONCE_HASH}'; frame-ancestors 'none'; base-uri 'none'`,
    "X-Robots-Tag": "noindex",
  });
  for (const c of p.cookies ?? []) headers.append("Set-Cookie", c);
  return new Response(html, { status: p.status, headers });
}

/** The broker's name for a page ("Charles Schwab"), or "SnapTrade". */
export function brokerName(id: string | null | undefined): string {
  if (id === "snaptrade") return "SnapTrade";
  try {
    return getBroker(id as BrokerId).name;
  } catch {
    return "the broker";
  }
}
