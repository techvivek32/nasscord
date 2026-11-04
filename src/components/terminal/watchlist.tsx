"use client";

import * as React from "react";
import { toast } from "sonner";
import { PlusIcon, XIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { getBroker } from "@/lib/brokers";
import { fmtNum } from "@/lib/format";
import type { Position } from "@/lib/types";
import { useAccountScope, useScopedPositions } from "@/components/terminal/hooks";
import { useHydrateTerminalStore, useTerminalStore } from "@/components/terminal/store";

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

/**
 * Symbols the user follows, kept in this browser. There is no market data feed yet, so no prices,
 * changes or charts are shown; what the user holds in each symbol comes from their brokers.
 */
export function Watchlist() {
  const watchlist = useTerminalStore((s) => s.watchlist);
  const hydrated = useTerminalStore((s) => s.hydrated);
  const addWatch = useTerminalStore((s) => s.addWatch);
  const removeWatch = useTerminalStore((s) => s.removeWatch);
  useHydrateTerminalStore();
  const scope = useAccountScope();
  const { rows: positions, coverage, isLoading } = useScopedPositions();
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  const held = React.useMemo(() => {
    const map = new Map<string, Position[]>();
    for (const p of positions) map.set(p.symbol, [...(map.get(p.symbol) ?? []), p]);
    return map;
  }, [positions]);

  // What a symbol with no position says: only claim "not held" when the holdings were actually read.
  const notHeld = isLoading
    ? "Reading your holdings"
    : scope.scoped.length === 0
      ? "No broker account in view"
      : coverage === "none"
        ? "Holdings could not be read right now"
        : coverage === "partial"
          ? "Not held in the accounts that answered"
          : "Not held in the accounts in view";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const sym = draft.trim().toUpperCase();
    if (!sym) return;
    if (!SYMBOL.test(sym)) {
      setError("Enter a ticker symbol, for example AMD or BRK.B.");
      return;
    }
    if (watchlist.includes(sym)) {
      setError(`${sym} is already on the list.`);
      return;
    }
    addWatch(sym);
    setDraft("");
    setError(null);
  };

  if (!hydrated) return <Skeleton className="h-40 w-full rounded-xl" />;

  return (
    <>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="grid flex-1 gap-1.5 sm:max-w-xs">
          <Label htmlFor={`${id}-sym`}>Add symbol</Label>
          <Input
            id={`${id}-sym`}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value.toUpperCase());
              setError(null);
            }}
            placeholder="e.g. AMD or QQQ"
            className="font-mono uppercase"
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint`}
            autoComplete="off"
            maxLength={10}
          />
        </div>
        <Button type="submit" disabled={!draft.trim()}>
          <PlusIcon />
          Add
        </Button>
        <p id={`${id}-hint`} className={error ? "w-full text-xs text-destructive" : "w-full text-xs text-muted-foreground"}>
          {error ?? "Saved in this browser only. Prices appear here once Nasscord has a market data feed."}
        </p>
      </form>

      {watchlist.length === 0 ? (
        <EmptyState title="Your watchlist is empty" description="Add a symbol above. Nasscord has no market data feed yet, so the list shows the symbols and what you hold in them, without prices." />
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y divide-border" aria-label="Watchlist">
            {watchlist.map((symbol) => {
              const mine = held.get(symbol) ?? [];
              return (
                <li key={symbol} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
                  <span className="w-20 font-mono font-semibold">{symbol}</span>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {mine.length === 0 ? (
                      notHeld
                    ) : (
                      mine.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1.5">
                          <BrokerMark id={p.brokerId} size="xs" />
                          <span>
                            {getBroker(p.brokerId).short}: <span className="font-mono text-foreground tabular">{fmtNum(p.qty)}</span>
                            {p.secType && p.secType !== "STK" && p.secType !== "EQ" ? ` ${p.secType}` : " held"}
                          </span>
                        </span>
                      ))
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${symbol}`}
                    onClick={() => {
                      removeWatch(symbol);
                      toast(`${symbol} removed from the watchlist`, { action: { label: "Undo", onClick: () => addWatch(symbol) } });
                    }}
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}
