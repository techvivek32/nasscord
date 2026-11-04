"use client";

import * as React from "react";
import { toast } from "sonner";
import { useSetAccountIncluded } from "@/hooks/queries";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BrokerAccount } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ACCOUNT_TYPE_LABEL } from "@/components/brokers/connect/status";
import { fmtAmount } from "@/components/brokers/money";

/**
 * Included switch for one account. Saves through PATCH /api/broker/accounts/[id]; the switch shows the
 * value the user picked (the saved one once the save succeeds) and goes back, with the route's sentence, when it fails.
 */
export function IncludeSwitch({ account, label, id }: { account: BrokerAccount; label: string; id?: string }) {
  const mutation = useSetAccountIncluded();
  const [pending, setPending] = React.useState<boolean | null>(null);
  const checked = pending ?? account.included;

  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="hidden sm:inline" aria-hidden="true">
        {checked ? "Included" : "Excluded"}
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={mutation.isPending}
        aria-label={`Include ${label}`}
        onCheckedChange={(next) => {
          setPending(next);
          mutation.mutate(
            { accountId: account.id, included: next },
            {
              onError: (err) => toast.error(`${label} was not changed`, { description: err.message }),
              // The mutation refetches the connections before it settles, so the saved value takes over from here.
              onSettled: () => setPending(null),
            },
          );
        }}
      />
    </span>
  );
}

/** Accounts of one connection with their Included switches and the balances the broker reported. */
export function AccountIncludeList({ accounts, brokerShort, emptyText, className }: { accounts: BrokerAccount[]; brokerShort: string; emptyText: string; className?: string }) {
  // The same account can be listed twice on one page (a Brokers card and a connect dialog), so ids are per list.
  const uid = React.useId();
  if (accounts.length === 0) return <p className={cn("text-sm text-muted-foreground", className)}>{emptyText}</p>;
  return (
    <ul className={cn("grid gap-2", className)} aria-label={`${brokerShort} accounts`}>
      {accounts.map((a) => {
        const label = `${brokerShort} ${a.label} ${a.masked}`;
        const switchId = `${uid}-include-${a.id}`;
        return (
          <li key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <Label htmlFor={switchId} className="grid min-w-0 cursor-pointer gap-0.5 font-normal">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <span className="truncate">{a.label}</span>
                <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {ACCOUNT_TYPE_LABEL[a.type]}
                {a.netLiq !== undefined ? (
                  <>
                    {" · "}
                    <span className="font-mono tabular">{fmtAmount(a.netLiq, a.currency, { digits: 0 })}</span> net liq
                  </>
                ) : null}
              </span>
            </Label>
            <IncludeSwitch id={switchId} account={a} label={label} />
          </li>
        );
      })}
    </ul>
  );
}
