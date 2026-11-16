/* ------------------------------------------------------------------
   Nasscord domain model. Every feature area builds on these types.
   Add fields here rather than inventing parallel shapes in a page.
   ------------------------------------------------------------------ */

export type BrokerId =
  | "ibkr"
  | "schwab"
  | "etrade"
  | "tastytrade"
  | "tradier"
  | "alpaca"
  | "tradestation"
  | "webull"
  | "fidelity"
  | "robinhood"
  | "moomoo"
  | "public";

/** live = connects for every user today · beta = connects with limits the broker's page states ·
 *  sync = read-only through an aggregator · soon = not available yet.
 *  This is the static release status for pages that cannot ask the broker service. What a user can
 *  connect right now comes from GET /api/broker/options (BrokerOptions). */
export type BrokerStatus = "live" | "beta" | "sync" | "soon";
export type BrokerMode = "direct" | "aggregator" | "planned";

export interface Broker {
  id: BrokerId;
  name: string;
  short: string;
  monogram: string;
  /** Broker's own site host, used for the external "Manage" link. */
  site: string;
  /** Tile background for the monogram. The only hardcoded colors in the app. */
  color: string;
  status: BrokerStatus;
  mode: BrokerMode;
  capabilities: { trading: boolean; options: boolean; extendedHours: boolean; paper: boolean };
  blurb: string;
  /** How a user connects this broker, one spec per way (src/lib/broker-connect). Empty: no way yet. */
  connect: ConnectSpec[];
}

/* ---------- connecting a broker (docs/real-backend.md, "Connect flows") ---------- */

/** The six ways a user connects a broker. */
export type ConnectFlow =
  /** IBKR: a gateway session, logged in on IBKR's own page. */
  | "gateway_login"
  /** E*TRADE: the user's own consumer key, approved on E*TRADE, verification code pasted back. */
  | "oauth1_verifier"
  /** Alpaca key and secret, or the owner's own Tradier token. */
  | "api_key"
  /** The user's own OAuth app (Schwab Individual app, TradeStation key) with Nasscord's callback. */
  | "oauth2_user_app"
  /** Nasscord's own registered OAuth client, once the broker approves Nasscord. */
  | "oauth2_platform"
  /** SnapTrade's hosted portal (Fidelity, Robinhood, Public, Moomoo, Webull until Webull approves). */
  | "aggregator_portal";

/** Whose OAuth app a login uses: the user's own, or Nasscord's registered client. */
export type ConnectClient = "user" | "platform";

/** Who may use a connect method on this server (the broker service's BROKER_AUDIENCE). */
export type ConnectAudience = "all" | "superadmin" | "off";

/** One environment a connect dialog offers. */
export interface ConnectEnvironmentOption {
  value: ConnectionEnvironment;
  /** "Live", "Paper", "Sandbox · sample data". */
  label: string;
  hint: string;
}

/** A credential field of a connect dialog. Secrets are password inputs with autocomplete off. */
export interface ConnectField {
  name: "keyId" | "secret" | "clientId" | "clientSecret";
  label: string;
  hint?: string;
  secret?: boolean;
}

/**
 * How one way of connecting a broker works, in the user's words. The connect UI renders it; the
 * broker service decides whether it is available to this user right now (ConnectOption).
 */
export interface ConnectSpec {
  flow: ConnectFlow;
  method: ConnectionMethod;
  /** OAuth flows: the user's own app or Nasscord's client. */
  client?: ConnectClient;
  /** Read through an aggregator (named in the UI as "via SnapTrade"). */
  via?: "snaptrade";
  /** "Connect with your API key". */
  title: string;
  /** One line for the broker list. */
  summary: string;
  environments: ConnectEnvironmentOption[];
  /** What the user needs before starting. */
  prerequisites?: string[];
  /** Numbered steps, in order. */
  steps: string[];
  /** api_key and oauth2_user_app: the fields to paste. */
  fields?: ConnectField[];
  /** A caution shown before the steps (a key regeneration breaking other tools). */
  warning?: string;
  /** What Nasscord can and cannot do with this access. */
  disclosure: string;
  /** OAuth scopes Nasscord asks for, in plain words. */
  scopes?: string;
  /** A consent text the user accepts before leaving Nasscord (Tradier's partner exhibit). */
  consent?: string;
  /** How long a login lasts and what Reconnect asks for. */
  sessionNote: string;
  /** Warn this many hours before the session ends ("Session ending soon"). Default 2. */
  reconnectWarnHours?: number;
  /** Shown in the Disconnect confirmation. */
  disconnectNote: string;
  /** Shown when this way is not available to the user ("Not available yet: ..."). */
  unavailableReason: string;
  /** The broker's own page for the setup steps. */
  docsUrl?: string;
}

/** Why a connect method is not available right now (GET /api/broker/options). */
export type ConnectReasonCode = "not_built" | "not_configured" | "off" | "owner_only" | "no_environment";

/** One way of connecting as the broker service offers it to the signed-in user right now. */
export interface ConnectOption {
  brokerId: BrokerId;
  method: ConnectionMethod;
  client: ConnectClient | null;
  flow: ConnectFlow;
  /** Environments this server offers (no sandbox in production). */
  environments: ConnectionEnvironment[];
  audience: ConnectAudience;
  /** The broker's adapter is in the service. */
  built: boolean;
  /** Its credentials and callback are set on the server. */
  configured: boolean;
  /** The user may connect this way now. */
  available: boolean;
  reasonCode: ConnectReasonCode | null;
  /** A sentence for the user when not available (the owner sees which setting is missing). */
  reason: string | null;
  /** OAuth and aggregator flows: the one callback URL registered with the broker. */
  callbackUrl: string | null;
}

/** GET /api/broker/options. */
export interface BrokerOptions {
  /** The canonical origin every broker returns to (https://nasscord.com), or null when unset. */
  callbackBase: string | null;
  options: ConnectOption[];
}

/** What Reconnect asks the user to do next (POST /api/broker/connections/[id]/renew). */
export type RenewNext =
  /** IBKR: open /api/broker/ibkr/login/[id]. */
  | { kind: "gateway_login" }
  /** E*TRADE: approve again on authorizeUrl and paste the new code. */
  | { kind: "oauth1_verifier"; authorizeUrl: string }
  /** Alpaca, Tradier token: paste the key again (replace-key mode for this connection). */
  | { kind: "api_key" }
  /** OAuth, SnapTrade: open `url` (the canonical hop) for a new login at the broker. */
  | { kind: "redirect"; url?: string };

export type PlanId = "starter" | "pro" | "desk" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  monthly: number | null; // null = custom
  yearly: number | null; // per month, billed yearly
  featured?: boolean;
  cta: string;
  features: string[];
  limits: { brokers: number | "unlimited"; seats: number | "unlimited"; alertDelayMin: number };
}

/** What a tenant gets. Every tenant earns commission; white-label is an add-on the super admin grants. */
export type TenantOfferId = "commission" | "white_label";

export interface TenantOffer {
  id: TenantOfferId;
  name: string;
  summary: string;
  pricing: string;
  bullets: string[];
}

export type WorkspaceStatus = "active" | "trial" | "past_due" | "suspended";

/** A white-label tenant's brand on the terminal its traders use. */
export interface TenantBranding {
  name: string;
  /** Light and dark accent hex. Flows into --primary / --ring / --sidebar-primary. */
  accent: string;
  accentDark: string;
  domain?: string;
  supportEmail?: string;
}

export interface WorkspaceFeatures {
  tradescope: boolean;
  options: boolean;
  extendedHours: boolean;
  paperDefault: boolean;
}

/**
 * A trading workspace (`public.workspaces`): one trader's desk, or a small team on one book.
 * On screen the console calls these "Traders". Fields without a real source yet are optional.
 */
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: WorkspaceStatus;
  createdAt: string;
  /** Members whose workspace this is. */
  seats: number;
  /** Seats the plan allows. Absent = unlimited. */
  seatLimit?: number;
  /** Monthly recurring revenue. No billing source yet, so absent. */
  mrr?: number;
  /** Brokers with a connection in this workspace. */
  brokers: BrokerId[];
  /** The tenant this workspace came through; its users are tenant users. Absent = organic traders. */
  tenantId?: string;
  owner: { name: string; email: string };
  /** Per-workspace feature flags. No source yet, so absent. */
  features?: WorkspaceFeatures;
  timezone: string;
}

/** superadmin = the platform owner: console, tenant portal and their own terminal ·
 *  tenant = a distributor who earns commission on the traders they bring (white-label when the super admin grants it) ·
 *  trader = an organic user who signed up directly · tenant_user = a trader who belongs to a tenant */
export type Role = "superadmin" | "tenant" | "trader" | "tenant_user";

/** A member (`public.members`) with what Supabase Auth knows about their sign-ins. */
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The workspace the user trades in. Absent for a tenant's own login. */
  workspaceId?: string;
  /** The tenant a tenant user belongs to, or the one a tenant login runs. */
  tenantId?: string;
  /** A verified second factor is enrolled in Supabase Auth. Absent when unknown. */
  twoFactor?: boolean;
  /** Last sign-in from Supabase Auth. Absent when the user never signed in or it is unknown. */
  lastActiveAt?: string;
  createdAt: string;
}

/** The signed-in user: verified Supabase claims joined with their `members` row. */
export interface Session {
  /** auth.users.id */
  uid: string;
  name: string;
  email: string;
  role: Role;
  /** Workspace slug the terminal opens. Absent for a tenant's own login. */
  workspace?: string;
  /** Workspace id (uuid). Absent for a tenant's own login. */
  workspaceId?: string;
  /** The tenant a tenant user belongs to, or the one a tenant login runs. */
  tenantId?: string;
}

/** Per-user trading defaults (`public.user_settings`). */
export interface UserSettings {
  /** Percent of net liquidation risked per trade, 0 < x <= 5. */
  riskPct: number;
  paperMode: boolean;
  extendedHours: boolean;
  emailAlerts: boolean;
  pushAlerts: boolean;
  smsAlerts: boolean;
  /** broker_accounts.id, or null when none is picked. */
  defaultAccountId: string | null;
  updatedAt?: string;
}

export type AccountType = "individual" | "ira" | "roth" | "margin" | "paper";

/** One account under a broker connection (`public.broker_accounts`). */
export interface BrokerAccount {
  /** broker_accounts.id (uuid). Positions, orders and executions refer to accounts by this id. */
  id: string;
  /** The connection this account came through. */
  connectionId?: string;
  brokerId: BrokerId;
  label: string;
  /** Masked number for display (broker_accounts.display_number), never the full number. */
  masked: string;
  type: AccountType;
  /** Balances come from the broker while the connection is active, and are absent otherwise. */
  netLiq?: number;
  buyingPower?: number;
  cash?: number;
  dayPnl?: number;
  currency?: string;
  /** Counts toward totals and feeds positions, orders and executions. */
  included: boolean;
}

/**
 * How a connection talks to the broker (`broker_connections.method`). Each method serves one broker,
 * except `snaptrade`, which reads Fidelity, Robinhood, Public, Moomoo and Webull through SnapTrade.
 * `ibkr_oauth` is reserved and has no adapter yet.
 */
export type ConnectionMethod =
  | "ibkr_gateway"
  | "ibkr_oauth"
  | "etrade_oauth1"
  | "alpaca_key"
  | "alpaca_oauth"
  | "tradier_token"
  | "tradier_oauth"
  | "schwab_oauth"
  | "tastytrade_oauth"
  | "tradestation_oauth"
  | "webull_oauth"
  | "snaptrade";
/**
 * production = the user's real account (shown as "Live") · paper = the user's own paper account ·
 * sandbox = a broker's sample data, for developers only, never offered in production and shown as
 * "Sandbox · sample data".
 */
export type ConnectionEnvironment = "production" | "sandbox" | "paper";

/**
 * DB `active` maps to `connected`, or to `expiring` when the session ends within the broker's warn
 * window (2 hours; 48 hours for Schwab's weekly login). The other values match
 * `broker_connections.status`.
 */
export type ConnectionStatus = "connected" | "expiring" | "pending" | "expired" | "error" | "disconnected";

/** One login at one broker (`public.broker_connections`) with its accounts. */
export interface BrokerConnection {
  /** broker_connections.id (uuid). */
  id: string;
  brokerId: BrokerId;
  method: ConnectionMethod;
  environment: ConnectionEnvironment;
  status: ConnectionStatus;
  /** Plain-language reason shown next to the status. */
  statusDetail?: string;
  /** When the connection was created. */
  connectedAt?: string;
  /** Last time the broker answered for this connection. */
  lastOkAt?: string;
  tokenRenewsAt?: string;
  /** When the login ends on its own (E*TRADE midnight, IBKR about a day, Schwab 7 days). */
  sessionExpiresAt?: string;
  /** When the broker or aggregator last synced what Nasscord reads ("updated 8 min ago", SnapTrade). */
  dataAsOf?: string;
  /** OAuth scope the broker granted, e.g. "read market". */
  scope?: string;
  accounts: BrokerAccount[];
  /** What Nasscord may do through the connection. The first release is read-only. */
  permissions: Array<"read" | "trade" | "options">;
  /** Workspace the connection belongs to (console views). */
  workspaceId?: string;
  note?: string;
}

export type AlertStatus = "open" | "target" | "stop";

export interface AlertNews {
  sentiment: "bullish" | "bearish" | "neutral";
  headline?: string;
  reason?: string;
  source?: string;
}

export interface Alert {
  id: number;
  symbol: string;
  company: string;
  timeframe: "15m";
  score: number;
  reasons: string[];
  rsi: number;
  adx: number;
  relVol: number;
  atrPct: number;
  atr: number;
  entry: number;
  /** Current stop (may have trailed to breakeven). */
  stop: number;
  /** Original stop = entry - 2.2 x ATR. */
  stop0: number;
  target: number;
  riskReward: number;
  status: AlertStatus;
  movedBE: boolean;
  ticks: number;
  openedAt: string;
  closedAt?: string;
  closePrice?: number;
  resultPct?: number;
  news?: AlertNews;
  spark: number[];
  last: number;
}

export interface Position {
  id: string;
  /** broker_accounts.id of the account holding it. */
  accountId: string;
  brokerId: BrokerId;
  symbol: string;
  qty: number;
  /** Average cost per share (per unit of the underlying for an option). Absent when the broker sent none. */
  avgCost?: number;
  /** Last price. Absent when the broker sent none: the position is never shown at a made-up 0. */
  last?: number;
  /** Today's P&L on the position, when the broker reports it per position. */
  dayPnl?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  currency?: string;
  /** Broker security type, e.g. "STK", "OPT", "EQ". */
  secType?: string;
  alertId?: number;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MKT" | "LMT" | "STP" | "MIT" | "TRAIL";
export type Tif = "GTC" | "DAY";
export type OrderStatus = "submitted" | "verifying" | "working" | "verified" | "filled" | "cancelled" | "rejected";

export interface Order {
  id: string;
  /** Nasscord's own order id. Absent for orders placed outside Nasscord. */
  clientId?: string;
  accountId: string;
  brokerId: BrokerId;
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
  price?: number;
  trailPct?: number;
  tif: Tif;
  status: OrderStatus;
  placedAt: string;
  filledQty?: number;
  avgFill?: number;
  parentId?: string;
  outsideRth?: boolean;
  brokerRef?: string;
}

export interface Execution {
  id: string;
  accountId: string;
  brokerId: BrokerId;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  commission: number;
  net: number;
  tradedAt: string;
  provisional?: boolean;
}

export interface Ticker {
  symbol: string;
  last: number;
  changePct: number;
}

export type InvoiceStatus = "paid" | "open" | "past_due" | "void";

export interface Invoice {
  id: string;
  workspaceId: string;
  workspaceName: string;
  amount: number;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
}

/** Matches `tenants.status`. */
export type TenantStatus = "active" | "pending" | "suspended";

/** A distributor (`public.tenants`). Brings traders to the platform and earns commission on their subscriptions. */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  /** The owner's email. Absent until an owner is assigned. */
  contact?: string;
  ownerId?: string;
  /** Workspaces that signed up through this tenant. */
  workspaces: number;
  /** Commission on the subscription revenue of this tenant's traders, percent. */
  commissionPct: number;
  /** No billing source yet, so absent. */
  mtdRevenue?: number;
  mtdPayout?: number;
  status: TenantStatus;
  /** Code a trader types at signup to join this tenant. Upper case. */
  referralCode?: string;
  createdAt: string;
  /** Granted by the super admin from the console's White-label page. */
  whiteLabel: boolean;
  branding?: TenantBranding;
}

export type TenantApplicationStatus = "pending" | "approved" | "declined";

/** Someone asking to become a tenant (`public.tenant_applications`). */
export interface TenantApplication {
  id: string;
  /** The person who applied. */
  name: string;
  company: string;
  email: string;
  /** Same as `email`: the address to reply to. */
  contact: string;
  offer: TenantOfferId;
  /** Asked for white-label on top of commission. The super admin decides. */
  wantsWhiteLabel: boolean;
  expectedTraders?: number;
  /** "120 expected traders", when the applicant said. */
  audience?: string;
  notes?: string;
  status: TenantApplicationStatus;
  submittedAt: string;
}

/** A request to support another broker (`public.broker_requests`). */
export interface BrokerRequest {
  id: string;
  brokerName: string;
  email: string;
  createdAt: string;
}

export interface Payout {
  id: string;
  tenantId: string;
  period: string;
  amount: number;
  status: "scheduled" | "paid" | "on_hold";
  paidAt?: string;
}

export type HealthStatus = "healthy" | "degraded" | "down";

export interface ServiceHealth {
  id: string;
  name: string;
  role: string;
  instances: number;
  status: HealthStatus;
  uptime30d: number;
  p95Ms: number;
  lastRestartAt: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: "minor" | "major" | "critical";
  status: "open" | "monitoring" | "resolved";
  startedAt: string;
  resolvedAt?: string;
  summary: string;
}

/** One row of `public.audit_events`. */
export interface AuditEvent {
  id: string;
  at: string;
  /** The actor's email, "system" (the broker service) or "anonymous" (a request nobody was signed in for). */
  actor: string;
  action: string;
  /** What the action touched; empty when nothing specific. */
  target: string;
  /** Client address, when known. */
  ip?: string;
  result: "ok" | "denied" | "error";
  workspaceId?: string;
  meta?: Record<string, unknown>;
}

/** Platform-wide counts for the console overview, all read from the database. */
export interface PlatformCounts {
  workspaces: number;
  workspacesByStatus: Record<WorkspaceStatus, number>;
  workspacesByPlan: Record<PlanId, number>;
  tenants: number;
  membersByRole: Record<Role, number>;
  connections: number;
  connectionsByBroker: Partial<Record<BrokerId, number>>;
  connectionsByStatus: Partial<Record<ConnectionStatus, number>>;
  pendingApplications: number;
  brokerRequests: number;
}

export interface BacktestStats {
  riskPerTrade: number;
  symbols: number;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  profitFactor: number;
  expectancyR: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  maxConsecLosses: number;
}

export interface EngineParams {
  universeSize: number;
  timeframe: "5m" | "15m" | "1h";
  minScore: number;
  maxOpen: number;
  atrStopMultiple: number;
  rewardToRisk: number;
  trailToBreakeven: boolean;
  newsModelMarketHoursOnly: boolean;
}

export interface SeriesPoint {
  label: string;
  [key: string]: string | number;
}
