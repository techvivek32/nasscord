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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/**
 * Preview of the trader terminal for the marketing site, framed as a browser window and built from the same
 * components the terminal uses. Alerts and rows slide in once it scrolls into view and the sparklines trace
 * themselves. Read-only: nothing here is interactive except the logo link.
 */
export function TerminalPreview({ alerts, positions, brokerCount, className }: { alerts: Alert[]; positions: Position[]; brokerCount: number; className?: string }) {
  return (
    <div className={cn("relative", className)} {...reveal(0, "scale")}>
      <div className="overflow-hidden border border-foreground bg-card shadow-[0_40px_90px_-60px_color-mix(in_oklab,var(--site-ink)_70%,transparent)]">
        {/* window chrome */}
        <div className="flex items-center gap-3 border-b border-foreground bg-site-band px-4 py-2.5">
          <span aria-hidden="true" className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
            <span className="size-2.5 rounded-full bg-foreground/15" />
          </span>
          <span className="mx-auto hidden border border-border bg-background px-3 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">vivek.nasscord.com/app</span>
          <DemoFlag className="ml-auto sm:ml-0" />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <Logo sub="Terminal" href="/app" size={24} className="text-base" />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-input px-2.5 py-0.5 text-xs font-medium">All accounts · {brokerCount} brokers</span>
          <div className="ml-auto flex items-center gap-3">
            <StatusDot tone="good" pulse label="Session live" className="text-xs" />
          </div>
        </div>
        <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[1.15fr_1fr]">
          <section aria-label="TradeScope alerts" className="grid content-start gap-3">
            <div className="site-caption flex items-center justify-between text-muted-foreground">
              <span>TradeScope alerts</span>
              <span className="tabular">
                Score gate {ENGINE_DEFAULTS.minScore} · {ENGINE_DEFAULTS.timeframe}
              </span>
            </div>
            {alerts.map((a, i) => (
              <AlertPreview key={a.id} alert={a} index={i} />
            ))}
          </section>
          <section aria-label="Positions" className="grid content-start gap-3">
            <div className="site-caption flex items-center justify-between text-muted-foreground">
              <span>Positions</span>
              <span>Day P&amp;L</span>
            </div>
            <div className="overflow-hidden border border-border">
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
                  {positions.map((p, i) => (
                    <TableRow key={p.id} className="transition-colors hover:bg-site-band/60" {...reveal(250 + i * 70)}>
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
      </div>
    </div>
  );
}

function AlertPreview({ alert, index }: { alert: Alert; index: number }) {
  return (
    <article aria-label={`${alert.symbol} alert`} className="grid gap-3 border border-border bg-background p-3.5 transition-[border-color,transform] duration-500 hover:-translate-y-0.5 hover:border-foreground" {...reveal(150 + index * 140)}>
      <div className="flex items-center gap-3">
        <Badge className="rounded-[2px] font-mono tabular">Score {alert.score}</Badge>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-base font-semibold">{alert.symbol}</span>
            <span className="truncate text-xs text-muted-foreground">{alert.company}</span>
          </div>
        </div>
        <div className="site-draw ml-auto shrink-0" data-play style={{ "--d": `${400 + index * 200}ms` } as React.CSSProperties}>
          <Sparkline data={alert.spark} className="h-7 w-20" />
        </div>
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
    <div className="grid gap-0.5 bg-site-band px-2 py-1.5">
      <dt className="truncate text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm font-medium tabular">{fmtPrice(value)}</dd>
    </div>
  );
}
