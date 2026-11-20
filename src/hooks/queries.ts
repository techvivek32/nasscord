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
import { ACTIVE_REQUEST } from "@/lib/order-entry";
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
  /** Not under ["broker", wid]: a connection change does not change who may connect what. */
  options: (wid: string) => ["broker-options", wid] as const,
  /** Order entry: under ["broker", wid], so a connection change or an order refreshes them at once. */
  orderCapabilities: (wid: string) => ["broker", wid, "order-caps"] as const,
  orderRequests: (wid: string) => ["broker", wid, "order-requests"] as const,
  orderRequest: (wid: string, id: string) => ["broker", wid, "order-request", id] as const,
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

/**
 * Every way of connecting a broker and whether the signed-in user may use it now (the broker
 * service's BROKER_AUDIENCE and setup). Join with connectChoices() from src/lib/broker-connect. The
 * app route keeps it 60 s, so this does not refetch sooner.
 */
export function useBrokerOptions() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: qk.options(wid ?? NONE), queryFn: api.fetchOptions, enabled: !!wid, staleTime: 60_000 });
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

/** Reconnect. Act on `next` (RenewResult in src/lib/api): IBKR login, E*TRADE code, a new key, or the broker's login in a new tab. */
export function useRenewConnection() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (id: string) => api.renewConnection(id), onSettled: () => invalidate() });
}

/** An API key or personal token (Alpaca, the owner's Tradier token); `connectionId` re-keys that connection. */
export function useConnectKey() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (input: api.ConnectKeyInput) => api.connectKey(input), onSettled: () => invalidate() });
}

/**
 * Starts an OAuth login: open `openUrl` in a new tab, then poll useConnection(connectionId, { pollMs: 3000 }).
 * A 404 from that poll is not success: the login was merged into another connection or it failed
 * (see startOAuth in src/lib/api).
 */
export function useStartOAuth() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (input: api.StartOAuthInput) => api.startOAuth(input), onSettled: () => invalidate() });
}

/** Starts a SnapTrade login: open `openUrl` in a new tab, then poll useConnection(connectionId, { pollMs: 3000 }). A 404 is read as for useStartOAuth. */
export function useStartAggregator() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (input: Parameters<typeof api.startAggregator>[0]) => api.startAggregator(input), onSettled: () => invalidate() });
}

export function useDisconnectConnection() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (id: string) => api.disconnectConnection(id), onSettled: () => invalidate() });
}

/* ---------------------------------------------------------------- order entry (docs/real-backend.md section 13) */

/**
 * Whether order entry is on for the workspace and what each connection may send for this user. Polled every
 * 60 s so a switch flipped in the console reaches an open terminal within a minute. On an error (the route
 * answers 503) react-query keeps the last good answer.
 */
export function useOrderCapabilities() {
  const wid = useWorkspaceId();
  return useQuery({
    queryKey: qk.orderCapabilities(wid ?? NONE),
    queryFn: api.fetchOrderCapabilities,
    enabled: !!wid,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
}

/** Rows whose outcome is open (sending, unknown) in the last 24 h and not marked as checked. Shown even when order entry is off. */
export function useOrderRequests() {
  const wid = useWorkspaceId();
  return useQuery({ queryKey: qk.orderRequests(wid ?? NONE), queryFn: api.fetchOrderRequests, enabled: !!wid, refetchInterval: 30_000 });
}

/** While "checking" after a place, a row the service has not claimed yet (the place may still wait for the connection) is read again too. */
const NOT_CLAIMED_YET = new Set(["preview", "needs_confirmation"]);

/**
 * One request; polls every 2 s while `poll` is true and the status is still open (ACTIVE_REQUEST), or not
 * claimed yet (preview, needs_confirmation), or not read yet. The caller turns `poll` off (the dialog after 60 s).
 */
export function useOrderRequest(id: string | null, opts: { poll?: boolean } = {}) {
  const wid = useWorkspaceId();
  const poll = opts.poll ?? false;
  return useQuery({
    queryKey: qk.orderRequest(wid ?? NONE, id ?? NONE),
    queryFn: () => api.fetchOrderRequest(id as string),
    enabled: !!wid && !!id,
    retry: 0,
    refetchInterval: (query) => {
      if (!poll) return false;
      const status = query.state.data?.request.status;
      return status === undefined || ACTIVE_REQUEST.has(status) || NOT_CLAIMED_YET.has(status) ? 2_000 : false;
    },
  });
}

/** Asks the broker for a preview. Never retried. */
export function usePreviewOrder() {
  return useMutation({ mutationFn: (ticket: Parameters<typeof api.previewOrder>[0]) => api.previewOrder(ticket), retry: 0 });
}

/** Places a previewed request. Never retried: anything but a JSON 4xx answers { checking: true } (src/lib/api placeOrder). */
export function usePlaceOrder() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (input: Parameters<typeof api.placeOrder>[0]) => api.placeOrder(input), retry: 0, onSettled: () => invalidate() });
}

/** Cancels an open order. Never retried. */
export function useCancelOrder() {
  const invalidate = useBrokerInvalidate();
  return useMutation({ mutationFn: (input: Parameters<typeof api.cancelOrder>[0]) => api.cancelOrder(input), retry: 0, onSettled: () => invalidate() });
}

/** Invalidates the unconfirmed list and one request after "Check again" or "I checked it". */
function useOrderRequestInvalidate() {
  const client = useQueryClient();
  const wid = useWorkspaceId() ?? NONE;
  return React.useCallback(
    (id: string) => {
      void client.invalidateQueries({ queryKey: qk.orderRequests(wid) });
      void client.invalidateQueries({ queryKey: qk.orderRequest(wid, id) });
    },
    [client, wid],
  );
}

/** "Check again": asks the broker for an unconfirmed order now. */
export function useCheckOrderRequest() {
  const invalidate = useOrderRequestInvalidate();
  return useMutation({ mutationFn: (id: string) => api.checkOrderRequest(id), retry: 0, onSettled: (_data, _err, id) => invalidate(id) });
}

/** "I checked it": stops the warnings about an unconfirmed order. */
export function useResolveOrderRequest() {
  const invalidate = useOrderRequestInvalidate();
  return useMutation({ mutationFn: (id: string) => api.resolveOrderRequest(id), retry: 0, onSettled: (_data, _err, id) => invalidate(id) });
}
