"use client";

import * as React from "react";
import { useConnections, useOrders, usePositions } from "@/hooks/queries";
import type { BrokerAccount, BrokerConnection, Order, Position } from "@/lib/types";
import { useTerminalStore } from "@/components/terminal/store";

/** Included flag with the local override from /app/brokers applied. */
export function isIncluded(account: BrokerAccount, overrides: Record<string, boolean>) {
  return overrides[account.id] ?? account.included;
}

export interface AccountScopeInfo {
  connections: BrokerConnection[];
  /** Every account across every connection, overrides applied to `included`. */
  accounts: BrokerAccount[];
  /** Accounts that count toward totals and sizing (included, and matching the selected account when one is chosen). */
  scoped: BrokerAccount[];
  included: BrokerAccount[];
  selected: BrokerAccount | null;
  inScope: (accountId: string) => boolean;
  totals: { netLiq: number; buyingPower: number; cash: number; dayPnl: number; dayPnlPct: number };
  isLoading: boolean;
}

/** Connections + the account switcher, resolved into one object every page can filter by. */
export function useAccountScope(): AccountScopeInfo {
  const { data, isLoading } = useConnections();
  const selectedAccountId = useTerminalStore((s) => s.selectedAccountId);
  const overrides = useTerminalStore((s) => s.includedOverrides);
  const sessionConnections = useTerminalStore((s) => s.sessionConnections);

  return React.useMemo(() => {
    const connections = [...(data ?? []), ...sessionConnections];
    const accounts = connections.flatMap((c) => c.accounts.map((a) => ({ ...a, included: isIncluded(a, overrides) })));
    const included = accounts.filter((a) => a.included);
    const selected = selectedAccountId === "all" ? null : (accounts.find((a) => a.id === selectedAccountId) ?? null);
    const scoped = selected ? [selected] : included;
    const ids = new Set(scoped.map((a) => a.id));
    const netLiq = scoped.reduce((s, a) => s + a.netLiq, 0);
    const dayPnl = scoped.reduce((s, a) => s + a.dayPnl, 0);
    const base = netLiq - dayPnl;
    return {
      connections,
      accounts,
      scoped,
      included,
      selected,
      inScope: (accountId: string) => ids.has(accountId),
      totals: {
        netLiq,
        buyingPower: scoped.reduce((s, a) => s + a.buyingPower, 0),
        cash: scoped.reduce((s, a) => s + a.cash, 0),
        dayPnl,
        dayPnlPct: base > 0 ? Math.round((dayPnl / base) * 10000) / 100 : 0,
      },
      isLoading,
    };
  }, [data, sessionConnections, selectedAccountId, overrides, isLoading]);
}

/** Open positions in scope, minus the ones closed in this session. */
export function useScopedPositions(): { positions: Position[]; isLoading: boolean } {
  const { data, isLoading } = usePositions();
  const scope = useAccountScope();
  const closed = useTerminalStore((s) => s.closedPositionIds);
  const positions = React.useMemo(() => (data ?? []).filter((p) => scope.inScope(p.accountId) && !closed.includes(p.id)), [data, scope, closed]);
  return { positions, isLoading: isLoading || scope.isLoading };
}

/** Server orders merged with the ones placed in this session, cancellations applied, newest first. */
export function useMergedOrders(): { orders: Order[]; isLoading: boolean } {
  const { data, isLoading } = useOrders();
  const scope = useAccountScope();
  const localOrders = useTerminalStore((s) => s.localOrders);
  const cancelled = useTerminalStore((s) => s.cancelledOrderIds);
  const orders = React.useMemo(() => {
    const server = (data ?? []).map((o) => (cancelled.includes(o.id) ? { ...o, status: "cancelled" as const } : o));
    return [...localOrders, ...server].filter((o) => scope.inScope(o.accountId)).sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  }, [data, localOrders, cancelled, scope]);
  return { orders, isLoading: isLoading || scope.isLoading };
}

/** Effective paper mode (false until the store has hydrated). */
export function usePaperMode() {
  const paperMode = useTerminalStore((s) => s.paperMode);
  const hydrated = useTerminalStore((s) => s.hydrated);
  return { paperMode: paperMode ?? false, hydrated };
}

/* Minute-bucketed clock as an external store: no setState in effects, and the server snapshot is null so
   session labels never render a guessed time on the server. */
function subscribeMinute(onChange: () => void) {
  const t = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(t);
}
const minuteNow = () => Math.floor(Date.now() / 60_000);
const minuteServer = () => null;

/** Ticking clock for session labels and "x min ago" text; updates once a minute. Null on the server and the first client render. */
export function useMinuteClock(): Date | null {
  const bucket = React.useSyncExternalStore(subscribeMinute, minuteNow, minuteServer);
  return React.useMemo(() => (bucket === null ? null : new Date(bucket * 60_000)), [bucket]);
}
