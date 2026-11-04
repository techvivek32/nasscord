"use client";

import * as React from "react";
import Link from "next/link";
import { EyeIcon, SendIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getBroker } from "@/lib/brokers";
import { round2, sizeByRisk } from "@/lib/engine";
import { fmtMoney, fmtNum } from "@/lib/format";
import type { BrokerAccount, OrderSide } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountScope } from "@/components/terminal/hooks";
import { CardSkeleton } from "@/components/terminal/skeletons";

export const ORDER_ENTRY_OFF = "Order entry is switched off in this release. Place orders in your broker's app for now.";

function num(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function accountLabel(a: BrokerAccount) {
  return `${getBroker(a.brokerId).short} ${a.label} ${a.masked}`;
}

/**
 * The order ticket in the read-only release: a position-size calculator over a real account's net
 * liquidation and the user's saved risk per trade. Placing is disabled and says why; nothing is sent.
 */
export function OrderTicket({ riskPct, className }: { riskPct: number; className?: string }) {
  const scope = useAccountScope();
  const id = React.useId();
  const [side, setSide] = React.useState<OrderSide>("BUY");
  const [symbol, setSymbol] = React.useState("");
  const [entryText, setEntryText] = React.useState("");
  const [stopText, setStopText] = React.useState("");
  const [targetText, setTargetText] = React.useState("");
  const [chosen, setChosen] = React.useState<string | null>(null);

  // Sizing needs a net liquidation the broker reported, in US dollars: entry and stop are US share prices.
  const reporting = React.useMemo(() => scope.scoped.filter((a) => typeof a.netLiq === "number" && a.netLiq > 0), [scope.scoped]);
  const eligible = React.useMemo(() => reporting.filter((a) => !a.currency || a.currency.toUpperCase() === "USD"), [reporting]);
  const accountId = chosen && eligible.some((a) => a.id === chosen) ? chosen : (eligible[0]?.id ?? "");
  const account = eligible.find((a) => a.id === accountId) ?? null;

  const entry = num(entryText);
  const stop = num(stopText);
  const target = num(targetText);
  const long = side === "BUY";
  const stopOk = long ? stop < entry : stop > entry;
  const targetOk = long ? target > entry : target < entry;
  const stopError = entry > 0 && stop > 0 && !stopOk ? `The stop goes ${long ? "below" : "above"} the entry for a ${long ? "buy" : "sell"}.` : null;
  const targetError = !stopError && entry > 0 && target > 0 && !targetOk ? `The target goes ${long ? "above" : "below"} the entry for a ${long ? "buy" : "sell"}.` : null;
  const sizing = account && entry > 0 && stop > 0 && stopOk ? sizeByRisk(account.netLiq ?? 0, riskPct, entry, stop) : null;
  const rr = sizing && target > 0 && targetOk ? Math.abs(target - entry) / Math.max(0.01, Math.abs(entry - stop)) : null;

  if (scope.isLoading) return <CardSkeleton lines={6} className={className} />;

  const items = eligible.map((a) => ({ value: a.id, label: accountLabel(a) }));

  return (
    <Card id="order-ticket" className={className}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Order ticket</CardTitle>
          <Badge variant="secondary" className="gap-1">
            <EyeIcon />
            Read only
          </Badge>
        </div>
        <CardDescription>Size a trade so a stop-out costs {riskPct}% of the account&apos;s net liquidation, your saved risk per trade.</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {eligible.length === 0 ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {scope.connections.length === 0 ? (
              <>
                Sizing uses an account&apos;s net liquidation.{" "}
                <Link href="/app/brokers" className="text-primary underline-offset-2 hover:underline">
                  Connect IBKR or E*TRADE
                </Link>{" "}
                to size against your own account.
              </>
            ) : reporting.length > 0 ? (
              "Sizing works in US dollars, and the accounts in view report their balance in another currency."
            ) : (
              "No account in view reports a net liquidation right now, so there is nothing to size against."
            )}
          </p>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-acct`}>Account</Label>
            <Select items={items} value={accountId} onValueChange={(v) => v && setChosen(String(v))}>
              <SelectTrigger id={`${id}-acct`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center gap-2">
                      <BrokerMark id={a.brokerId} size="xs" />
                      {getBroker(a.brokerId).short} {a.label}
                      <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {account ? (
              <p className="text-xs text-muted-foreground">
                Net liq <span className="font-mono tabular">{fmtMoney(account.netLiq ?? 0, { digits: 0 })}</span>
                {account.buyingPower !== undefined ? (
                  <>
                    {" · "}buying power <span className="font-mono tabular">{fmtMoney(account.buyingPower, { digits: 0 })}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        )}

        <div className="grid grid-cols-[auto_1fr] gap-2">
          <ToggleGroup value={[side]} onValueChange={(v) => v[0] && setSide(v[0] as OrderSide)} variant="outline" spacing={0} aria-label="Side">
            <ToggleGroupItem value="BUY">Buy</ToggleGroupItem>
            <ToggleGroupItem value="SELL">Sell</ToggleGroupItem>
          </ToggleGroup>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-sym`} className="sr-only">
              Symbol
            </Label>
            <Input id={`${id}-sym`} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol" className="font-mono uppercase" autoComplete="off" maxLength={12} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-entry`}>Entry</Label>
            <Input id={`${id}-entry`} inputMode="decimal" value={entryText} onChange={(e) => setEntryText(e.target.value)} className="font-mono tabular" placeholder="0.00" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-stop`}>Stop</Label>
            <Input id={`${id}-stop`} inputMode="decimal" value={stopText} onChange={(e) => setStopText(e.target.value)} className="font-mono tabular" placeholder="0.00" aria-invalid={stopError ? true : undefined} aria-describedby={stopError ? `${id}-err` : undefined} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-target`}>Target</Label>
            <Input id={`${id}-target`} inputMode="decimal" value={targetText} onChange={(e) => setTargetText(e.target.value)} className="font-mono tabular" placeholder="optional" aria-invalid={targetError ? true : undefined} aria-describedby={targetError ? `${id}-err` : undefined} />
          </div>
        </div>
        {stopError || targetError ? (
          <p id={`${id}-err`} role="alert" className="-mt-1 text-xs text-destructive">
            {stopError ?? targetError}
          </p>
        ) : null}

        <dl className="grid gap-1 rounded-lg bg-muted/60 p-3 text-xs" aria-live="polite">
          {sizing ? (
            <>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Quantity</dt>
                <dd className="font-mono font-semibold tabular">{fmtNum(sizing.qty)} sh</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">At risk to the stop</dt>
                <dd className="font-mono tabular">{fmtMoney(sizing.riskDollars)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Position value</dt>
                <dd className="font-mono tabular">{fmtMoney(sizing.notional, { digits: 0 })}</dd>
              </div>
              {rr !== null ? (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Reward to risk</dt>
                  <dd className="font-mono tabular">
                    {rr.toFixed(2)} ({fmtMoney(round2(Math.abs(target - entry) * sizing.qty))} to the target)
                  </dd>
                </div>
              ) : null}
              {sizing.cappedByCash ? <p className="text-muted-foreground">Capped so the position stays within 95% of net liquidation.</p> : null}
            </>
          ) : (
            <p className="text-muted-foreground">{account ? "Enter an entry and a stop to see the quantity." : "Pick an account to size against."}</p>
          )}
        </dl>

        <Button size="lg" className="w-full" disabled aria-describedby={`${id}-off`}>
          <SendIcon />
          {side === "BUY" ? "Buy" : "Sell"} {sizing && sizing.qty > 0 ? fmtNum(sizing.qty) : ""} {symbol || "shares"}
        </Button>
        <p id={`${id}-off`} className={cn("-mt-1 text-xs text-muted-foreground")}>
          {ORDER_ENTRY_OFF}
        </p>
      </CardContent>
    </Card>
  );
}
