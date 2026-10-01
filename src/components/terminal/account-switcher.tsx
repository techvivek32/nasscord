"use client";

import * as React from "react";
import { ChevronDownIcon, LayersIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { getBroker } from "@/lib/brokers";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAccountScope } from "@/components/terminal/hooks";
import { useTerminalStore } from "@/components/terminal/store";

/** Header control: "All accounts" or one account. Everything on the pages filters by it. */
export function AccountSwitcher({ className }: { className?: string }) {
  const { accounts, included, selected, totals, isLoading } = useAccountScope();
  const selectedAccountId = useTerminalStore((s) => s.selectedAccountId);
  const setSelectedAccount = useTerminalStore((s) => s.setSelectedAccount);
  const hydrated = useTerminalStore((s) => s.hydrated);

  if (isLoading || !hydrated) return <Skeleton className={cn("h-8 w-40", className)} />;

  const label = selected ? `${getBroker(selected.brokerId).short} ${selected.label}` : "All accounts";
  const sub = selected ? selected.masked : `${included.length} included`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" className={cn("h-8 max-w-56 gap-2 pl-1.5", className)} aria-label={`Account scope: ${label}`} data-tour="account-scope" />}>
        {selected ? <BrokerMark id={selected.brokerId} size="sm" /> : <span className="grid size-6 place-items-center rounded-md bg-brand-soft text-primary"><LayersIcon className="size-3.5" /></span>}
        <span className="flex min-w-0 flex-col items-start leading-none">
          <span className="truncate text-xs font-semibold">{label}</span>
          <span className="truncate font-mono text-[10px] text-muted-foreground tabular">{sub}</span>
        </span>
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuRadioGroup value={selectedAccountId} onValueChange={(v) => setSelectedAccount(String(v))}>
          {/* Inside the radio group: the label is a Base UI Menu.GroupLabel and throws outside a group. */}
          <DropdownMenuLabel>Trade and view as</DropdownMenuLabel>
          <DropdownMenuRadioItem value="all" className="items-start py-1.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-soft text-primary">
              <LayersIcon className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium">All accounts</span>
              <span className="text-xs text-muted-foreground">
                {included.length} included · {fmtMoney(included.reduce((s, a) => s + a.netLiq, 0), { digits: 0 })} net liq
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {accounts.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id} className="items-start py-1.5">
              <BrokerMark id={a.brokerId} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {getBroker(a.brokerId).short} {a.label}
                  {!a.included ? <span className="text-xs font-normal text-muted-foreground">excluded</span> : null}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono tabular">{a.masked}</span>
                  <span className="tabular">{fmtMoney(a.netLiq, { digits: 0 })}</span>
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-xs text-muted-foreground">
          In scope: <span className="tabular">{fmtMoney(totals.netLiq, { digits: 0 })}</span> net liquidation. Manage inclusion under Brokers.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
