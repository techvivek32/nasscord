"use client";

import { useQuery as useBaseQuery, type QueryKey, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { qk } from "@/hooks/queries";
import { useHydrated } from "@/hooks/use-hydrated";
import { useWorkspaceId } from "@/components/workspace-scope";

/*
 * Positions, orders and executions together with the per-connection errors the routes return
 * (`errors: [{ connectionId, message }]`), which the terminal shows. The keys sit under
 * ["broker", workspaceId], so every broker change invalidates them with the rest. Cadence: the
 * broker service caches each connection for 5 s, so polling faster buys nothing.
 */

const NONE = "none";

/** Same hydration rule as src/hooks/queries.ts: no cached data during the hydration pass. */
function useQuery<TData, TKey extends QueryKey>(options: UseQueryOptions<TData, Error, TData, TKey>): UseQueryResult<TData, Error> {
  const result = useBaseQuery(options);
  const hydrated = useHydrated();
  if (hydrated || result.data === undefined) return result;
  return { ...result, data: undefined, status: "pending", isPending: true, isLoading: true, isSuccess: false, isFetched: false, isPlaceholderData: false } as UseQueryResult<TData, Error>;
}

export function usePositionsResult() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: [...qk.positions(wid ?? NONE), "result"] as const, queryFn: api.fetchPositionsResult, enabled: !!wid, refetchInterval: 15_000 });
}

export function useOrdersResult() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: [...qk.orders(wid ?? NONE), "result"] as const, queryFn: api.fetchOrdersResult, enabled: !!wid, refetchInterval: 10_000 });
}

export function useExecutionsResult() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: [...qk.executions(wid ?? NONE), "result"] as const, queryFn: api.fetchExecutionsResult, enabled: !!wid, refetchInterval: 30_000 });
}
