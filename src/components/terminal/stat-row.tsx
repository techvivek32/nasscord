"use client";

import { fmtAmount } from "@/components/brokers/money";
import { StatCard } from "@/components/stat-card";
import { clsxNum } from "@/lib/format";
import { useAccountScope, type ReportedTotal } from "@/components/terminal/hooks";
import { StatRowSkeleton } from "@/components/terminal/skeletons";

function reportedNote(t: ReportedTotal, of: number) {
  if (t.value === null) return "not reported";
  return t.reported < of ? `${t.reported} of ${of} accounts reported` : of === 1 ? "1 account" : `${of} accounts`;
}

/**
 * Totals of the accounts in scope, as the brokers reported them. Each tile adds up only the accounts
 * that reported that value; a value nobody reported says so instead of showing zero.
 */
export function TerminalStatRow() {
  const scope = useAccountScope();
  if (scope.isLoading) return <StatRowSkeleton />;
  if (scope.scoped.length === 0) return null;

  const { totals, scoped } = scope;
  const n = scoped.length;
  const missing = totals.mixedCurrency ? "Mixed currencies" : "Not reported";
  const money = (v: number, sign = false) => fmtAmount(v, totals.currency, { digits: 0, sign });

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Net liquidation" value={totals.netLiq.value !== null ? money(totals.netLiq.value) : missing} delta={reportedNote(totals.netLiq, n)} />
      <StatCard
        label="Day P&L"
        value={totals.dayPnl.value !== null ? <span className={clsxNum(totals.dayPnl.value)}>{money(totals.dayPnl.value, true)}</span> : missing}
        delta={totals.dayPnlPct ?? reportedNote(totals.dayPnl, n)}
        deltaLabel={totals.dayPnlPct !== null ? "% today" : undefined}
      />
      <StatCard label="Buying power" value={totals.buyingPower.value !== null ? money(totals.buyingPower.value) : missing} delta={reportedNote(totals.buyingPower, n)} />
      <StatCard label="Cash" value={totals.cash.value !== null ? money(totals.cash.value) : missing} delta={reportedNote(totals.cash, n)} />
    </div>
  );
}
