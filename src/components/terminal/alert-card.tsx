"use client";

import { ActivityIcon, ArrowRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/sparkline";
import { PctChange } from "@/components/pnl";
import { fmtPrice, fmtTimeET } from "@/lib/format";
import type { Alert } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ScoreTile, SentimentBadge } from "@/components/terminal/badges";

export function LevelRow({ alert, className }: { alert: Alert; className?: string }) {
  const risk = alert.entry - alert.stop0;
  const cells = [
    { k: "Entry", v: fmtPrice(alert.entry), sub: `ATR ${alert.atr.toFixed(2)} (${alert.atrPct.toFixed(2)}%)` },
    { k: alert.movedBE ? "Stop (breakeven)" : "Stop", v: fmtPrice(alert.stop), sub: `-${((risk / alert.entry) * 100).toFixed(2)}% · 2.2x ATR` },
    { k: "Target", v: fmtPrice(alert.target), sub: `+${(((alert.target - alert.entry) / alert.entry) * 100).toFixed(2)}% · R:R ${alert.riskReward.toFixed(2)}` },
  ];
  return (
    <dl className={cn("grid grid-cols-3 gap-2", className)}>
      {cells.map((c) => (
        <div key={c.k} className="rounded-lg bg-muted/60 px-2.5 py-2">
          <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{c.k}</dt>
          <dd className="font-mono text-sm font-semibold tabular">{c.v}</dd>
          <dd className="truncate text-[11px] text-muted-foreground">{c.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AlertCard({ alert, held, onBuy, onDetails }: { alert: Alert; held: boolean; onBuy: (a: Alert) => void; onDetails: (a: Alert) => void }) {
  const movePct = ((alert.last - alert.entry) / alert.entry) * 100;
  return (
    <Card className="gap-3" aria-label={`${alert.symbol} alert, score ${alert.score}`}>
      <div className="flex items-start gap-3 px-4">
        <ScoreTile score={alert.score} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-base font-semibold tracking-tight">{alert.symbol}</span>
            <span className="truncate text-sm text-muted-foreground">{alert.company}</span>
            {held ? (
              <Badge variant="secondary" className="bg-brand-soft text-primary">
                Held
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {alert.reasons.map((r) => (
              <Badge key={r} variant="outline" className="font-normal">
                {r}
              </Badge>
            ))}
          </div>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
          <Sparkline data={alert.spark} className="h-8 w-28" color={alert.last >= alert.entry ? "var(--gain)" : "var(--loss)"} />
          <span className="flex items-center gap-1.5 font-mono text-xs tabular">
            {fmtPrice(alert.last)}
            <PctChange value={movePct} />
          </span>
        </div>
      </div>

      <LevelRow alert={alert} className="px-4" />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 pt-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ActivityIcon className="size-3.5" aria-hidden="true" />
            Opened {fmtTimeET(alert.openedAt)} · {alert.ticks} ticks
          </span>
          {alert.news ? <SentimentBadge sentiment={alert.news.sentiment} /> : null}
          <span className="sm:hidden">
            <PctChange value={movePct} />
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onDetails(alert)}>
            Details
          </Button>
          <Button size="sm" onClick={() => onBuy(alert)}>
            Buy
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
