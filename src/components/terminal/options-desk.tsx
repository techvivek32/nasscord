"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAlerts } from "@/hooks/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState } from "@/components/page-header";
import { getBroker } from "@/lib/brokers";
import { sizeOptionByCapitalRisk } from "@/lib/engine";
import { fmtMoney, fmtNum, fmtPrice } from "@/lib/format";
import type { Alert, Order } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScoreTile } from "@/components/terminal/badges";
import { useAccountScope } from "@/components/terminal/hooks";
import { between, hashSeed } from "@/components/terminal/pseudo";
import { CardSkeleton } from "@/components/terminal/skeletons";
import { useTerminalStore } from "@/components/terminal/store";

export const OPTION_PRESETS = [0.1, 0.15, 0.2] as const;
type Preset = (typeof OPTION_PRESETS)[number];
const EXPIRY = "Oct 18";

interface Idea {
  alert: Alert;
  strike: number;
  premium: number;
  stopPremium: number;
  delta: number;
  iv: number;
}

/** Known demo ideas (premium, delta, IV) for the alerts in the mock set; anything else is derived from the ATR. */
const KNOWN: Record<string, { premium: number; delta: number; iv: number }> = {
  NVDA: { premium: 3.4, delta: 0.42, iv: 46.8 },
  AVGO: { premium: 4.1, delta: 0.41, iv: 41.2 },
  CRWD: { premium: 8.6, delta: 0.43, iv: 44.5 },
};

function strikeStep(price: number) {
  return price >= 500 ? 10 : price >= 100 ? 5 : 2.5;
}

/** Call idea one strike above the alert entry. */
function ideaFor(alert: Alert): Idea {
  const step = strikeStep(alert.entry);
  const strike = Math.ceil(alert.entry / step) * step;
  const seed = hashSeed(alert.symbol);
  const known = KNOWN[alert.symbol];
  const premium = known?.premium ?? Math.round(alert.atr * between(seed, 3, 2.4, 2.9) * 100) / 100;
  return { alert, strike, premium, stopPremium: Math.round(premium * 0.5 * 100) / 100, delta: known?.delta ?? between(seed, 4, 0.38, 0.46), iv: known?.iv ?? between(seed, 5, 34, 58, 1) };
}

function chainFor(idea: Idea) {
  const seed = hashSeed(idea.alert.symbol);
  const step = strikeStep(idea.alert.entry);
  const strikes = [-2, -1, 0, 1, 2].map((k) => idea.strike + k * step);
  return strikes.map((strike, i) => {
    const dist = (strike - idea.alert.entry) / idea.alert.entry;
    const mid = Math.max(0.15, idea.premium * (1 - dist * 9));
    const spread = Math.max(0.02, mid * 0.03);
    return {
      strike,
      bid: Math.round((mid - spread / 2) * 100) / 100,
      ask: Math.round((mid + spread / 2) * 100) / 100,
      delta: Math.max(0.08, Math.min(0.85, Math.round((idea.delta - dist * 5) * 100) / 100)),
      iv: Math.round((idea.iv + (i - 2) * 1.1) * 10) / 10,
      oi: Math.round(between(seed, 10 + i, 1800, 24000, 0) / 10) * 10,
    };
  });
}

export function OptionsDesk() {
  const { data, isLoading } = useAlerts();
  const scope = useAccountScope();
  const addLocalOrders = useTerminalStore((s) => s.addLocalOrders);
  const [preset, setPreset] = React.useState<Preset>(0.1);
  const [buying, setBuying] = React.useState<{ symbol: string; strike: number; ask: number; contracts: number } | null>(null);

  // Options route to the first account in scope whose broker connection carries the options permission.
  const optionsAccount = React.useMemo(() => {
    const brokers = new Set(scope.connections.filter((c) => c.permissions.includes("options")).map((c) => c.brokerId));
    return scope.scoped.find((a) => brokers.has(a.brokerId)) ?? null;
  }, [scope.connections, scope.scoped]);

  const placeOption = () => {
    if (!buying || !optionsAccount) return;
    const ts = Date.now();
    const ref = String(Math.floor(1000 + Math.random() * 8999));
    const broker = getBroker(optionsAccount.brokerId).short;
    const contract = `${buying.symbol} ${buying.strike}C ${EXPIRY}`;
    const parent: Order = {
      id: `loc_${ts}`,
      clientId: `nova-${Math.floor(ts / 1000)}-${Math.random().toString(16).slice(2, 6)}`,
      accountId: optionsAccount.id,
      brokerId: optionsAccount.brokerId,
      symbol: contract,
      side: "BUY",
      qty: buying.contracts,
      type: "LMT",
      price: buying.ask,
      tif: "DAY",
      status: "verified",
      placedAt: new Date(ts).toISOString(),
      brokerRef: ref,
    };
    const stop: Order = { ...parent, id: `${parent.id}_s`, side: "SELL", type: "STP", price: Math.round(buying.ask * 0.5 * 100) / 100, tif: "GTC", status: "working", parentId: parent.id, placedAt: new Date(ts + 1000).toISOString(), brokerRef: `${ref}1` };
    addLocalOrders([parent, stop]);
    toast.success(`Live at ${broker} · #${ref}: BUY ${buying.contracts} ${contract} @ ${buying.ask.toFixed(2)}`, { description: "Verified in the broker order book with the stop attached. Track it under Orders." });
    setBuying(null);
  };

  if (isLoading || scope.isLoading || !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
        <CardSkeleton lines={4} />
      </div>
    );
  }

  const ideas = [...data.open].sort((a, b) => b.score - a.score).slice(0, 3).map(ideaFor);
  const netLiq = scope.totals.netLiq;
  const chainIdea = ideas[0];

  if (ideas.length === 0) return <EmptyState title="No option ideas right now" description="Ideas come from the top open TradeScope alerts. When the scanner publishes a setup, a call one strike above entry appears here." />;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Capital-risk preset: contracts are sized so losing the stop premium costs the chosen share of <span className="font-mono tabular">{fmtMoney(netLiq, { digits: 0 })}</span> net liquidation in scope.
        </p>
        <ToggleGroup value={[String(preset)]} onValueChange={(v) => v[0] && setPreset(Number(v[0]) as Preset)} variant="outline" size="sm" spacing={0} aria-label="Capital risk preset">
          {OPTION_PRESETS.map((p) => (
            <ToggleGroupItem key={p} value={String(p)} className="font-mono">
              {p.toFixed(2)}%
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {ideas.map((idea) => {
          const sized = sizeOptionByCapitalRisk(netLiq, preset, idea.premium, idea.stopPremium);
          return (
            <Card key={idea.alert.id}>
              <CardHeader>
                <div className="flex items-start gap-3">
                  <ScoreTile score={idea.alert.score} className="size-10 text-base" />
                  <div className="min-w-0">
                    <CardTitle className="font-mono">
                      {idea.alert.symbol} {idea.strike}C {EXPIRY}
                    </CardTitle>
                    <CardDescription>
                      {idea.alert.company} · underlying {fmtPrice(idea.alert.last)}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Premium</p>
                  <p className="font-mono font-semibold tabular">{idea.premium.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Delta</p>
                  <p className="font-mono font-semibold tabular">{idea.delta.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">IV</p>
                  <p className="font-mono font-semibold tabular">{idea.iv.toFixed(1)}%</p>
                </div>
              </CardContent>
              <CardContent className="rounded-none border-t pt-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted-foreground">At {preset.toFixed(2)}% capital risk</span>
                  <span className="font-heading text-xl font-semibold tabular">
                    {sized.contracts} <span className="text-sm font-normal text-muted-foreground">{sized.contracts === 1 ? "contract" : "contracts"}</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Stop at {idea.stopPremium.toFixed(2)} · risk {fmtMoney(sized.riskDollars, { digits: 0 })} · cost {fmtMoney(sized.notional, { digits: 0 })}
                  {sized.contracts === 0 ? " · below one contract at this preset" : ""}
                </p>
              </CardContent>
              <CardContent className="flex items-center justify-between gap-2">
                <div className="flex gap-1">
                  {idea.alert.reasons.slice(0, 2).map((r) => (
                    <Badge key={r} variant="outline" className="font-normal">
                      {r.split(" (")[0]}
                    </Badge>
                  ))}
                </div>
                <Button size="sm" disabled={sized.contracts === 0} onClick={() => setBuying({ symbol: idea.alert.symbol, strike: idea.strike, ask: idea.premium, contracts: sized.contracts })}>
                  Buy
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="font-mono">
            {chainIdea.alert.symbol} calls · {EXPIRY}
          </CardTitle>
          <CardDescription>Five strikes around the idea. Quotes are delayed demo values; the terminal streams live greeks from the broker.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-xs tracking-wide text-muted-foreground uppercase">Strike</TableHead>
                <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">Bid</TableHead>
                <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">Ask</TableHead>
                <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">Delta</TableHead>
                <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">IV</TableHead>
                <TableHead className="text-right text-xs tracking-wide text-muted-foreground uppercase">OI</TableHead>
                <TableHead className="pr-4 text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chainFor(chainIdea).map((row) => {
                const atIdea = row.strike === chainIdea.strike;
                const sized = sizeOptionByCapitalRisk(netLiq, preset, row.ask, Math.round(row.ask * 0.5 * 100) / 100);
                return (
                  <TableRow key={row.strike} className={cn(atIdea && "bg-brand-soft/40")}>
                    <TableCell className="pl-4 font-mono font-semibold tabular">
                      {row.strike}
                      {atIdea ? <span className="ml-2 text-[10px] font-normal text-primary uppercase">idea</span> : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular">{row.bid.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono tabular">{row.ask.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono tabular">{row.delta.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-mono tabular">{row.iv.toFixed(1)}%</TableCell>
                    <TableCell className="text-right font-mono tabular">{fmtNum(row.oi)}</TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button variant="outline" size="sm" disabled={sized.contracts === 0} onClick={() => setBuying({ symbol: chainIdea.alert.symbol, strike: row.strike, ask: row.ask, contracts: sized.contracts })}>
                        Buy
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={buying !== null} onOpenChange={(o) => !o && setBuying(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buy {buying ? `${buying.contracts} x ${buying.symbol} ${buying.strike}C ${EXPIRY}` : ""}</DialogTitle>
            <DialogDescription>
              {buying ? (
                <>
                  Limit at the ask, <span className="font-mono text-foreground">{buying.ask.toFixed(2)}</span>, for <span className="font-mono text-foreground">{fmtMoney(buying.contracts * buying.ask * 100)}</span>. A stop at half the premium is attached.{" "}
                  {optionsAccount ? (
                    <>
                      Routes to{" "}
                      <span className="text-foreground">
                        {getBroker(optionsAccount.brokerId).short} {optionsAccount.label} <span className="font-mono">{optionsAccount.masked}</span>
                      </span>
                      , the first account in scope with options permission.
                    </>
                  ) : (
                    "No account in scope has options permission. Pick another account in the header, or include one under Brokers."
                  )}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuying(null)}>
              Cancel
            </Button>
            <Button disabled={!optionsAccount} onClick={placeOption}>
              Place order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
