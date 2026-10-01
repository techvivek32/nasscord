import type { AuditEvent, BrokerId, Incident, Invoice, Payout, ServiceHealth, TenantApplication, User } from "@/lib/types";
import { WORKSPACES } from "@/lib/mock/workspaces";

/* ---------------- KPIs ---------------- */
export const PLATFORM_KPIS = {
  mrr: 48_920,
  mrrDeltaPct: 6.2,
  activeWorkspaces: 312,
  newWorkspacesThisMonth: 18,
  connectedAccounts: 1_184,
  trialToPaidPct: 31,
  trialToPaidDeltaPts: 2.4,
  alertsSentToday: 2_310,
  churnPct: 2.1,
  churnDeltaPts: -0.3,
  tenants: 8,
  tenantSourcedMrr: 12_480,
  payoutsMtd: 3_120,
  pendingApplications: 3,
};

export const MRR_HISTORY: { label: string; mrr: number; infra: number }[] = [
  { label: "Oct 25", mrr: 18_400, infra: 6_100 },
  { label: "Nov 25", mrr: 20_100, infra: 6_300 },
  { label: "Dec 25", mrr: 22_650, infra: 6_900 },
  { label: "Jan 26", mrr: 26_300, infra: 7_400 },
  { label: "Feb 26", mrr: 29_800, infra: 7_900 },
  { label: "Mar 26", mrr: 33_900, infra: 8_600 },
  { label: "Apr 26", mrr: 36_200, infra: 9_100 },
  { label: "May 26", mrr: 38_700, infra: 9_400 },
  { label: "Jun 26", mrr: 41_100, infra: 9_900 },
  { label: "Jul 26", mrr: 43_600, infra: 10_300 },
  { label: "Aug 26", mrr: 46_050, infra: 10_800 },
  { label: "Sep 26", mrr: 48_920, infra: 11_200 },
];

export const SIGNUPS_BY_PLAN: { label: string; starter: number; pro: number; desk: number }[] = [
  { label: "W27", starter: 14, pro: 6, desk: 1 },
  { label: "W28", starter: 17, pro: 8, desk: 2 },
  { label: "W29", starter: 12, pro: 7, desk: 1 },
  { label: "W30", starter: 19, pro: 9, desk: 2 },
  { label: "W31", starter: 21, pro: 11, desk: 3 },
  { label: "W32", starter: 16, pro: 10, desk: 2 },
  { label: "W33", starter: 23, pro: 12, desk: 2 },
  { label: "W34", starter: 20, pro: 13, desk: 4 },
  { label: "W35", starter: 25, pro: 14, desk: 3 },
  { label: "W36", starter: 22, pro: 15, desk: 3 },
  { label: "W37", starter: 27, pro: 16, desk: 4 },
  { label: "W38", starter: 24, pro: 18, desk: 5 },
];

export const REVENUE_BY_PLAN: { label: string; starter: number; pro: number; desk: number; enterprise: number }[] = [
  { label: "Apr", starter: 0, pro: 14_200, desk: 6_900, enterprise: 15_100 },
  { label: "May", starter: 0, pro: 15_400, desk: 7_300, enterprise: 16_000 },
  { label: "Jun", starter: 0, pro: 16_300, desk: 7_800, enterprise: 17_000 },
  { label: "Jul", starter: 0, pro: 17_500, desk: 8_100, enterprise: 18_000 },
  { label: "Aug", starter: 0, pro: 18_650, desk: 8_600, enterprise: 18_800 },
  { label: "Sep", starter: 0, pro: 19_900, desk: 9_020, enterprise: 20_000 },
];

export const BROKER_HEALTH: { brokerId: BrokerId; accounts: number; healthyPct: number; failing: number; lastIncidentAt?: string }[] = [
  { brokerId: "ibkr", accounts: 412, healthyPct: 96.8, failing: 13, lastIncidentAt: "2026-09-28T13:10:00Z" },
  { brokerId: "schwab", accounts: 366, healthyPct: 99.2, failing: 3, lastIncidentAt: "2026-09-12T15:40:00Z" },
  { brokerId: "etrade", accounts: 121, healthyPct: 98.3, failing: 2 },
  { brokerId: "tastytrade", accounts: 88, healthyPct: 100, failing: 0 },
  { brokerId: "alpaca", accounts: 97, healthyPct: 100, failing: 0 },
  { brokerId: "tradestation", accounts: 41, healthyPct: 97.6, failing: 1 },
  { brokerId: "fidelity", accounts: 39, healthyPct: 94.9, failing: 2, lastIncidentAt: "2026-09-29T09:05:00Z" },
  { brokerId: "robinhood", accounts: 20, healthyPct: 95.0, failing: 1 },
];

export const GATEWAY_POOLS = [
  { id: "ibkr-pool-a", broker: "ibkr" as BrokerId, ports: "7175–7199", sessions: 24, healthy: 22, region: "us-east-1" },
  { id: "ibkr-pool-b", broker: "ibkr" as BrokerId, ports: "7200–7224", sessions: 24, healthy: 24, region: "us-east-1" },
  { id: "ibkr-pool-c", broker: "ibkr" as BrokerId, ports: "7225–7249", sessions: 18, healthy: 18, region: "us-west-2" },
];

/* ---------------- Users ---------------- */
export const USERS: User[] = [
  { id: "u_vivek", name: "Vivek Desai", email: "vivek@nasscord.com", role: "superadmin", workspaceId: "w_vivek", twoFactor: true, lastActiveAt: "2026-09-30T18:50:00Z", createdAt: "2026-06-12T14:02:00Z" },
  { id: "u_dana", name: "Dana Whitfield", email: "dana@acmecap.com", role: "tenant", tenantId: "t_acme", twoFactor: true, lastActiveAt: "2026-09-30T17:20:00Z", createdAt: "2026-03-04T09:30:00Z" },
  { id: "u_raj", name: "Raj Menon", email: "raj@acmecap.com", role: "tenant_user", workspaceId: "w_acme", tenantId: "t_acme", twoFactor: true, lastActiveAt: "2026-09-30T18:05:00Z", createdAt: "2026-03-10T12:00:00Z" },
  { id: "u_lena", name: "Lena Fischer", email: "lena@acmecap.com", role: "tenant_user", workspaceId: "w_acme", tenantId: "t_acme", twoFactor: false, lastActiveAt: "2026-09-29T21:10:00Z", createdAt: "2026-04-01T10:00:00Z" },
  { id: "u_marcus", name: "Marcus Lee", email: "marcus@riverbendtraders.com", role: "trader", workspaceId: "w_riverbend", twoFactor: true, lastActiveAt: "2026-09-30T16:44:00Z", createdAt: "2026-05-21T16:45:00Z" },
  { id: "u_ava", name: "Ava Robinson", email: "ava@riverbendtraders.com", role: "trader", workspaceId: "w_riverbend", twoFactor: false, lastActiveAt: "2026-09-30T15:12:00Z", createdAt: "2026-05-22T09:00:00Z" },
  { id: "u_priya", name: "Priya Nair", email: "priya@kiteandco.io", role: "tenant_user", workspaceId: "w_kite", tenantId: "t_tradetalk", twoFactor: false, lastActiveAt: "2026-09-30T02:30:00Z", createdAt: "2026-09-24T11:10:00Z" },
  { id: "u_elena", name: "Elena Marsh", email: "elena@northstarwealth.com", role: "tenant", tenantId: "t_northstar", twoFactor: true, lastActiveAt: "2026-09-30T14:00:00Z", createdAt: "2026-01-18T13:00:00Z" },
  { id: "u_tom", name: "Tom Alvarez", email: "tom@harborpoint.co", role: "trader", workspaceId: "w_harbor", twoFactor: true, lastActiveAt: "2026-09-27T19:00:00Z", createdAt: "2026-04-02T10:00:00Z" },
  { id: "u_jordan", name: "Jordan Martin", email: "jordan.martin@gmail.com", role: "trader", workspaceId: "w_jmartin", twoFactor: true, lastActiveAt: "2026-09-30T18:40:00Z", createdAt: "2026-07-30T18:20:00Z" },
  { id: "u_grace", name: "Grace Okafor", email: "grace@bluefinoptions.com", role: "tenant_user", workspaceId: "w_bluefin", tenantId: "t_optionsdaily", twoFactor: true, lastActiveAt: "2026-09-30T18:30:00Z", createdAt: "2026-02-27T15:15:00Z" },
];

/* ---------------- Billing ---------------- */
export const INVOICES: Invoice[] = [
  { id: "INV-2026-0931", workspaceId: "w_northstar", workspaceName: "Northstar Wealth", amount: 9_800, status: "paid", issuedAt: "2026-09-01T00:00:00Z", dueAt: "2026-09-15T00:00:00Z" },
  { id: "INV-2026-0930", workspaceId: "w_acme", workspaceName: "Acme Capital", amount: 4_120, status: "paid", issuedAt: "2026-09-01T00:00:00Z", dueAt: "2026-09-15T00:00:00Z" },
  { id: "INV-2026-0929", workspaceId: "w_riverbend", workspaceName: "Riverbend Traders", amount: 149, status: "paid", issuedAt: "2026-09-21T00:00:00Z", dueAt: "2026-09-28T00:00:00Z" },
  { id: "INV-2026-0928", workspaceId: "w_harbor", workspaceName: "Harbor Point Desk", amount: 149, status: "past_due", issuedAt: "2026-09-02T00:00:00Z", dueAt: "2026-09-09T00:00:00Z" },
  { id: "INV-2026-0927", workspaceId: "w_vivek", workspaceName: "Vivek's Desk", amount: 49, status: "paid", issuedAt: "2026-09-12T00:00:00Z", dueAt: "2026-09-19T00:00:00Z" },
  { id: "INV-2026-0926", workspaceId: "w_bluefin", workspaceName: "Bluefin Options", amount: 119, status: "open", issuedAt: "2026-09-27T00:00:00Z", dueAt: "2026-10-04T00:00:00Z" },
  { id: "INV-2026-0925", workspaceId: "w_jmartin", workspaceName: "J. Martin", amount: 39, status: "paid", issuedAt: "2026-09-30T00:00:00Z", dueAt: "2026-10-07T00:00:00Z" },
  { id: "INV-2026-0924", workspaceId: "w_lantern", workspaceName: "Lantern Family Office", amount: 149, status: "open", issuedAt: "2026-09-11T00:00:00Z", dueAt: "2026-10-11T00:00:00Z" },
  { id: "INV-2026-0923", workspaceId: "w_summit", workspaceName: "Summit Day Traders", amount: 49, status: "void", issuedAt: "2026-09-05T00:00:00Z", dueAt: "2026-09-12T00:00:00Z" },
];

/* ---------------- Tenants (the list itself is lib/mock/tenants.ts) ---------------- */
export const PAYOUTS: Payout[] = [
  { id: "po_1", tenantId: "t_tradetalk", period: "Aug 2026", amount: 541.25, status: "paid", paidAt: "2026-09-05T00:00:00Z" },
  { id: "po_2", tenantId: "t_chartroom", period: "Aug 2026", amount: 352.5, status: "paid", paidAt: "2026-09-05T00:00:00Z" },
  { id: "po_3", tenantId: "t_optionsdaily", period: "Aug 2026", amount: 244.0, status: "paid", paidAt: "2026-09-05T00:00:00Z" },
  { id: "po_4", tenantId: "t_tradetalk", period: "Sep 2026", amount: 563.5, status: "scheduled" },
  { id: "po_5", tenantId: "t_chartroom", period: "Sep 2026", amount: 379.75, status: "scheduled" },
  { id: "po_6", tenantId: "t_marketminds", period: "Sep 2026", amount: 110.25, status: "on_hold" },
  // Acme's commission on the traders it referred; matches components/tenant/program.ts.
  { id: "po_7", tenantId: "t_acme", period: "Sep 2026", amount: 681, status: "scheduled" },
];

export const TENANT_APPLICATIONS: TenantApplication[] = [
  { id: "app_1", name: "Bull & Bear Podcast", contact: "host@bullbearpod.com", audience: "38k monthly listeners", wantsWhiteLabel: false, submittedAt: "2026-09-29T15:00:00Z" },
  { id: "app_2", name: "Sierra Advisors", contact: "cto@sierraadv.com", audience: "RIA, 640 households", wantsWhiteLabel: true, submittedAt: "2026-09-28T19:30:00Z" },
  { id: "app_3", name: "Quantly", contact: "founders@quantly.app", audience: "Retail analytics app, 12k MAU", wantsWhiteLabel: false, submittedAt: "2026-09-27T10:15:00Z" },
];

/* ---------------- Health ---------------- */
export const SERVICES: ServiceHealth[] = [
  { id: "svc_gw", name: "Broker gateway pool (IBKR)", role: "Holds one IBKR session per trader login", instances: 66, status: "degraded", uptime30d: 99.71, p95Ms: 412, lastRestartAt: "2026-09-30T12:04:00Z" },
  { id: "svc_proxy", name: "Broker proxies", role: "Cookie rewrite, header strip, init throttle, keepalive", instances: 66, status: "healthy", uptime30d: 99.98, p95Ms: 38, lastRestartAt: "2026-09-22T03:00:00Z" },
  { id: "svc_app", name: "Terminal app", role: "Next.js web application", instances: 4, status: "healthy", uptime30d: 99.99, p95Ms: 121, lastRestartAt: "2026-09-29T02:10:00Z" },
  { id: "svc_ts", name: "TradeScope engine", role: "Scans 44 symbols on 15m bars", instances: 2, status: "healthy", uptime30d: 99.95, p95Ms: 860, lastRestartAt: "2026-09-25T02:00:00Z" },
  { id: "svc_mailer", name: "Mailer", role: "Alert emails, OTP codes", instances: 2, status: "healthy", uptime30d: 100, p95Ms: 210, lastRestartAt: "2026-09-15T02:00:00Z" },
  { id: "svc_admin", name: "Admin API", role: "User admin, OTP verification", instances: 2, status: "healthy", uptime30d: 100, p95Ms: 64, lastRestartAt: "2026-09-15T02:00:00Z" },
  { id: "svc_db", name: "Postgres (Supabase)", role: "Auth, workspaces, tenants, trade archive, flags", instances: 1, status: "healthy", uptime30d: 99.99, p95Ms: 9, lastRestartAt: "2026-08-30T01:00:00Z" },
  { id: "svc_agg", name: "Aggregator bridge", role: "Read-only sync for Fidelity and Robinhood", instances: 2, status: "degraded", uptime30d: 99.2, p95Ms: 1_480, lastRestartAt: "2026-09-29T09:20:00Z" },
];

export const INCIDENTS: Incident[] = [
  { id: "inc_41", title: "IBKR pool A: 2 sessions dropped after upstream SSO expiry", severity: "minor", status: "monitoring", startedAt: "2026-09-30T12:01:00Z", summary: "Two traders were prompted to re-login. Keepalive re-established the bridge for the rest of the pool." },
  { id: "inc_40", title: "Aggregator bridge latency above 1.2 s", severity: "minor", status: "open", startedAt: "2026-09-29T09:05:00Z", summary: "Fidelity and Robinhood position syncs are delayed by up to 4 minutes. Trading brokers are unaffected." },
  { id: "inc_39", title: "Schwab token refresh failures", severity: "major", status: "resolved", startedAt: "2026-09-12T15:40:00Z", resolvedAt: "2026-09-12T16:25:00Z", summary: "Schwab OAuth endpoint returned 503 for 45 minutes. Refresh retried with backoff; no orders were lost." },
  { id: "inc_38", title: "Planned maintenance: proxy fleet rollout", severity: "minor", status: "resolved", startedAt: "2026-09-22T03:00:00Z", resolvedAt: "2026-09-22T03:20:00Z", summary: "Rolling restart of broker proxies outside market hours." },
];

/* ---------------- Audit ---------------- */
export const AUDIT: AuditEvent[] = [
  { id: "a_1", at: "2026-09-30T18:41:00Z", actor: "vivek@nasscord.com", action: "workspace.feature.update", target: "Riverbend Traders · options=true", ip: "73.•••.•••.18", result: "ok" },
  { id: "a_2", at: "2026-09-30T18:12:00Z", actor: "vivek@nasscord.com", action: "user.invite", target: "ava@riverbendtraders.com", ip: "73.•••.•••.18", result: "ok" },
  { id: "a_3", at: "2026-09-30T17:55:00Z", actor: "dana@acmecap.com", action: "branding.update", target: "Acme Capital · accent", ip: "162.•••.•••.201", result: "ok" },
  { id: "a_4", at: "2026-09-30T16:30:00Z", actor: "vivek@nasscord.com", action: "maintenance.toggle", target: "off", ip: "73.•••.•••.18", result: "ok" },
  { id: "a_5", at: "2026-09-30T14:02:00Z", actor: "system", action: "billing.invoice.issue", target: "INV-2026-0925 · J. Martin", ip: "internal", result: "ok" },
  { id: "a_6", at: "2026-09-30T13:48:00Z", actor: "cboone@summitdt.com", action: "auth.login", target: "Summit Day Traders", ip: "98.•••.•••.77", result: "denied" },
  { id: "a_7", at: "2026-09-30T12:04:00Z", actor: "system", action: "gateway.restart", target: "ibkr-pool-a · 2 sessions", ip: "internal", result: "ok" },
  { id: "a_8", at: "2026-09-29T21:15:00Z", actor: "vivek@nasscord.com", action: "workspace.suspend", target: "Summit Day Traders", ip: "73.•••.•••.18", result: "ok" },
  { id: "a_9", at: "2026-09-29T20:40:00Z", actor: "vivek@nasscord.com", action: "tenant.payout.hold", target: "Market Minds · Sep 2026", ip: "73.•••.•••.18", result: "ok" },
  { id: "a_10", at: "2026-09-29T18:10:00Z", actor: "elena@northstarwealth.com", action: "user.role.update", target: "2 users · tenant user", ip: "12.•••.•••.9", result: "ok" },
  { id: "a_11", at: "2026-09-29T15:02:00Z", actor: "system", action: "engine.params.update", target: "minScore 70 · maxOpen 5", ip: "internal", result: "ok" },
  { id: "a_12", at: "2026-09-28T13:10:00Z", actor: "system", action: "broker.session.expired", target: "ibkr · 13 accounts", ip: "internal", result: "error" },
  { id: "a_13", at: "2026-09-15T09:20:00Z", actor: "vivek@nasscord.com", action: "tenant.whitelabel.grant", target: "Quill Asset Partners · app.quillassets.com", ip: "73.•••.•••.18", result: "ok" },
];

export const RECENT_SIGNUPS = WORKSPACES.filter((t) => new Date(t.createdAt) > new Date("2026-08-01")).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
