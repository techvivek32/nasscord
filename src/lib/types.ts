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

/** live = trading through the broker API · beta = limited order types ·
 *  sync = read-only positions/balances via aggregator · soon = not yet available */
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
}

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
 * A trading workspace: one trader's desk, or a small team on one book. The unit the platform bills.
 * On screen the console calls these "Traders".
 */
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: WorkspaceStatus;
  createdAt: string;
  seats: number;
  seatLimit: number;
  mrr: number;
  brokers: BrokerId[];
  /** The tenant this workspace came through; its users are tenant users. Absent = organic traders. */
  tenantId?: string;
  owner: { name: string; email: string };
  features: WorkspaceFeatures;
  timezone: string;
}

/** superadmin = the platform owner: console, tenant portal and their own terminal ·
 *  tenant = a distributor who earns commission on the traders they bring (white-label when the super admin grants it) ·
 *  trader = an organic user who signed up directly · tenant_user = a trader who belongs to a tenant */
export type Role = "superadmin" | "tenant" | "trader" | "tenant_user";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The workspace the user trades in. Absent for a tenant's own login. */
  workspaceId?: string;
  /** The tenant a tenant user belongs to, or the one a tenant login runs. */
  tenantId?: string;
  twoFactor: boolean;
  lastActiveAt: string;
  createdAt: string;
}

export interface Session {
  uid: string;
  name: string;
  email: string;
  role: Role;
  /** Workspace slug the terminal opens. Absent for a tenant's own login. */
  workspace?: string;
  /** The tenant a tenant user belongs to, or the one a tenant login runs. */
  tenantId?: string;
}

export type AccountType = "individual" | "ira" | "roth" | "margin" | "paper";

export interface BrokerAccount {
  id: string;
  brokerId: BrokerId;
  label: string;
  masked: string;
  type: AccountType;
  netLiq: number;
  buyingPower: number;
  cash: number;
  dayPnl: number;
  included: boolean;
}

export type ConnectionStatus = "connected" | "expiring" | "disconnected" | "syncing";

export interface BrokerConnection {
  brokerId: BrokerId;
  status: ConnectionStatus;
  connectedAt: string;
  tokenRenewsAt?: string;
  sessionExpiresAt?: string;
  accounts: BrokerAccount[];
  permissions: Array<"read" | "trade" | "options">;
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
  accountId: string;
  brokerId: BrokerId;
  symbol: string;
  qty: number;
  avgCost: number;
  last: number;
  dayPnl: number;
  alertId?: number;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MKT" | "LMT" | "STP" | "MIT" | "TRAIL";
export type Tif = "GTC" | "DAY";
export type OrderStatus = "submitted" | "verifying" | "working" | "verified" | "filled" | "cancelled" | "rejected";

export interface Order {
  id: string;
  clientId: string;
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

export type TenantStatus = "active" | "pending" | "paused";

/** A distributor. Brings traders to the platform and earns commission on their subscriptions. */
export interface Tenant {
  id: string;
  name: string;
  contact: string;
  /** Workspaces that signed up through this tenant. */
  workspaces: number;
  /** Commission on the subscription revenue of this tenant's traders, percent. */
  commissionPct: number;
  mtdRevenue: number;
  mtdPayout: number;
  status: TenantStatus;
  referralCode: string;
  createdAt: string;
  /** Granted by the super admin from the console's White-label page. */
  whiteLabel: boolean;
  branding?: TenantBranding;
}

/** Someone asking to become a tenant. */
export interface TenantApplication {
  id: string;
  name: string;
  contact: string;
  audience: string;
  /** Asked for white-label on top of commission. The super admin decides. */
  wantsWhiteLabel: boolean;
  submittedAt: string;
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

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  ip: string;
  result: "ok" | "denied" | "error";
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
