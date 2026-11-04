"use client";

import * as React from "react";
import { useConnectionsResult } from "@/hooks/queries";
import type { PartialError } from "@/lib/api";
import type { BrokerAccount, BrokerConnection, ConnectionStatus, Execution, Order, Position } from "@/lib/types";
import { useExecutionsResult, useOrdersResult, usePositionsResult } from "@/components/terminal/broker-queries";
import { useTerminalStore } from "@/components/terminal/store";

/** Statuses whose session answers reads. */
export const LIVE_STATUSES: ReadonlySet<ConnectionStatus> = new Set(["connected", "expiring"]);

/** A total over the accounts that reported the value. `null` when none did. */
export interface ReportedTotal {
  value: number | null;
  /** Accounts in scope that reported this value. */
  reported: number;
}

export interface ScopeTotals {
  netLiq: ReportedTotal;
  buyingPower: ReportedTotal;
  cash: ReportedTotal;
  dayPnl: ReportedTotal;
  /** Day P&L against the start-of-day value, over accounts that reported both. */
  dayPnlPct: number | null;
  /** The accounts in scope report balances in more than one currency, so no total is added up. */
  mixedCurrency: boolean;
  /** The one currency the totals are in (ISO code), when they are added up. */
  currency: string;
}

export interface AccountScopeInfo {
  connections: BrokerConnection[];
  /** Connections whose session is live (connected or expiring). */
  live: BrokerConnection[];
  /** Every account across every connection. */
  accounts: BrokerAccount[];
  /** Accounts that count toward totals and feed positions, orders and executions. */
  included: BrokerAccount[];
  /** The account picked in the header, when it is still an included account. */
  selected: BrokerAccount | null;
  /** The selected account, or every included account. */
  scoped: BrokerAccount[];
  inScope: (accountId: string) => boolean;
  totals: ScopeTotals;
  /** Why balances are missing when the broker service could not answer. */
  portfolioError?: string;
  /** The connections route itself failed. */
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

function total(accounts: BrokerAccount[], pick: (a: BrokerAccount) => number | undefined, mixed: boolean): ReportedTotal {
  const values = accounts.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (mixed) return { value: null, reported: values.length };
  return { value: values.length ? Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100 : null, reported: values.length };
}

export function scopeTotals(accounts: BrokerAccount[]): ScopeTotals {
  const currencies = new Set(
    accounts.filter((a) => a.netLiq !== undefined || a.dayPnl !== undefined || a.buyingPower !== undefined || a.cash !== undefined).map((a) => (a.currency || "USD").toUpperCase()),
  );
  const mixed = currencies.size > 1;
  const both = accounts.filter((a) => typeof a.netLiq === "number" && typeof a.dayPnl === "number");
  const end = both.reduce((s, a) => s + (a.netLiq ?? 0), 0);
  const day = both.reduce((s, a) => s + (a.dayPnl ?? 0), 0);
  const start = end - day;
  return {
    netLiq: total(accounts, (a) => a.netLiq, mixed),
    buyingPower: total(accounts, (a) => a.buyingPower, mixed),
    cash: total(accounts, (a) => a.cash, mixed),
    dayPnl: total(accounts, (a) => a.dayPnl, mixed),
    dayPnlPct: !mixed && both.length > 0 && start > 0 ? Math.round((day / start) * 10000) / 100 : null,
    mixedCurrency: mixed,
    currency: currencies.size === 1 ? [...currencies][0] : "USD",
  };
}

/** Connections + the header's account choice, resolved into one object every page filters by. */
export function useAccountScope(): AccountScopeInfo {
  const { data, isLoading, error, refetch } = useConnectionsResult();
  const selectedAccountId = useTerminalStore((s) => s.selectedAccountId);

  return React.useMemo(() => {
    const connections = data?.connections ?? [];
    const live = connections.filter((c) => LIVE_STATUSES.has(c.status));
    const accounts = connections.flatMap((c) => c.accounts.map((a) => ({ ...a, connectionId: a.connectionId ?? c.id })));
    const included = accounts.filter((a) => a.included);
    const selected = selectedAccountId === "all" ? null : (included.find((a) => a.id === selectedAccountId) ?? null);
    const scoped = selected ? [selected] : included;
    const ids = new Set(scoped.map((a) => a.id));
    return {
      connections,
      live,
      accounts,
      included,
      selected,
      scoped,
      inScope: (accountId: string) => ids.has(accountId),
      totals: scopeTotals(scoped),
      ...(data?.portfolioError ? { portfolioError: data.portfolioError } : {}),
      error: error ?? null,
      isLoading,
      refetch: () => void refetch(),
    };
  }, [data, error, isLoading, refetch, selectedAccountId]);
}

/**
 * What a read covers for the accounts in scope:
 * - "full": every live connection in scope answered,
 * - "partial": some answered and some are listed in `errors`,
 * - "none": nothing was read (the route failed, or every live connection in scope failed).
 * An empty list only means "nothing there" when the read is "full"; with "partial" it means
 * "nothing in the accounts that answered", and with "none" it means nothing at all.
 */
export type ReadCoverage = "full" | "partial" | "none";

export interface ScopedResult<T> {
  rows: T[];
  /** Connections that could not be read on this call. */
  errors: PartialError[];
  /** The route itself failed on the latest refresh. */
  error: Error | null;
  /** The latest refresh failed and `rows` are from the last read that worked. */
  stale: boolean;
  coverage: ReadCoverage;
  isLoading: boolean;
}

function coverageOf(scope: AccountScopeInfo, hasData: boolean, rows: Array<{ accountId: string }>, errors: PartialError[], error: Error | null): ReadCoverage {
  if (!hasData) return error ? "none" : "full";
  const inScope = new Set(scope.scoped.map((a) => a.connectionId));
  const expected = scope.live.filter((c) => inScope.has(c.id));
  const failed = new Set(errors.map((e) => e.connectionId));
  if (failed.size === 0) return "full";
  const connectionOf = new Map(scope.accounts.map((a) => [a.id, a.connectionId]));
  // A connection that returned rows answered, even when one of its accounts is in `errors` (IBKR reports per account).
  const withRows = new Set(rows.map((r) => connectionOf.get(r.accountId)));
  const answered = expected.filter((c) => !failed.has(c.id) || withRows.has(c.id));
  if (expected.length > 0 && answered.length === 0) return "none";
  return expected.some((c) => failed.has(c.id)) ? "partial" : "full";
}

function scopedResult<T extends { accountId: string }>(rows: T[] | undefined, errors: PartialError[] | undefined, error: Error | null, isLoading: boolean, scope: AccountScopeInfo): ScopedResult<T> {
  const list = (rows ?? []).filter((r) => scope.inScope(r.accountId));
  const errs = errors ?? [];
  return {
    rows: list,
    errors: errs,
    error,
    stale: !!error && rows !== undefined,
    coverage: coverageOf(scope, rows !== undefined, list, errs, error),
    isLoading: isLoading || scope.isLoading,
  };
}

/** Open positions of the accounts in scope, with the per-connection errors of the read. */
export function useScopedPositions(): ScopedResult<Position> {
  const scope = useAccountScope();
  const { data, error, isLoading } = usePositionsResult();
  return React.useMemo(() => scopedResult(data?.positions, data?.errors, error, isLoading, scope), [data, error, isLoading, scope]);
}

/** Orders of the accounts in scope, newest first (the service sorts them). */
export function useScopedOrders(): ScopedResult<Order> {
  const scope = useAccountScope();
  const { data, error, isLoading } = useOrdersResult();
  return React.useMemo(() => scopedResult(data?.orders, data?.errors, error, isLoading, scope), [data, error, isLoading, scope]);
}

/** Executions of the accounts in scope, newest first. */
export function useScopedExecutions(): ScopedResult<Execution> {
  const scope = useAccountScope();
  const { data, error, isLoading } = useExecutionsResult();
  return React.useMemo(() => scopedResult(data?.executions, data?.errors, error, isLoading, scope), [data, error, isLoading, scope]);
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
