import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ACCOUNT_COLUMNS,
  CONNECTION_COLUMNS,
  toBrokerConnection,
  type BrokerAccountRow,
  type BrokerConnectionRow,
} from "@/lib/server/rows";
import { withBalance, type ServicePortfolio } from "@/lib/server/broker-service";
import type { BrokerConnection } from "@/lib/types";

/* Broker connections of one workspace as stored in the database. Server only. */

if (typeof window !== "undefined") throw new Error("src/lib/server is server only.");

/**
 * Connections of the workspace (disconnected ones left out) with their accounts, oldest first.
 * Pass the user's own client (RLS) from routes; the console passes the service-role client.
 */
export async function workspaceConnections(client: SupabaseClient, workspaceId: string): Promise<BrokerConnection[]> {
  const [conns, accounts] = await Promise.all([
    client.from("broker_connections").select(CONNECTION_COLUMNS).eq("workspace_id", workspaceId).neq("status", "disconnected").order("created_at"),
    client.from("broker_accounts").select(ACCOUNT_COLUMNS).eq("workspace_id", workspaceId).order("created_at"),
  ]);
  if (conns.error) throw new Error(`broker_connections: ${conns.error.code ?? "read failed"}`);
  if (accounts.error) throw new Error(`broker_accounts: ${accounts.error.code ?? "read failed"}`);
  const accountRows = (accounts.data ?? []) as BrokerAccountRow[];
  return ((conns.data ?? []) as BrokerConnectionRow[]).map((row) => toBrokerConnection(row, accountRows));
}

/** True when the workspace has at least one active connection (worth asking the service for data). */
export async function hasActiveConnection(workspaceId: string): Promise<boolean> {
  const { data, error } = await createAdminClient().from("broker_connections").select("id").eq("workspace_id", workspaceId).eq("status", "active").limit(1);
  if (error) throw new Error(`broker_connections: ${error.code ?? "read failed"}`);
  return (data ?? []).length > 0;
}

/** Whether a connection id belongs to the workspace. */
export async function connectionInWorkspace(connectionId: string, workspaceId: string): Promise<boolean> {
  const { data } = await createAdminClient().from("broker_connections").select("id").eq("id", connectionId).eq("workspace_id", workspaceId).maybeSingle();
  return Boolean(data);
}

/** Merges balances and per-connection errors from /v1/portfolio into DB connections. */
export function mergePortfolio(connections: BrokerConnection[], portfolio: ServicePortfolio): BrokerConnection[] {
  const balances = new Map(portfolio.accounts.map((b) => [b.accountId, b]));
  const errors = new Map(portfolio.errors.map((e) => [e.connectionId, e.message]));
  return connections.map((c) => ({
    ...c,
    ...(errors.has(c.id) && !c.statusDetail ? { statusDetail: errors.get(c.id) } : {}),
    accounts: c.accounts.map((a) => {
      const b = balances.get(a.id);
      return b ? { ...a, ...withBalance(b) } : a;
    }),
  }));
}
