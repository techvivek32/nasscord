/* ------------------------------------------------------------------
   Data access layer. Today every function returns demo data after a
   short delay; swap the bodies for real calls (Supabase, the broker
   proxy, the TradeScope engine) without touching the pages.
   Pages never import from lib/mock directly for anything that will one
   day come from a server: they go through here (or the hooks in
   src/hooks/queries.ts).
   ------------------------------------------------------------------ */

import { ALERTS, CLOSED_ALERTS, CONNECTIONS, DAILY_PNL, EQUITY_CURVE, EXECUTIONS, OPEN_ALERTS, ORDERS, POSITIONS, TICKERS } from "@/lib/mock/trading";
import { AUDIT, BROKER_HEALTH, GATEWAY_POOLS, INCIDENTS, INVOICES, MRR_HISTORY, PAYOUTS, PLATFORM_KPIS, REVENUE_BY_PLAN, SERVICES, SIGNUPS_BY_PLAN, TENANT_APPLICATIONS, USERS } from "@/lib/mock/platform";
import { TENANTS } from "@/lib/mock/tenants";
import { WORKSPACES } from "@/lib/mock/workspaces";
import { BACKTEST, ENGINE_DEFAULTS, LIFETIME_RECORD } from "@/lib/engine";
import type { Alert, BrokerConnection, Execution, Order, Position, Tenant, Ticker, Workspace } from "@/lib/types";

const latency = (ms = 120) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------- trading (tenant scoped) ---------- */
export async function fetchConnections(): Promise<BrokerConnection[]> {
  await latency();
  return structuredClone(CONNECTIONS);
}
export async function fetchAlerts(): Promise<{ open: Alert[]; closed: Alert[]; all: Alert[]; scannedAt: string; minScore: number; scanned: number }> {
  await latency();
  return { open: structuredClone(OPEN_ALERTS), closed: structuredClone(CLOSED_ALERTS), all: structuredClone(ALERTS), scannedAt: "2026-09-30T18:45:00Z", minScore: ENGINE_DEFAULTS.minScore, scanned: ENGINE_DEFAULTS.universeSize };
}
export async function fetchPositions(): Promise<Position[]> {
  await latency();
  return structuredClone(POSITIONS);
}
export async function fetchOrders(): Promise<Order[]> {
  await latency();
  return structuredClone(ORDERS);
}
export async function fetchExecutions(): Promise<Execution[]> {
  await latency();
  return structuredClone(EXECUTIONS);
}
export async function fetchTickers(): Promise<Ticker[]> {
  await latency(60);
  return structuredClone(TICKERS);
}
export async function fetchEquityCurve() {
  await latency();
  return { equity: structuredClone(EQUITY_CURVE), daily: structuredClone(DAILY_PNL) };
}
export async function fetchBacktest() {
  await latency();
  return { stats: BACKTEST, lifetime: LIFETIME_RECORD, params: ENGINE_DEFAULTS };
}

/* ---------- platform (super admin scoped) ---------- */
/** Trading workspaces: organic traders and the ones that came through a tenant. */
export async function fetchWorkspaces(): Promise<Workspace[]> {
  await latency();
  return structuredClone(WORKSPACES);
}
export async function fetchWorkspace(idOrSlug: string): Promise<Workspace | null> {
  await latency(80);
  return structuredClone(WORKSPACES.find((w) => w.id === idOrSlug || w.slug === idOrSlug) ?? null);
}
/** Tenants (distributors), their payouts and the open applications to become one. */
export async function fetchTenants() {
  await latency();
  return { tenants: structuredClone(TENANTS), payouts: structuredClone(PAYOUTS), applications: structuredClone(TENANT_APPLICATIONS) };
}
export async function fetchTenant(id: string): Promise<Tenant | null> {
  await latency(80);
  return structuredClone(TENANTS.find((t) => t.id === id) ?? null);
}
export async function fetchPlatformOverview() {
  await latency();
  return {
    kpis: PLATFORM_KPIS,
    mrrHistory: MRR_HISTORY,
    signupsByPlan: SIGNUPS_BY_PLAN,
    revenueByPlan: REVENUE_BY_PLAN,
    brokerHealth: BROKER_HEALTH,
    gatewayPools: GATEWAY_POOLS,
    incidents: INCIDENTS,
    services: SERVICES,
  };
}
export async function fetchUsers() {
  await latency();
  return structuredClone(USERS);
}
export async function fetchInvoices() {
  await latency();
  return structuredClone(INVOICES);
}
export async function fetchAudit() {
  await latency();
  return structuredClone(AUDIT);
}
