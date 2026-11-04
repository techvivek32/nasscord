"use client";

import Link from "next/link";
import { ChevronDownIcon, LayersIcon, PlugZapIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { fmtAmount } from "@/components/brokers/money";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { getBroker } from "@/lib/brokers";
import { cn } from "@/lib/utils";
import { useAccountScope, type ReportedTotal } from "@/components/terminal/hooks";
import { useHydrateTerminalStore, useTerminalStore } from "@/components/terminal/store";

function money(t: ReportedTotal, currency: string) {
  return t.value === null ? null : fmtAmount(t.value, currency, { digits: 0 });
}

/**
 * Header control: "All accounts" or one included account. Every page filters by it. The totals are
 * sums of what the brokers reported; a value no account reported is left out, never shown as zero.
 */
export function AccountSwitcher({ className }: { className?: string }) {
  const scope = useAccountScope();
  const selectedAccountId = useTerminalStore((s) => s.selectedAccountId);
  const setSelectedAccount = useTerminalStore((s) => s.setSelectedAccount);
  const hydrated = useTerminalStore((s) => s.hydrated);
  useHydrateTerminalStore();
  const { included, selected, totals } = scope;

  if (scope.isLoading || !hydrated) return <Skeleton className={cn("h-8 w-40", className)} />;

  if (included.length === 0) {
    return (
      <Button variant="outline" className={cn("h-8 gap-2", className)} render={<Link href="/app/brokers" />} data-tour="account-scope">
        <PlugZapIcon />
        {scope.connections.length === 0 ? "Connect a broker" : "No accounts included"}
      </Button>
    );
  }

  const netLiq = money(totals.netLiq, totals.currency);
  const label = selected ? `${getBroker(selected.brokerId).short} ${selected.label}` : "All accounts";
  const sub = selected ? (netLiq ? `${selected.masked} · ${netLiq}` : selected.masked) : (netLiq ?? `${included.length} included`);
  const dayPnl = totals.dayPnl.value;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className={cn("h-8 max-w-60 gap-2 pl-1.5", className)} aria-label={`Account scope: ${label}`} data-tour="account-scope" />}>
        {selected ? (
          <BrokerMark id={selected.brokerId} size="sm" />
        ) : (
          <span className="grid size-6 place-items-center rounded-md bg-brand-soft text-primary">
            <LayersIcon className="size-3.5" />
          </span>
        )}
        <span className="flex min-w-0 flex-col items-start leading-none">
          <span className="truncate text-xs font-semibold">{label}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground tabular">{sub}</span>
        </span>
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuRadioGroup value={selected ? selectedAccountId : "all"} onValueChange={(v) => setSelectedAccount(String(v))}>
          {/* Inside the radio group: the label is a Base UI Menu.GroupLabel and throws outside a group. */}
          <DropdownMenuLabel>View as</DropdownMenuLabel>
          <DropdownMenuRadioItem value="all" className="items-start py-1.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-soft text-primary">
              <LayersIcon className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">All accounts</span>
              <span className="text-xs text-muted-foreground">{included.length} included</span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {included.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id} className="items-start py-1.5">
              <BrokerMark id={a.brokerId} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {getBroker(a.brokerId).short} {a.label}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono tabular">{a.masked}</span>
                  {a.netLiq !== undefined ? <span className="tabular">{fmtAmount(a.netLiq, a.currency, { digits: 0 })}</span> : null}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <div className="grid gap-0.5 px-1.5 py-1 text-xs text-muted-foreground">
          {totals.mixedCurrency ? (
            <span>These accounts report in more than one currency, so no total is added up.</span>
          ) : netLiq ? (
            <span>
              In view: <span className="font-mono text-foreground tabular">{netLiq}</span> net liquidation
              {dayPnl !== null ? (
                <>
                  , day <span className={cn("font-mono tabular", dayPnl > 0 ? "text-gain-foreground" : dayPnl < 0 ? "text-loss-foreground" : "")}>{fmtAmount(dayPnl, totals.currency, { sign: true, digits: 0 })}</span>
                </>
              ) : null}
              {totals.netLiq.reported < scope.scoped.length ? ` (${totals.netLiq.reported} of ${scope.scoped.length} accounts reported)` : ""}
            </span>
          ) : (
            <span>No balances reported right now.</span>
          )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/app/brokers" />}>Manage accounts under Brokers</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
