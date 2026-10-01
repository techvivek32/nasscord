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

export type PartnerModel = "white_label" | "referral" | "embedded";

export interface PartnerModelInfo {
  id: PartnerModel;
  name: string;
  summary: string;
  pricing: string;
  bullets: string[];
}

export type TenantStatus = "active" | "trial" | "past_due" | "suspended";

export interface TenantBranding {
  name: string;
  /** Light and dark accent hex. Flows into --primary / --ring / --sidebar-primary. */
  accent: string;
  accentDark: string;
  domain?: string;
  supportEmail?: string;
}

export interface TenantFeatures {
  tradescope: boolean;
  options: boolean;
  extendedHours: boolean;
  paperDefault: boolean;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: PlanId;
  status: TenantStatus;
  createdAt: string;
  seats: number;
  seatLimit: number;
  mrr: number;
  brokers: BrokerId[];
  whiteLabel: boolean;
  branding?: TenantBranding;
  partnerId?: string;
  owner: { name: string; email: string };
  features: TenantFeatures;
  timezone: string;
}

/** owner / trader / viewer = seats in a tenant workspace · operator = platform staff (console) ·
 *  superadmin = the platform owner: console, partner portal and their own terminal · partner = partner portal */
export type Role = "owner" | "trader" | "viewer" | "operator" | "superadmin" | "partner";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
  twoFactor: boolean;
  lastActiveAt: string;
  createdAt: string;
}

export interface Session {
  uid: string;
  name: string;
  email: string;
  role: Role;
  tenant: string; // slug
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
  tenantId: string;
  tenantName: string;
  amount: number;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
}

export type PartnerStatus = "active" | "pending" | "paused";

export interface Partner {
  id: string;
  name: string;
  model: PartnerModel;
  contact: string;
  tenants: number;
  revShare: number; // percent
  mtdRevenue: number;
  mtdPayout: number;
  status: PartnerStatus;
  referralCode: string;
  createdAt: string;
}

export interface Payout {
  id: string;
  partnerId: string;
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
