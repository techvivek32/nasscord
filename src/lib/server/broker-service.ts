import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AccountType,
  BrokerAccount,
  BrokerConnection,
  BrokerId,
  BrokerOptions,
  ConnectClient,
  ConnectionEnvironment,
  ConnectionMethod,
  Execution,
  Order,
  Position,
  RenewNext,
  Role,
} from "@/lib/types";
import { toConnectionStatus, type DbConnectionStatus } from "@/lib/server/rows";

/*
 * The app's client for the broker service (services/broker), per docs/real-backend.md sections 5 and 6.
 * Server only: it holds BROKER_SERVICE_SECRET. Every /v1 call carries a 60-second HS256 service JWT
 * naming the user, their workspace and role; the service checks every connection id against `wid`.
 * Calls time out after 8 seconds (20 for the steps that call a broker: the hop, the code exchange,
 * the claim and the key check) and fail
 * with a BrokerServiceError whose message a user can read.
 */

if (typeof window !== "undefined") throw new Error("src/lib/server/broker-service.ts is server only.");

const TIMEOUT_MS = 8_000;
/** The code exchange and the claim call the broker and list accounts: they get longer. */
const SLOW_TIMEOUT_MS = 20_000;
const JWT_TTL_S = 60;
const ISSUER = "nasscord-app";
const AUDIENCE = "nasscord-broker";

export const BROKER_SERVICE_NOT_CONFIGURED = "Broker connections are not set up on this server yet. Set BROKER_SERVICE_URL and BROKER_SERVICE_SECRET (see docs/SETUP.md).";

export class BrokerServiceError extends Error {
  /** HTTP status the app's route should answer with. */
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BrokerServiceError";
    this.status = status;
  }
}

export function isBrokerServiceConfigured(): boolean {
  return Boolean(process.env.BROKER_SERVICE_URL && process.env.BROKER_SERVICE_SECRET);
}

/* ---------------------------------------------------------------- service JWT */

/** Who the service acts for. `workspaceId` is null only for a login without a workspace. */
export interface ServiceActor {
  userId: string;
  workspaceId: string | null;
  role: Role;
}

/**
 * The signer of the canonical-host steps (the OAuth hop and callback): no user is signed in there,
 * so these calls carry the nil user, and the broker service authorises them by the login's own
 * nonces (state, binding) instead of a session. Never use it for anything else: every other route
 * needs a workspace, which this actor does not have.
 */
export const FLOW_ACTOR: ServiceActor = { userId: "00000000-0000-0000-0000-000000000000", workspaceId: null, role: "trader" };

export interface ServiceJwtClaims {
  iss: string;
  aud: string;
  sub: string;
  wid: string | null;
  role: string;
  iat: number;
  exp: number;
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function serviceSecret(): string {
  const secret = process.env.BROKER_SERVICE_SECRET;
  if (!secret) throw new BrokerServiceError(503, BROKER_SERVICE_NOT_CONFIGURED);
  return secret;
}

/** HS256 JWT: header {"alg":"HS256","typ":"JWT"}, claims iss/aud/sub/wid/role/iat/exp (exp = iat + 60). */
export function signServiceJwt(actor: ServiceActor, nowMs = Date.now(), secret = serviceSecret()): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: ServiceJwtClaims = { iss: ISSUER, aud: AUDIENCE, sub: actor.userId, wid: actor.workspaceId, role: actor.role, iat, exp: iat + JWT_TTL_S };
  const signingInput = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * The service side of the same contract, kept here so both ends can be tested against one another.
 * Rejects a bad signature, the wrong iss/aud, an expired token or one issued more than 120 s ahead.
 */
export function verifyServiceJwt(token: string, secret: string, nowMs = Date.now()): ServiceJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { alg?: string };
    if (h.alg !== "HS256") return null;
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ServiceJwtClaims;
    const now = Math.floor(nowMs / 1000);
    if (c.iss !== ISSUER || c.aud !== AUDIENCE || typeof c.sub !== "string") return null;
    if (typeof c.exp !== "number" || c.exp <= now) return null;
    if (typeof c.iat !== "number" || c.iat > now + 120) return null;
    return c;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- service shapes */

export interface ServiceAccount {
  id: string;
  label: string;
  displayNumber: string;
  type: AccountType;
  included: boolean;
}

/** `connection` in service responses. `status` is as stored in the DB. */
export interface ServiceConnection {
  id: string;
  brokerId: BrokerId;
  method: ConnectionMethod;
  environment: ConnectionEnvironment;
  status: DbConnectionStatus;
  statusDetail: string | null;
  sessionExpiresAt: string | null;
  lastOkAt: string | null;
  /** Sent only when set. */
  dataAsOf?: string | null;
  scope?: string | null;
  accounts: ServiceAccount[];
}

/** Balances per account. `accountId` is broker_accounts.id. */
export interface ServiceBalance {
  accountId: string;
  netLiq: number;
  buyingPower: number;
  cash: number;
  dayPnl: number;
  currency: string;
}

export interface ServicePartialError {
  connectionId: string;
  message: string;
}

export interface ServicePortfolio {
  accounts: ServiceBalance[];
  positions: Position[];
  errors: ServicePartialError[];
}

/** GET /health: liveness only. Gateway counts are in /v1/health (an older service also sent `gateways` here). */
export interface ServiceHealth {
  ok: boolean;
  version: string;
  uptimeSec: number;
  gateways?: { running?: number; slotsFree?: number };
}

/** GET /v1/health (super admin): counts by broker and status, running gateways. Shape is the service's. */
export type ServiceHealthDetail = Record<string, unknown>;

/* ---------------------------------------------------------------- mapping */

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Service connection -> BrokerConnection, with balances merged in when they were fetched. */
export function mapServiceConnection(c: ServiceConnection, balances?: Map<string, ServiceBalance>): BrokerConnection {
  const accounts: BrokerAccount[] = (c.accounts ?? []).map((a) => {
    const b = balances?.get(a.id);
    return {
      id: a.id,
      connectionId: c.id,
      brokerId: c.brokerId,
      label: a.label,
      masked: a.displayNumber,
      type: a.type,
      included: a.included,
      ...(b ? withBalance(b) : {}),
    };
  });
  return {
    id: c.id,
    brokerId: c.brokerId,
    method: c.method,
    environment: c.environment,
    status: toConnectionStatus(c.status, c.sessionExpiresAt, { brokerId: c.brokerId, method: c.method }),
    ...(c.statusDetail ? { statusDetail: c.statusDetail } : {}),
    ...(c.lastOkAt ? { lastOkAt: c.lastOkAt } : {}),
    ...(c.sessionExpiresAt ? { sessionExpiresAt: c.sessionExpiresAt } : {}),
    ...(c.dataAsOf ? { dataAsOf: c.dataAsOf } : {}),
    ...(c.scope ? { scope: c.scope } : {}),
    accounts,
    permissions: ["read"],
  };
}

/** The balance fields of a BrokerAccount, only the ones the broker actually reported. */
export function withBalance(b: ServiceBalance): Pick<BrokerAccount, "netLiq" | "buyingPower" | "cash" | "dayPnl" | "currency"> {
  const out: Pick<BrokerAccount, "netLiq" | "buyingPower" | "cash" | "dayPnl" | "currency"> = {};
  const netLiq = finite(b.netLiq);
  const buyingPower = finite(b.buyingPower);
  const cash = finite(b.cash);
  const dayPnl = finite(b.dayPnl);
  if (netLiq !== undefined) out.netLiq = netLiq;
  if (buyingPower !== undefined) out.buyingPower = buyingPower;
  if (cash !== undefined) out.cash = cash;
  if (dayPnl !== undefined) out.dayPnl = dayPnl;
  if (typeof b.currency === "string" && b.currency) out.currency = b.currency;
  return out;
}

/* ---------------------------------------------------------------- transport */

const STATUS_MESSAGE: Record<number, string> = {
  400: "The broker service could not use that request. Check the details and try again.",
  401: "The broker service did not accept this app's credentials. The operator needs to check BROKER_SERVICE_SECRET.",
  403: "That connection is not in your workspace.",
  404: "That connection no longer exists. Refresh the page.",
  409: "That connection is busy with another step. Wait a moment and try again.",
  429: "The broker is limiting requests right now. Wait a few seconds and try again.",
};

/** The service's own sentence when it sent one, else a plain one for the status. */
function readableError(status: number, body: unknown): string {
  const own = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
  if (typeof own === "string" && own.trim() && own.length <= 300) return own.trim();
  return STATUS_MESSAGE[status] ?? "The broker service had a problem. Try again in a moment.";
}

/** Status the app answers with: client errors pass through, service-side failures become 502. */
function appStatus(serviceStatus: number) {
  if (serviceStatus === 401) return 502;
  if (serviceStatus >= 400 && serviceStatus < 500) return serviceStatus;
  return 502;
}

async function call<T>(actor: ServiceActor | null, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const base = process.env.BROKER_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new BrokerServiceError(503, BROKER_SERVICE_NOT_CONFIGURED);
  const headers: Record<string, string> = { accept: "application/json" };
  if (actor) headers.authorization = `Bearer ${signServiceJwt(actor)}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BrokerServiceError(504, `The broker service did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again in a moment.`);
    }
    throw new BrokerServiceError(503, "The broker service cannot be reached right now. Try again in a moment.");
  }

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) throw new BrokerServiceError(appStatus(res.status), readableError(res.status, json));
  if (json === null && text) throw new BrokerServiceError(502, "The broker service sent a reply the app could not read.");
  return json as T;
}

const enc = encodeURIComponent;

/* ---------------------------------------------------------------- endpoints (section 6) */

/** GET /health (no auth). */
export function getServiceHealth(): Promise<ServiceHealth> {
  return call<ServiceHealth>(null, "GET", "/health");
}

/** GET /v1/health (super admin only). */
export function getServiceHealthDetail(actor: ServiceActor): Promise<ServiceHealthDetail> {
  return call<ServiceHealthDetail>(actor, "GET", "/v1/health");
}

export function startEtrade(actor: ServiceActor, body: { environment: "production" | "sandbox"; consumerKey: string; consumerSecret: string }): Promise<{ connectionId: string; authorizeUrl: string }> {
  return call(actor, "POST", "/v1/etrade/start", body);
}

export async function verifyEtrade(actor: ServiceActor, body: { connectionId: string; verifier: string }): Promise<{ connection: BrokerConnection }> {
  const r = await call<{ connection: ServiceConnection }>(actor, "POST", "/v1/etrade/verify", body);
  return { connection: mapServiceConnection(r.connection) };
}

export function startIbkr(actor: ServiceActor, body: { environment: "production" | "paper" }): Promise<{ connectionId: string; loginUrl: string }> {
  return call(actor, "POST", "/v1/ibkr/start", body);
}

export async function getConnection(actor: ServiceActor, id: string): Promise<{ connection: BrokerConnection }> {
  const r = await call<{ connection: ServiceConnection }>(actor, "GET", `/v1/connections/${enc(id)}`);
  return { connection: mapServiceConnection(r.connection) };
}

/**
 * POST /v1/connections/:id/renew. `body` carries a new login's return origin and binding hash, which
 * OAuth and SnapTrade connections need when the broker asks for a new login (next.kind "redirect").
 * `loginUrl` is the IBKR or E*TRADE link (IBKR's stays on the server).
 */
export async function renewConnection(
  actor: ServiceActor,
  id: string,
  body?: { returnOrigin: string; bindingHash: string },
): Promise<{ connection: BrokerConnection; loginUrl?: string; next?: RenewNext }> {
  const r = await call<{ connection: ServiceConnection; loginUrl?: string; next?: RenewNext }>(actor, "POST", `/v1/connections/${enc(id)}/renew`, body ?? {});
  return {
    connection: mapServiceConnection(r.connection),
    ...(typeof r.loginUrl === "string" && r.loginUrl ? { loginUrl: r.loginUrl } : {}),
    ...(r.next && typeof r.next === "object" && typeof r.next.kind === "string" ? { next: r.next } : {}),
  };
}

export function deleteConnection(actor: ServiceActor, id: string): Promise<{ ok: true }> {
  return call(actor, "DELETE", `/v1/connections/${enc(id)}`);
}

/* ---------------------------------------------------------------- generic connect steps ("Connect flows") */

/** GET /v1/options: every way of connecting and whether this user may use it now. */
export function getOptions(actor: ServiceActor): Promise<BrokerOptions> {
  return call<BrokerOptions>(actor, "GET", "/v1/options");
}

/** POST /v1/keys/connect: an API key or personal token. `connectionId` re-keys that connection. */
export async function connectKey(
  actor: ServiceActor,
  body: { brokerId: BrokerId; method?: ConnectionMethod; environment?: ConnectionEnvironment; keyId?: string; secret: string; connectionId?: string },
): Promise<{ connection: BrokerConnection }> {
  const r = await call<{ connection: ServiceConnection }>(actor, "POST", "/v1/keys/connect", body, SLOW_TIMEOUT_MS);
  return { connection: mapServiceConnection(r.connection) };
}

/**
 * POST /v1/oauth/start: a pending connection and its hand-off row. `bindingHash` is sha256 hex of the
 * nonce the app keeps in the ns_oauth_<connectionId> cookie; `returnOrigin` is the user's own host.
 * The browser then opens the canonical hop (docs/real-backend.md, "Connect flows").
 */
export function startOAuth(
  actor: ServiceActor,
  body: {
    brokerId: BrokerId;
    method?: ConnectionMethod;
    client?: ConnectClient;
    environment?: ConnectionEnvironment;
    clientId?: string;
    clientSecret?: string;
    returnOrigin: string;
    bindingHash: string;
  },
): Promise<{ connectionId: string }> {
  return call(actor, "POST", "/v1/oauth/start", body);
}

/** POST /v1/aggregator/start: the same for a SnapTrade broker. */
export function startAggregator(
  actor: ServiceActor,
  body: { brokerId: BrokerId; environment?: ConnectionEnvironment; returnOrigin: string; bindingHash: string },
): Promise<{ connectionId: string }> {
  return call(actor, "POST", "/v1/aggregator/start", body);
}

/**
 * POST /v1/connect/hop (canonical host, FLOW_ACTOR): proves the binding nonce and answers the
 * broker's URL (a fresh state, or SnapTrade's portal link), plus who asked, for the confirmation
 * page. `repeat` only when the canonical host already holds this login's cookie. `preview` runs the
 * same checks for the confirmation page and answers no `redirectUrl` (nothing is used up).
 * The real hop gets the long timeout: it may ask the broker for a link (SnapTrade's portal), and a
 * hop the app gave up on while the service finished it is used up (only `repeat` opens it again).
 */
export function connectHop(body: { connectionId: string; binding: string; repeat?: boolean; preview?: boolean }): Promise<{
  redirectUrl?: string;
  brokerId: BrokerId;
  workspaceName: string | null;
  requestedBy: string | null;
}> {
  return call(FLOW_ACTOR, "POST", "/v1/connect/hop", body, body.preview ? TIMEOUT_MS : SLOW_TIMEOUT_MS);
}

/**
 * POST /v1/oauth/complete (canonical callback, FLOW_ACTOR): exchanges the code. `bindings` is every
 * ns_oauth_<id> cookie on the canonical host, by connection id. Answers the opaque one-time ticket the
 * user's own host claims with.
 */
export function completeOAuth(body: {
  brokerId: BrokerId;
  state: string;
  code?: string;
  error?: string;
  bindings: Record<string, string>;
}): Promise<{ connectionId: string; returnOrigin: string; ticket: string }> {
  return call(FLOW_ACTOR, "POST", "/v1/oauth/complete", body, SLOW_TIMEOUT_MS);
}

/** POST /v1/aggregator/complete (canonical callback, FLOW_ACTOR): SnapTrade's result for a connection. */
export function completeAggregator(body: {
  connectionId: string;
  status: string;
  authorizationId?: string;
  binding: string;
}): Promise<{ connectionId: string; returnOrigin: string; ticket: string }> {
  return call(FLOW_ACTOR, "POST", "/v1/aggregator/complete", body, SLOW_TIMEOUT_MS);
}

/** POST /v1/connect/claim (the user's own host, the user's own actor): ticket + binding -> active. */
export async function claimConnection(actor: ServiceActor, body: { connectionId: string; ticket: string; binding: string }): Promise<{ connection: BrokerConnection }> {
  const r = await call<{ connection: ServiceConnection }>(actor, "POST", "/v1/connect/claim", body, SLOW_TIMEOUT_MS);
  return { connection: mapServiceConnection(r.connection) };
}

/** Arrays from a reply that may be empty or not an object (an empty 200 body reads as null). */
function listOf<T>(reply: unknown, key: string): T[] {
  const v = reply && typeof reply === "object" ? (reply as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function getPortfolio(actor: ServiceActor): Promise<ServicePortfolio> {
  const r = await call<unknown>(actor, "GET", "/v1/portfolio");
  return { accounts: listOf<ServiceBalance>(r, "accounts"), positions: listOf<Position>(r, "positions"), errors: listOf<ServicePartialError>(r, "errors") };
}

export async function getOrders(actor: ServiceActor): Promise<{ orders: Order[]; errors: ServicePartialError[] }> {
  const r = await call<unknown>(actor, "GET", "/v1/orders");
  return { orders: listOf<Order>(r, "orders"), errors: listOf<ServicePartialError>(r, "errors") };
}

export async function getExecutions(actor: ServiceActor): Promise<{ executions: Execution[]; errors: ServicePartialError[] }> {
  const r = await call<unknown>(actor, "GET", "/v1/executions");
  return { executions: listOf<Execution>(r, "executions"), errors: listOf<ServicePartialError>(r, "errors") };
}
