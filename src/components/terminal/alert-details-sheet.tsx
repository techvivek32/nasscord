"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Sparkline } from "@/components/charts/sparkline";
import { PctChange } from "@/components/pnl";
import { TONE_BADGE } from "@/components/status-dot";
import { fmtDateTime, fmtPrice } from "@/lib/format";
import type { Alert } from "@/lib/types";
import { LevelRow } from "@/components/terminal/alert-card";
import { ScoreTile, SentimentBadge } from "@/components/terminal/badges";

function Field({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 text-sm last:border-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-mono tabular">{v}</dd>
    </div>
  );
}

export function AlertDetailsSheet({ alert, history, open, onOpenChange, onBuy }: { alert: Alert | null; history: Alert[]; open: boolean; onOpenChange: (open: boolean) => void; onBuy: (a: Alert) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {alert ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-3">
                <ScoreTile score={alert.score} />
                <div>
                  <SheetTitle className="font-mono">
                    {alert.symbol} <span className="font-sans font-normal text-muted-foreground">{alert.company}</span>
                  </SheetTitle>
                  <SheetDescription>
                    TradeScope #{alert.id} · {alert.timeframe} · opened {fmtDateTime(alert.openedAt)}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div className="grid gap-4 px-4">
              <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">Last</p>
                  <p className="font-mono text-lg font-semibold tabular">{fmtPrice(alert.last)}</p>
                  <PctChange value={((alert.last - alert.entry) / alert.entry) * 100} className="text-xs" />
                </div>
                <Sparkline data={alert.spark} className="h-12 w-40" color={alert.last >= alert.entry ? "var(--gain)" : "var(--loss)"} />
              </div>
              <LevelRow alert={alert} />
              <div>
                <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Why it fired</p>
                <div className="flex flex-wrap gap-1">
                  {alert.reasons.map((r) => (
                    <Badge key={r} variant="outline" className="font-normal">
                      {r}
                    </Badge>
                  ))}
                </div>
              </div>
              <dl>
                <Field k="RSI (14)" v={alert.rsi.toFixed(1)} />
                <Field k="ADX (14)" v={alert.adx.toFixed(1)} />
                <Field k="Relative volume" v={`${alert.relVol.toFixed(1)}x`} />
                <Field k="ATR" v={`${alert.atr.toFixed(2)} (${alert.atrPct.toFixed(2)}%)`} />
                <Field k="Original stop" v={fmtPrice(alert.stop0)} />
                <Field k="Trailed to breakeven" v={alert.movedBE ? "Yes" : "Not yet"} />
                <Field k="Ticks since open" v={alert.ticks} />
              </dl>
              {alert.news ? (
                <div className="rounded-lg border p-3">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">News model</p>
                    <SentimentBadge sentiment={alert.news.sentiment} />
                  </div>
                  {alert.news.headline ? <p className="text-sm font-medium">{alert.news.headline}</p> : <p className="text-sm text-muted-foreground">No headline moved the score. The model only runs during market hours.</p>}
                  {alert.news.reason ? <p className="mt-1 text-xs text-muted-foreground">{alert.news.reason}</p> : null}
                  {alert.news.source ? <p className="mt-1 text-xs text-muted-foreground">Source: {alert.news.source}</p> : null}
                </div>
              ) : null}
              <div>
                <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Earlier alerts on {alert.symbol}</p>
                {history.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No closed alerts for this symbol in the last 30 days.</p>
                ) : (
                  <ul className="grid gap-1.5">
                    {history.map((h) => (
                      <li key={h.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                        <span className="text-muted-foreground">{fmtDateTime(h.openedAt)}</span>
                        <span className="flex items-center gap-2">
                          <Badge variant="secondary" className={h.status === "target" ? TONE_BADGE.good : TONE_BADGE.bad}>
                            {h.status === "target" ? "Target" : "Stopped"}
                          </Badge>
                          {h.resultPct !== undefined ? <PctChange value={h.resultPct} /> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <SheetFooter className="flex-row justify-end border-t">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  onBuy(alert);
                  onOpenChange(false);
                }}
              >
                Load ticket
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
