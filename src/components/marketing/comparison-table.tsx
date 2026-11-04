import { Fragment } from "react";
import { Check, Minus } from "lucide-react";
import { PLANS } from "@/lib/plans";
import type { Plan } from "@/lib/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type CellValue = string | boolean;

interface Row {
  label: string;
  value: (plan: Plan) => CellValue;
}

const paid = (p: Plan) => p.id !== "starter";
const limit = (n: number | "unlimited") => (n === "unlimited" ? "Unlimited" : String(n));

/**
 * Rows derive from PLANS.limits where a limit exists, so the table can never disagree with the plan cards. The
 * first group is what works in this release; the second is planned and not switched on yet.
 */
const GROUPS: Array<{ title: string; note?: string; rows: Row[] }> = [
  {
    title: "In this release",
    rows: [
      { label: "Connect IBKR and E*TRADE", value: () => true },
      { label: "Accounts, balances and positions", value: () => true },
      { label: "Orders and executions", value: () => true },
      { label: "Choose which accounts count", value: () => true },
    ],
  },
  {
    title: "Planned",
    note: "Not switched on in this release.",
    rows: [
      { label: "Broker connection limit", value: (p) => limit(p.limits.brokers) },
      { label: "TradeScope alerts", value: (p) => (p.limits.alertDelayMin === 0 ? "Real-time" : `Delayed ${p.limits.alertDelayMin} min`) },
      { label: "Order entry", value: paid },
      { label: "Seats", value: (p) => limit(p.limits.seats) },
    ],
  },
];

function Cell({ value, plan }: { value: CellValue; plan: string }) {
  if (value === true)
    return (
      <span className="inline-flex items-center justify-center">
        <Check aria-hidden="true" className="size-4 text-site-accent-ink" />
        <span className="sr-only">Included in {plan}</span>
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex items-center justify-center">
        <Minus aria-hidden="true" className="size-4 text-muted-foreground/60" />
        <span className="sr-only">Not included in {plan}</span>
      </span>
    );
  return <span>{value}</span>;
}

export function ComparisonTable({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-x-auto border-t border-b border-foreground", className)}>
      <Table className="min-w-[44rem]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-56 site-caption text-muted-foreground">Feature</TableHead>
            {PLANS.map((p) => (
              <TableHead key={p.id} className={cn("site-caption text-center", p.featured ? "text-site-accent-ink" : "text-muted-foreground")}>
                {p.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {GROUPS.map((g) => (
            <Fragment key={g.title}>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={PLANS.length + 1} className="pt-6">
                  <span className="site-label">{g.title}</span>
                  {g.note ? <span className="ml-3 text-xs text-muted-foreground">{g.note}</span> : null}
                </TableCell>
              </TableRow>
              {g.rows.map((row) => (
                <TableRow key={row.label} className="transition-colors hover:bg-site-band/60">
                  <TableCell className={cn("font-medium", g.note && "text-muted-foreground")}>{row.label}</TableCell>
                  {PLANS.map((p) => (
                    <TableCell key={p.id} className={cn("text-center text-sm", p.featured && "bg-site-band", g.note && "text-muted-foreground")}>
                      <Cell value={row.value(p)} plan={p.name} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
