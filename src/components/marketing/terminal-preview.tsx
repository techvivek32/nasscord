import { getBroker } from "@/lib/brokers";
import { fmtMoney, fmtPrice } from "@/lib/format";
import type { BrokerId } from "@/lib/types";
import { LogoMark } from "@/components/brand/logo";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Pnl } from "@/components/pnl";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/*
 * Illustration of the trader terminal for the public site. Every figure below is made up for this picture and is
 * labelled "Example" on the window: it is not anyone's account and is never read from src/lib/api. The account
 * day P&L is the sum of its positions so the example is at least consistent with itself.
 */

interface ExampleAccount {
  brokerId: BrokerId;
  label: string;
  masked: string;
  netLiq: number;
  buyingPower: number;
  dayPnl: number;
}

interface ExamplePosition {
  symbol: string;
  brokerId: BrokerId;
  qty: number;
  last: number;
  dayPnl: number;
}

const ACCOUNTS: ExampleAccount[] = [
  { brokerId: "ibkr", label: "Individual", masked: "····4821", netLiq: 84_210.55, buyingPower: 61_402.1, dayPnl: 412.3 },
  { brokerId: "etrade", label: "Brokerage", masked: "····0937", netLiq: 31_775.1, buyingPower: 18_930.4, dayPnl: -96.4 },
];

const POSITIONS: ExamplePosition[] = [
  { symbol: "AAPL", brokerId: "ibkr", qty: 40, last: 228.14, dayPnl: 118.4 },
  { symbol: "NVDA", brokerId: "ibkr", qty: 60, last: 139.8, dayPnl: 201.6 },
  { symbol: "AMD", brokerId: "ibkr", qty: 50, last: 152.06, dayPnl: 92.3 },
  { symbol: "MSFT", brokerId: "etrade", qty: 15, last: 431.62, dayPnl: -42.75 },
  { symbol: "SPY", brokerId: "etrade", qty: 10, last: 571.33, dayPnl: -53.65 },
];

const TOTAL = ACCOUNTS.reduce((t, a) => ({ netLiq: t.netLiq + a.netLiq, dayPnl: t.dayPnl + a.dayPnl }), { netLiq: 0, dayPnl: 0 });

/**
 * The terminal as a browser window: the accounts you connected and one positions table across them, which is what
 * this release shows. Read-only: nothing here is interactive.
 */
export function TerminalPreview({ className }: { className?: string }) {
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
          <span className="mx-auto hidden border border-border bg-background px-3 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline">your-workspace.nasscord.com/app</span>
          <span className="ml-auto inline-flex items-center rounded-full border border-dashed border-input px-2.5 py-0.5 text-xs text-muted-foreground sm:ml-0">Example, made-up figures</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <span className="inline-flex items-center gap-2.5 font-heading text-base font-bold tracking-tight">
            <LogoMark size={24} />
            Nasscord
            <span className="ml-0.5 border-l border-input pl-2.5 font-sans text-[0.7rem] font-medium tracking-[0.08em] text-muted-foreground uppercase">Terminal</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-input px-2.5 py-0.5 text-xs font-medium">
            All accounts · {ACCOUNTS.length} brokers
          </span>
          <span className="ml-auto text-xs text-muted-foreground">Read-only</span>
        </div>
        <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[1fr_1.15fr]">
          <section aria-label="Example accounts" className="grid content-start gap-3">
            <div className="site-caption flex items-center justify-between text-muted-foreground">
              <span>Accounts</span>
              <span>Net liquidation</span>
            </div>
            <ul className="grid gap-2">
              {ACCOUNTS.map((a, i) => (
                <li key={a.masked} className="grid gap-2 border border-border bg-background p-3.5" {...reveal(150 + i * 140)}>
                  <div className="flex items-center gap-2.5">
                    <BrokerMark id={a.brokerId} size="sm" />
                    <span className="grid min-w-0">
                      <span className="truncate text-sm font-medium">
                        {getBroker(a.brokerId).short} {a.label}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground tabular">{a.masked}</span>
                    </span>
                    <span className="ml-auto font-mono text-sm font-medium tabular">{fmtMoney(a.netLiq)}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div className="grid gap-0.5 bg-site-band px-2 py-1.5">
                      <dt className="text-[11px] text-muted-foreground">Buying power</dt>
                      <dd className="font-mono text-sm tabular">{fmtMoney(a.buyingPower)}</dd>
                    </div>
                    <div className="grid gap-0.5 bg-site-band px-2 py-1.5">
                      <dt className="text-[11px] text-muted-foreground">Day P&amp;L</dt>
                      <dd className="text-sm">
                        <Pnl value={a.dayPnl} />
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
              <span className="text-muted-foreground">Combined</span>
              <span className="flex items-baseline gap-3">
                <span className="font-mono font-medium tabular">{fmtMoney(TOTAL.netLiq)}</span>
                <Pnl value={TOTAL.dayPnl} />
              </span>
            </div>
          </section>
          <section aria-label="Example positions" className="grid content-start gap-3">
            <div className="site-caption flex items-center justify-between text-muted-foreground">
              <span>Positions</span>
              <span>Day P&amp;L</span>
            </div>
            <div className="overflow-x-auto border border-border">
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
                  {POSITIONS.map((p, i) => (
                    <TableRow key={`${p.brokerId}-${p.symbol}`} className="transition-colors hover:bg-site-band/60" {...reveal(250 + i * 70)}>
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
            <p className="text-xs text-muted-foreground">One book across every account you include. Orders and executions have their own pages, read the same way.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
