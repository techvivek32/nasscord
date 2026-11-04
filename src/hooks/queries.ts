"use client";

import * as React from "react";
import {
  useMutation,
  useQuery as useBaseQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import * as api from "@/lib/api";
import { useHydrated } from "@/hooks/use-hydrated";
import { useWorkspaceId } from "@/components/workspace-scope";
import type { BrokerConnection } from "@/lib/types";

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

/**
 * Query keys. Broker data is keyed by workspace id (from WorkspaceScopeProvider), so one browser
 * never mixes two workspaces' data. Everything under ["broker", workspaceId] is invalidated together.
 */
export const qk = {
  broker: (wid: string) => ["broker", wid] as const,
  connections: (wid: string) => ["broker", wid, "connections"] as const,
  connection: (wid: string, id: string) => ["broker", wid, "connection", id] as const,
  positions: (wid: string) => ["broker", wid, "positions"] as const,
  orders: (wid: string) => ["broker", wid, "orders"] as const,
  executions: (wid: string) => ["broker", wid, "executions"] as const,
};

/** Drops every cached query (call on sign-out, before the session cookie goes). */
export function clearQueryCache(client: QueryClient) {
  void client.cancelQueries();
  client.clear();
}

/** clearQueryCache bound to the app's QueryClient. */
export function useClearQueryCache() {
  const client = useQueryClient();
  return React.useCallback(() => clearQueryCache(client), [client]);
}

/* ---------------------------------------------------------------- broker data (real) */

const NONE = "none";

/** Cadence: the broker service caches each connection for 5 s, so polling faster buys nothing. */
export function useConnections() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: qk.connections(wid ?? NONE), queryFn: api.fetchConnections, enabled: !!wid, refetchInterval: 15_000 });
}

/** Connections plus `portfolioError` when balances could not be read. Shares nothing with useConnections' cache entry. */
export function useConnectionsResult() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: [...qk.connections(wid ?? NONE), "result"] as const, queryFn: api.fetchConnectionsResult, enabled: !!wid, refetchInterval: 15_000 });
}

/** One connection with fresh status. Pass `pollMs` while a login is in progress (IBKR) to watch it turn connected. */
export function useConnection(id: string | null | undefined, opts: { pollMs?: number } = {}) {
  const wid = useWorkspaceId();
  return useQuery({
    queryKey: qk.connection(wid ?? NONE, id ?? NONE),
    queryFn: () => api.fetchConnection(id as string),
    enabled: !!wid && !!id,
    refetchInterval: opts.pollMs ?? false,
  });
}

/* ---------------------------------------------------------------- broker changes */

/** Invalidates every broker query of the current workspace after a change. */
function useBrokerInvalidate() {
  const client = useQueryClient();
  const wid = useWorkspaceId();
  return React.useCallback(() => client.invalidateQueries({ queryKey: qk.broker(wid ?? NONE) }), [client, wid]);
}

type ConnectionsResult = Awaited<ReturnType<typeof api.fetchConnectionsResult>>;

/**
 * Include or exclude an account. Updates both cached connection lists at once (useConnections and
 * useConnectionsResult, which feeds every terminal page through useAccountScope) and rolls both
 * back on failure.
 */
export function useSetAccountIncluded() {
  const client = useQueryClient();
  const wid = useWorkspaceId() ?? NONE;
  const invalidate = useBrokerInvalidate();
  const listKey = qk.connections(wid);
  const resultKey = [...qk.connections(wid), "result"] as const;
  return useMutation({
    mutationFn: (vars: { accountId: string; included: boolean }) => api.setAccountIncluded(vars.accountId, vars.included),
    onMutate: async (vars) => {
      // Cancelling the list key also cancels the result key under it.
      await client.cancelQueries({ queryKey: listKey });
      const flip = (list: BrokerConnection[]) =>
        list.map((c) => ({ ...c, accounts: c.accounts.map((a) => (a.id === vars.accountId ? { ...a, included: vars.included } : a)) }));
      const previous = client.getQueryData<BrokerConnection[]>(listKey);
      const previousResult = client.getQueryData<ConnectionsResult>(resultKey);
      if (previous) client.setQueryData<BrokerConnection[]>(listKey, flip(previous));
      if (previousResult) client.setQueryData<ConnectionsResult>(resultKey, { ...previousResult, connections: flip(previousResult.connections) });
      return { previous, previousResult };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) client.setQueryData(listKey, context.previous);
      if (context?.previousResult) client.setQueryData(resultKey, context.previousResult);
    },
    onSettled: () => invalidate(),
  });
}

export function useStartEtrade() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: api.startEtrade, onSettled: () => invalidate() });
}

export function useVerifyEtrade() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: api.verifyEtrade, onSettled: () => invalidate() });
}

export function useStartIbkr() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: api.startIbkr, onSettled: () => invalidate() });
}

export function useRenewConnection() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (id: string) => api.renewConnection(id), onSettled: () => invalidate() });
}

export function useDisconnectConnection() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (id: string) => api.disconnectConnection(id), onSettled: () => invalidate() });
}
