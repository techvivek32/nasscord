import { Check, Minus } from "lucide-react";
import { PLANS } from "@/lib/plans";
import type { Plan, PlanId } from "@/lib/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type CellValue = string | boolean;

interface Row {
  label: string;
  value: (plan: Plan) => CellValue;
}

const paid = (p: Plan) => p.id !== "starter";
const team = (p: Plan) => p.id === "desk" || p.id === "enterprise";

/** Rows derive from PLANS.limits where a limit exists, so the table can never disagree with the plan cards. */
const ROWS: Row[] = [
  { label: "Broker connections", value: (p) => (p.limits.brokers === "unlimited" ? "Unlimited" : String(p.limits.brokers)) },
  { label: "Seats", value: (p) => (p.limits.seats === "unlimited" ? "Unlimited" : String(p.limits.seats)) },
  { label: "Alert latency", value: (p) => (p.limits.alertDelayMin === 0 ? "Real-time" : `Delayed ${p.limits.alertDelayMin} min`) },
  { label: "Order engine", value: (p) => (paid(p) ? "Verified, with brackets" : false) },
  { label: "Options desk", value: paid },
  { label: "Risk sizing", value: paid },
  { label: "Trade archive", value: (p) => (paid(p) ? "Beyond the broker window" : "Broker window only") },
  { label: "Audit log", value: (p) => (team(p) ? "Team, exportable" : paid(p) ? "Personal" : false) },
  { label: "White-label", value: (p) => p.id === "enterprise" },
  { label: "SSO", value: (p) => (p.id === "enterprise" ? "SSO and SCIM" : false) },
  { label: "Support", value: (p) => ({ starter: "Email", pro: "Email, 1 business day", desk: "Priority", enterprise: "Named, with SLA" })[p.id] },
];

function Cell({ value, plan }: { value: CellValue; plan: PlanId }) {
  if (value === true)
    return (
      <span className="inline-flex items-center justify-center">
        <Check aria-hidden="true" className="size-4 text-primary" />
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
    <div className={cn("overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10", className)}>
      <Table className="min-w-[44rem]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-48 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Feature</TableHead>
            {PLANS.map((p) => (
              <TableHead key={p.id} className={cn("text-center text-xs font-semibold tracking-wide uppercase", p.featured ? "text-primary" : "text-muted-foreground")}>
                {p.name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ROWS.map((row) => (
            <TableRow key={row.label}>
              <TableCell className="font-medium">{row.label}</TableCell>
              {PLANS.map((p) => (
                <TableCell key={p.id} className={cn("text-center text-sm", p.featured && "bg-brand-soft/40")}>
                  <Cell value={row.value(p)} plan={p.id} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
