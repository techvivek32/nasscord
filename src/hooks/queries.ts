"use client";

import { useQuery as useBaseQuery, type QueryKey, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { useHydrated } from "@/hooks/use-hydrated";

/**
 * useQuery that never hands cached data to a component that is still hydrating.
 *
 * The server renders every query as pending. Page content sits inside a Suspense boundary
 * (loading.tsx) that hydrates after the shell, and the shell's header already runs some of the
 * same queries, so by the time the page hydrates the cache can be warm. Rendering that data
 * during hydration would not match the server HTML. Reporting "pending" for the hydration pass
 * keeps the markup identical; the real result follows in the next render.
 */
function useQuery<TData, TKey extends QueryKey>(options: UseQueryOptions<TData, Error, TData, TKey>): UseQueryResult<TData, Error> {
  const result = useBaseQuery(options);
  const hydrated = useHydrated();
  if (hydrated || result.data === undefined) return result;
  return {
    ...result,
    data: undefined,
    status: "pending",
    isPending: true,
    isLoading: true,
    isSuccess: false,
    isFetched: false,
    isPlaceholderData: false,
  } as UseQueryResult<TData, Error>;
}

/* Query keys mirror the production terminal's cadence: quotes fast, alerts 20 s, stats slow. */
export const qk = {
  connections: ["connections"] as const,
  alerts: ["alerts"] as const,
  positions: ["positions"] as const,
  orders: ["orders"] as const,
  executions: ["executions"] as const,
  tickers: ["tickers"] as const,
  equity: ["equity"] as const,
  backtest: ["backtest"] as const,
  workspaces: ["workspaces"] as const,
  workspace: (id: string) => ["workspace", id] as const,
  tenants: ["tenants"] as const,
  overview: ["platform-overview"] as const,
  users: ["users"] as const,
  invoices: ["invoices"] as const,
  audit: ["audit"] as const,
};

export const useConnections = () => useQuery({ queryKey: qk.connections, queryFn: api.fetchConnections, refetchInterval: 15_000 });
export const useAlerts = () => useQuery({ queryKey: qk.alerts, queryFn: api.fetchAlerts, refetchInterval: 20_000 });
export const usePositions = () => useQuery({ queryKey: qk.positions, queryFn: api.fetchPositions, refetchInterval: 15_000 });
export const useOrders = () => useQuery({ queryKey: qk.orders, queryFn: api.fetchOrders, refetchInterval: 10_000 });
export const useExecutions = () => useQuery({ queryKey: qk.executions, queryFn: api.fetchExecutions, refetchInterval: 10_000 });
export const useTickers = () => useQuery({ queryKey: qk.tickers, queryFn: api.fetchTickers, refetchInterval: 3_000 });
export const useEquityCurve = () => useQuery({ queryKey: qk.equity, queryFn: api.fetchEquityCurve, staleTime: 60_000 });
export const useBacktest = () => useQuery({ queryKey: qk.backtest, queryFn: api.fetchBacktest, staleTime: 300_000 });

/** Trading workspaces (the console's "Traders"). */
export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: api.fetchWorkspaces });
export const useWorkspace = (id: string) => useQuery({ queryKey: qk.workspace(id), queryFn: () => api.fetchWorkspace(id), enabled: !!id });
/** Tenants (distributors) with their payouts and applications. */
export const useTenants = () => useQuery({ queryKey: qk.tenants, queryFn: api.fetchTenants });
export const usePlatformOverview = () => useQuery({ queryKey: qk.overview, queryFn: api.fetchPlatformOverview, refetchInterval: 30_000 });
export const useUsers = () => useQuery({ queryKey: qk.users, queryFn: api.fetchUsers });
export const useInvoices = () => useQuery({ queryKey: qk.invoices, queryFn: api.fetchInvoices });
export const useAudit = () => useQuery({ queryKey: qk.audit, queryFn: api.fetchAudit });
