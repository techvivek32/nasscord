"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDate, fmtMoney, fmtNum } from "@/lib/format";
import { PROGRAM, useCurrentTenant } from "./current";
import { ErrorState, KV, TableSkeleton } from "./primitives";
import { PLAN_FEATURES, SEAT_MIX, useTenantStore, type TenantPlanId, type TenantPlanMatrix } from "./store";
import { WhiteLabelGate } from "./white-label-gate";

const PLAN_IDS: TenantPlanId[] = ["basic", "plus", "desk"];

function diffMatrix(a: TenantPlanMatrix, b: TenantPlanMatrix) {
  const out: string[] = [];
  for (const id of PLAN_IDS) {
    if (a[id].monthly !== b[id].monthly) out.push(`${b[id].name}: ${fmtMoney(a[id].monthly, { digits: 0 })} to ${fmtMoney(b[id].monthly, { digits: 0 })} per month`);
    for (const f of PLAN_FEATURES) {
      if (a[id].features[f.key] !== b[id].features[f.key]) out.push(`${b[id].name}: ${f.label} ${b[id].features[f.key] ? "added" : "removed"}`);
    }
  }
  return out;
}

export function PlansMatrixPage() {
  const { tenant, workspaces, isLoading, isError } = useCurrentTenant();
  const matrix = useTenantStore((s) => s.planMatrix);
  const published = useTenantStore((s) => s.publishedMatrix);
  const publishedAt = useTenantStore((s) => s.publishedAt);
  const setPlanPrice = useTenantStore((s) => s.setPlanPrice);
  const setPlanFeature = useTenantStore((s) => s.setPlanFeature);
  const resetPlans = useTenantStore((s) => s.resetPlans);
  const publishPlans = useTenantStore((s) => s.publishPlans);
  const [open, setOpen] = React.useState(false);

  if (isError) return <ErrorState />;
  if (isLoading || !tenant) return <TableSkeleton rows={8} cols={4} />;

  if (!tenant.whiteLabel) {
    return (
      <WhiteLabelGate
        title="Your own plans and prices need white-label"
        description="Your traders buy Nasscord's public plans (Starter, Pro and Desk) and you earn commission on them. Setting your own prices is part of white-label."
      />
    );
  }

  const changes = diffMatrix(published, matrix);
  const seats = workspaces.reduce((s, w) => s + w.seats, 0) || Object.values(SEAT_MIX).reduce((s, n) => s + n, 0);
  const billed = PLAN_IDS.reduce((s, id) => s + matrix[id].monthly * SEAT_MIX[id], 0);
  const invoice = PROGRAM.platformFee + seats * PROGRAM.perSeat;
  const keep = billed - invoice;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>{tenant.name} plans</CardTitle>
          <CardDescription>What your traders can buy. Prices are per seat per month. Changes go live for new signups when you publish; existing seats move at their next renewal.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-lg ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="min-w-44 text-xs tracking-wide text-muted-foreground uppercase">Feature</TableHead>
                  {PLAN_IDS.map((id) => (
                    <TableHead key={id} className="min-w-32 text-center text-xs tracking-wide text-muted-foreground uppercase">
                      {matrix[id].name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-medium">Monthly price</TableCell>
                  {PLAN_IDS.map((id) => (
                    <TableCell key={id} className="text-center">
                      <div className="relative mx-auto w-28">
                        <span aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">
                          $
                        </span>
                        <Input
                          type="number"
                          min={0}
                          max={5000}
                          step={1}
                          inputMode="numeric"
                          aria-label={`${matrix[id].name} monthly price`}
                          className="pl-6 text-right tabular"
                          value={matrix[id].monthly}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n) && n >= 0) setPlanPrice(id, Math.min(5000, Math.round(n)));
                          }}
                        />
                      </div>
                    </TableCell>
                  ))}
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Seats</TableCell>
                  {PLAN_IDS.map((id) => (
                    <TableCell key={id} className="text-center text-sm text-muted-foreground">
                      {matrix[id].seats}
                    </TableCell>
                  ))}
                </TableRow>
                <TableRow>
                  <TableCell className="font-medium">Brokers</TableCell>
                  {PLAN_IDS.map((id) => (
                    <TableCell key={id} className="text-center text-sm text-muted-foreground">
                      {id === "basic" ? "1 connection" : "Unlimited"}
                    </TableCell>
                  ))}
                </TableRow>
                {PLAN_FEATURES.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">{f.label}</span>
                        <span className="text-xs text-muted-foreground">{f.help}</span>
                      </div>
                    </TableCell>
                    {PLAN_IDS.map((id) => (
                      <TableCell key={id} className="text-center">
                        <Switch checked={matrix[id].features[f.key]} aria-label={`${f.label} on ${matrix[id].name}`} onCheckedChange={(on) => setPlanFeature(id, f.key, on)} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger render={<Button disabled={changes.length === 0} />}>Publish</DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Publish plan changes</DialogTitle>
                  <DialogDescription>New signups see these prices immediately. Existing seats keep their price until the next renewal and receive an email 30 days ahead.</DialogDescription>
                </DialogHeader>
                <ul className="grid gap-1.5 text-sm">
                  {changes.map((c) => (
                    <li key={c} className="flex gap-2">
                      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                      {c}
                    </li>
                  ))}
                </ul>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" />}>Keep editing</DialogClose>
                  <Button
                    onClick={() => {
                      publishPlans();
                      setOpen(false);
                      toast.success("Plans published", { description: `${changes.length} change${changes.length === 1 ? "" : "s"} live for new signups. Renewal notices go out tonight.` });
                    }}
                  >
                    Publish {changes.length} change{changes.length === 1 ? "" : "s"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button
              variant="ghost"
              disabled={changes.length === 0}
              onClick={() => {
                resetPlans();
                toast("Changes discarded", { description: "Back to the published matrix." });
              }}
            >
              Discard changes
            </Button>
            <span className="text-xs text-muted-foreground">
              {changes.length === 0 ? `Published ${publishedAt ? fmtDate(publishedAt) : "recently"}, no unsaved changes` : `${changes.length} unpublished change${changes.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="self-start">
        <CardHeader>
          <CardTitle>Revenue split</CardTitle>
          <CardDescription>Nasscord charges a platform fee plus a per-seat fee. Everything above that is yours.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <KV
            items={[
              ...PLAN_IDS.map((id) => ({
                label: `${matrix[id].name} · ${fmtNum(SEAT_MIX[id])} seats`,
                value: fmtMoney(matrix[id].monthly * SEAT_MIX[id], { digits: 0 }),
              })),
              { label: "You bill per month", value: <span className="font-semibold">{fmtMoney(billed, { digits: 0 })}</span> },
              { label: "Platform fee", value: fmtMoney(PROGRAM.platformFee, { digits: 0 }) },
              { label: `Seats · ${fmtNum(seats)} x ${fmtMoney(PROGRAM.perSeat, { digits: 0 })}`, value: fmtMoney(seats * PROGRAM.perSeat, { digits: 0 }) },
              { label: "You keep", value: <span className={keep >= 0 ? "text-gain-foreground" : "text-loss-foreground"}>{fmtMoney(keep, { digits: 0 })}</span> },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Seat mix reflects today&apos;s active seats across your trader workspaces. Nasscord bills you on the 1st; you can bill your traders through Nasscord Checkout or your own invoicing.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
