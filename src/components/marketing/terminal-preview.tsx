import { getBroker } from "@/lib/brokers";
import { ENGINE_DEFAULTS } from "@/lib/engine";
import { fmtPrice } from "@/lib/format";
import type { Alert, Position } from "@/lib/types";
import { Logo } from "@/components/brand/logo";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Sparkline } from "@/components/charts/sparkline";
import { DemoFlag } from "@/components/page-header";
import { Pnl } from "@/components/pnl";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Static preview of the trader terminal for the marketing site, built from the same components the
 * terminal uses. Read-only: nothing here is interactive except the logo link.
 */
export function TerminalPreview({ alerts, positions, brokerCount, className }: { alerts: Alert[]; positions: Position[]; brokerCount: number; className?: string }) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Logo sub="Terminal" href="/app" size={24} className="text-base" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-input px-2.5 py-0.5 text-xs font-medium">
          All accounts · {brokerCount} brokers
        </span>
        <div className="ml-auto flex items-center gap-3">
          <DemoFlag className="hidden sm:inline-flex" />
          <StatusDot tone="good" pulse label="Session live" className="text-xs" />
        </div>
      </div>
      <div className="grid gap-5 p-4 lg:grid-cols-[1.15fr_1fr]">
        <section aria-label="TradeScope alerts" className="grid content-start gap-3">
          <div className="flex items-center justify-between text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <span>TradeScope alerts</span>
            <span className="tabular">
              Score gate {ENGINE_DEFAULTS.minScore} · {ENGINE_DEFAULTS.timeframe}
            </span>
          </div>
          {alerts.map((a) => (
            <AlertPreview key={a.id} alert={a} />
          ))}
        </section>
        <section aria-label="Positions" className="grid content-start gap-3">
          <div className="flex items-center justify-between text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <span>Positions</span>
            <span>Day P&amp;L</span>
          </div>
          <div className="overflow-hidden rounded-lg ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs text-muted-foreground">Symbol</TableHead>
                  <TableHead className="text-right text-xs text-muted-foreground">Qty</TableHead>
                  <TableHead className="text-right text-xs text-muted-foreground">Last</TableHead>
                  <TableHead className="text-right text-xs text-muted-foreground">Day</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {positions.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2">
                        <BrokerMark id={p.brokerId} size="xs" />
                        <span className="font-mono text-sm font-medium">{p.symbol}</span>
                        <span className="hidden text-xs text-muted-foreground sm:inline">{getBroker(p.brokerId).short}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular">{p.qty}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular">{fmtPrice(p.last)}</TableCell>
                    <TableCell className="text-right text-sm">
                      <Pnl value={p.dayPnl} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">One book across every connected account. Buying power and net liquidation roll up the same way.</p>
        </section>
      </div>
    </Card>
  );
}

function AlertPreview({ alert }: { alert: Alert }) {
  return (
    <article aria-label={`${alert.symbol} alert`} className="grid gap-3 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex items-center gap-3">
        <Badge className="tabular">Score {alert.score}</Badge>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-base font-semibold">{alert.symbol}</span>
            <span className="truncate text-xs text-muted-foreground">{alert.company}</span>
          </div>
        </div>
        <Sparkline data={alert.spark} className="ml-auto h-7 w-20 shrink-0" />
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="Reasons">
        {alert.reasons.map((r) => (
          <li key={r}>
            <Badge variant="secondary" className="text-[11px]">
              {r}
            </Badge>
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <Level label="Entry" value={alert.entry} />
        <Level label={`Stop · ${ENGINE_DEFAULTS.atrStopMultiple}x ATR`} value={alert.stop} />
        <Level label={`Target · R:R ${alert.riskReward}`} value={alert.target} />
      </dl>
    </article>
  );
}

function Level({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid gap-0.5 rounded-md bg-muted/60 px-2 py-1.5">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-medium tabular">{fmtPrice(value)}</dd>
    </div>
  );
}
