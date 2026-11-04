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
      { title: "Alerts", href: "/app", icon: Bell, description: "TradeScope alerts, once the engine is connected to your workspace, and a ticket that sizes a trade to your risk." },
      { title: "Positions", href: "/app/positions", icon: Briefcase, description: "Everything you hold across your connected IBKR and E*TRADE accounts, with P&L." },
      { title: "Orders", href: "/app/orders", icon: ListOrdered, description: "Working, filled and cancelled orders from your brokers. Read only in this release." },
      { title: "Options", href: "/app/options", icon: Layers, description: "Option ideas from TradeScope alerts. Not connected yet." },
    ],
  },
  {
    label: "Research",
    items: [
      { title: "Watchlist", href: "/app/watchlist", icon: BookOpen, description: "Symbols you follow on this device, and what you hold in each." },
      { title: "Scanner", href: "/app/scanner", icon: Radar, description: "Your own TradeScope filters. Needs a market data feed, not connected yet." },
      { title: "History", href: "/app/history", icon: History, description: "Every execution your brokers report, by trading day, with commissions." },
      { title: "Analysis", href: "/app/analysis", icon: LineChart, description: "Equity history and daily P&L, once they are stored. Not connected yet." },
    ],
  },
  {
    label: "Account",
    items: [
      { title: "Brokers", href: "/app/brokers", icon: PlugZap, description: "Connect IBKR or E*TRADE and choose which accounts count toward your totals." },
      { title: "Settings", href: "/app/settings", icon: Settings, description: "Profile, notifications, risk per trade and password reset." },
    ],
  },
];

/** Super admin console. */
export const CONSOLE_NAV: NavGroup[] = [
  {
    items: [{ title: "Overview", href: "/admin", icon: Gauge, description: "Traders, tenants, users and broker connections at a glance." }],
  },
  {
    label: "Customers",
    items: [
      { title: "Traders", href: "/admin/traders", icon: Building2, description: "Every trading workspace, organic or through a tenant. Open one to change its plan or status." },
      { title: "Tenants", href: "/admin/tenants", icon: Handshake, description: "Distributors who bring traders: applications, new tenants and their referral codes." },
      { title: "Users", href: "/admin/users", icon: Users, description: "Everyone who can sign in, with their role and workspace or tenant." },
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
      { title: "Brokers", href: "/admin/brokers", icon: PlugZap, description: "Connections per broker and the health of the broker service." },
      { title: "Plans & Billing", href: "/admin/billing", icon: CreditCard, description: "The plan list. Billing is not connected yet." },
      { title: "Revenue", href: "/admin/revenue", icon: BarChart3, description: "Revenue reporting. Not connected yet." },
      { title: "Alert Engine", href: "/admin/engine", icon: Radar, description: "TradeScope scan settings, read only. Live scan status is not connected yet." },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "System Health", href: "/admin/health", icon: Activity, description: "Whether the broker service and the database answer." },
      { title: "Audit Log", href: "/admin/audit", icon: ScrollText, description: "Who did what, when and from where." },
      { title: "Settings", href: "/admin/settings", icon: Settings, description: "The platform name and domain, read only." },
    ],
  },
];

/** Tenant portal: commission for every tenant, white-label pages for the ones the super admin granted it. */
export const TENANT_NAV: NavGroup[] = [
  {
    items: [{ title: "Overview", href: "/tenant", icon: Gauge, description: "The traders you brought and your referral link." }],
  },
  {
    label: "Program",
    items: [
      { title: "Referrals", href: "/tenant/referrals", icon: Handshake, description: "Your referral code and link. Funnel tracking comes later." },
      { title: "Traders", href: "/tenant/traders", icon: Building2, description: "The workspaces created with your code and the people who sign in to them." },
      { title: "Payouts", href: "/tenant/payouts", icon: Wallet, description: "Commission payouts. Not connected yet." },
    ],
  },
  {
    label: "White-label",
    items: [
      { title: "Branding", href: "/tenant/branding", icon: Layers, description: "Your name, accent color, domain and emails on the terminal. Needs white-label." },
      { title: "Plans", href: "/tenant/plans", icon: ClipboardList, description: "Your own plans and prices for your traders. Not connected yet." },
    ],
  },
  {
    label: "Account",
    items: [{ title: "Settings", href: "/tenant/settings", icon: ShieldCheck, description: "Your tenant's name, code, status and commission rate." }],
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
  terminal: { title: "Terminal", description: "Your accounts, positions and orders", href: "/app", icon: ChartCandlestick },
  console: { title: "Console", description: "Run the platform: traders, tenants, health", href: "/admin", icon: Gauge },
  tenant: { title: "Tenant portal", description: "Referrals, commission and white-label", href: "/tenant", icon: Handshake },
};

export const MARKETING_NAV: Array<{ title: string; href: string }> = [
  { title: "Platform", href: "/#platform" },
  { title: "Brokers", href: "/brokers" },
  { title: "Pricing", href: "/pricing" },
  { title: "Tenants", href: "/tenants" },
  { title: "Security", href: "/security" },
];
