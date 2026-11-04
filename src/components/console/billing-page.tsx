import { EmptyState } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtMoney, fmtNum } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import type { PlanId } from "@/lib/types";
import { TH } from "./primitives";

const limit = (v: number | "unlimited") => (v === "unlimited" ? "Unlimited" : fmtNum(v));
const price = (v: number | null) => (v === null ? "Custom" : v === 0 ? "Free" : `${fmtMoney(v, { digits: 0 })} / mo`);

/** The plan catalog from src/lib/plans with how many workspaces are on each plan today. Read-only. */
export function PlanCatalogCard({ workspacesByPlan }: { workspacesByPlan: Record<PlanId, number> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Plans</CardTitle>
        <CardDescription>The catalog the pricing page and signup use, defined in the code. Changing a price or limit is a code change.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={TH}>Plan</TableHead>
                <TableHead className={`${TH} text-right`}>Monthly</TableHead>
                <TableHead className={`${TH} text-right`}>Yearly, per month</TableHead>
                <TableHead className={`${TH} text-right`}>Brokers</TableHead>
                <TableHead className={`${TH} text-right`}>Seats</TableHead>
                <TableHead className={`${TH} text-right`}>Alert delay</TableHead>
                <TableHead className={`${TH} text-right`}>Workspaces</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {PLANS.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className="grid gap-0.5">
                      <span className="font-medium">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{p.tagline}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular">{price(p.monthly)}</TableCell>
                  <TableCell className="text-right tabular">{price(p.yearly)}</TableCell>
                  <TableCell className="text-right tabular">{limit(p.limits.brokers)}</TableCell>
                  <TableCell className="text-right tabular">{limit(p.limits.seats)}</TableCell>
                  <TableCell className="text-right tabular">{p.limits.alertDelayMin === 0 ? "Real time" : `${p.limits.alertDelayMin} min`}</TableCell>
                  <TableCell className="text-right font-medium tabular">{fmtNum(workspacesByPlan[p.id])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export function InvoicesCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices and payments</CardTitle>
      </CardHeader>
      <CardContent>
        <EmptyState title="Stripe is not connected yet" description="There are no invoices, payments or subscriptions to show until billing is connected." />
      </CardContent>
    </Card>
  );
}
