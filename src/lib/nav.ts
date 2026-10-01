import type { LucideIcon } from "lucide-react";
import {
  Activity, BarChart3, Bell, BookOpen, Briefcase, Building2, ChartCandlestick, ClipboardList, CreditCard, Gauge, Handshake,
  History, Layers, LineChart, ListOrdered, Palette, PlugZap, Radar, ScrollText, Settings, ShieldCheck, Users, Wallet,
} from "lucide-react";
import type { AreaId } from "@/lib/roles";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** One plain sentence on what the page is for. The intro tour reads it, so the tour and the sidebar never drift apart. */
  description: string;
  badge?: string;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/** Trader terminal (tenant scoped). */
export const TERMINAL_NAV: NavGroup[] = [
  {
    label: "Trade",
    items: [
      { title: "Alerts", href: "/app", icon: Bell, description: "Trade setups from the TradeScope scanner, each with an entry, a stop and a target. Buy loads the order ticket." },
      { title: "Positions", href: "/app/positions", icon: Briefcase, description: "Everything you hold across every connected account, with P&L. Close a position from here." },
      { title: "Orders", href: "/app/orders", icon: ListOrdered, description: "Working, filled and cancelled orders. Cancel an order or its whole bracket." },
      { title: "Options", href: "/app/options", icon: Layers, description: "Call ideas on the top alerts, sized by a capital-risk preset." },
    ],
  },
  {
    label: "Research",
    items: [
      { title: "Watchlist", href: "/app/watchlist", icon: BookOpen, description: "Symbols you follow, with price, change and any open alert." },
      { title: "Scanner", href: "/app/scanner", icon: Radar, description: "Run your own ADX, RSI and volume filters across the scan universe." },
      { title: "History", href: "/app/history", icon: History, description: "Every execution by trading day, with commissions." },
      { title: "Analysis", href: "/app/analysis", icon: LineChart, description: "Equity curve, daily P&L and the engine's backtest." },
    ],
  },
  {
    label: "Account",
    items: [
      { title: "Brokers", href: "/app/brokers", icon: PlugZap, description: "Connect brokers and choose which accounts count toward your totals." },
      { title: "Settings", href: "/app/settings", icon: Settings, description: "Profile, notifications, risk per trade, security and billing." },
    ],
  },
];

/** Super admin console. */
export const CONSOLE_NAV: NavGroup[] = [
  {
    items: [{ title: "Overview", href: "/admin", icon: Gauge, description: "Revenue, traders, tenants and broker health at a glance." }],
  },
  {
    label: "Customers",
    items: [
      { title: "Traders", href: "/admin/traders", icon: Building2, description: "Every trading workspace, organic or through a tenant. Open one to change its plan, limits or features, or to suspend it." },
      { title: "Tenants", href: "/admin/tenants", icon: Handshake, description: "Distributors who bring traders and earn commission: applications, commission and payouts." },
      { title: "Users", href: "/admin/users", icon: Users, description: "Everyone who can sign in: tenants, traders and tenant users. Invite, reset 2FA or remove a login." },
    ],
  },
  {
    label: "White-label",
    items: [
      { title: "White-label", href: "/admin/white-label", icon: Palette, description: "Turn white-label on for a tenant and set the name, accent color and domain their traders see." },
    ],
  },
  {
    label: "Platform",
    items: [
      { title: "Brokers", href: "/admin/brokers", icon: PlugZap, description: "Every broker integration. Turn one on or off for all traders and watch rate limits." },
      { title: "Plans & Billing", href: "/admin/billing", icon: CreditCard, description: "Plan prices and entitlements, and this month's invoices." },
      { title: "Revenue", href: "/admin/revenue", icon: BarChart3, description: "Recurring revenue against infrastructure cost, and revenue by plan." },
      { title: "Alert Engine", href: "/admin/engine", icon: Radar, description: "TradeScope scan settings and the symbol universe, for every trader." },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "System Health", href: "/admin/health", icon: Activity, description: "Service status, restarts, incidents and the maintenance gate." },
      { title: "Audit Log", href: "/admin/audit", icon: ScrollText, description: "Who did what, when and from where." },
      { title: "Settings", href: "/admin/settings", icon: Settings, description: "Platform identity, branding defaults, security, API keys and email." },
    ],
  },
];

/** Tenant portal: commission for every tenant, white-label pages for the ones the super admin granted it. */
export const TENANT_NAV: NavGroup[] = [
  {
    items: [{ title: "Overview", href: "/tenant", icon: Gauge, description: "Traders you brought, the commission they earn you and your next payout." }],
  },
  {
    label: "Program",
    items: [
      { title: "Referrals", href: "/tenant/referrals", icon: Handshake, description: "Your referral codes and the funnel from click to paid account." },
      { title: "Traders", href: "/tenant/traders", icon: Building2, description: "Branded workspaces you run for your traders. Needs white-label." },
      { title: "Payouts", href: "/tenant/payouts", icon: Wallet, description: "Commission history, statements and the bank account payouts go to." },
    ],
  },
  {
    label: "White-label",
    items: [
      { title: "Branding", href: "/tenant/branding", icon: Layers, description: "Your name, accent color, domain and emails on the terminal. Needs white-label." },
      { title: "Plans", href: "/tenant/plans", icon: ClipboardList, description: "The plans and prices your traders see. Needs white-label." },
    ],
  },
  {
    label: "Account",
    items: [{ title: "Settings", href: "/tenant/settings", icon: ShieldCheck, description: "Contacts, notifications, API keys and your agreement." }],
  },
];

/**
 * Shell navs by id. Server layouts pass the id to the client AppShell, which looks the
 * config up here: icon components are functions and cannot cross the server/client boundary as props.
 */
export const SHELL_NAVS = {
  terminal: TERMINAL_NAV,
  console: CONSOLE_NAV,
  tenant: TENANT_NAV,
} satisfies Record<AreaId, NavGroup[]>;

export type ShellNavId = keyof typeof SHELL_NAVS;

/** The three signed-in areas, as the area switcher and the tours name them. Who may open which one is in lib/roles. */
export const SHELL_AREAS: Record<ShellNavId, { title: string; description: string; href: string; icon: LucideIcon }> = {
  terminal: { title: "Terminal", description: "Trade: alerts, orders and positions", href: "/app", icon: ChartCandlestick },
  console: { title: "Console", description: "Run the platform: customers, billing, health", href: "/admin", icon: Gauge },
  tenant: { title: "Tenant portal", description: "Referrals, commission and white-label", href: "/tenant", icon: Handshake },
};

export const MARKETING_NAV: Array<{ title: string; href: string }> = [
  { title: "Platform", href: "/#platform" },
  { title: "Brokers", href: "/brokers" },
  { title: "Pricing", href: "/pricing" },
  { title: "Tenants", href: "/tenants" },
  { title: "Security", href: "/security" },
];
