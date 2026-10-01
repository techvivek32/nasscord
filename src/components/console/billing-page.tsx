"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useInvoices } from "@/hooks/queries";
import { fmtDate, fmtMoney } from "@/lib/format";
import { PLANS } from "@/lib/plans";
import type { Invoice, PlanId } from "@/lib/types";
import { InvoiceStatusBadge } from "./badges";
import { SUPER_ADMIN_EMAIL } from "./lib";
import { TableSkeleton } from "./primitives";
import { type PlanMatrix, type PlanMatrixRow, useConsoleStore } from "./store";

const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";
const PLAN_IDS = PLANS.map((p) => p.id);

type PriceKey = "monthly" | "yearly";
type TextKey = "brokers" | "seats";
type BoolKey = "realtimeAlerts" | "orderEngine" | "optionsDesk" | "whiteLabel" | "prioritySupport";

const PRICE_ROWS: Array<{ key: PriceKey; label: string; help: string }> = [
  { key: "monthly", label: "Monthly price", help: "USD per month, billed monthly." },
  { key: "yearly", label: "Yearly price", help: "USD per month, billed yearly." },
];
const TEXT_ROWS: Array<{ key: TextKey; label: string }> = [
  { key: "brokers", label: "Broker connections" },
  { key: "seats", label: "Seats" },
];
const BOOL_ROWS: Array<{ key: BoolKey; label: string }> = [
  { key: "realtimeAlerts", label: "Real-time alerts" },
  { key: "orderEngine", label: "Order engine" },
  { key: "optionsDesk", label: "Options desk" },
  { key: "whiteLabel", label: "White-label" },
  { key: "prioritySupport", label: "Priority support" },
];

export function PlanMatrixCard() {
  const matrix = useConsoleStore((s) => s.planMatrix);
  const setMatrix = useConsoleStore((s) => s.setPlanMatrix);
  const save = useConsoleStore((s) => s.savePlanMatrix);
  const savedAt = useConsoleStore((s) => s.planMatrixSavedAt);
  const [dirty, setDirty] = React.useState(false);

  const update = (plan: PlanId, patch: Partial<PlanMatrixRow>) => {
    setMatrix((m: PlanMatrix) => ({ ...m, [plan]: { ...m[plan], ...patch } }));
    setDirty(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plan matrix</CardTitle>
        <CardDescription>Prices and entitlements per plan. Changes apply to new subscriptions; existing workspaces keep their price until renewal.</CardDescription>
        <CardAction>
          <Button
            size="sm"
            disabled={!dirty}
            onClick={() => {
              save();
              setDirty(false);
              toast.success("Plan matrix saved", { description: "Pricing page and checkout read the new values on next deploy." });
            }}
          >
            Save changes
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={`${TH} w-44`}>Entitlement</TableHead>
                {PLANS.map((p) => (
                  <TableHead key={p.id} className={`${TH} min-w-32`}>
                    {p.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PRICE_ROWS.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <span className="grid gap-0.5">
                      <span className="font-medium">{row.label}</span>
                      <span className="text-xs text-muted-foreground">{row.help}</span>
                    </span>
                  </TableCell>
                  {PLAN_IDS.map((pid) => {
                    const v = matrix[pid][row.key];
                    const id = `plan-${pid}-${row.key}`;
                    return (
                      <TableCell key={pid}>
                        {v === null ? (
                          <Input id={id} value="Custom" readOnly aria-label={`${PLANS.find((p) => p.id === pid)?.name} ${row.label}`} className="w-28 font-mono tabular text-muted-foreground" />
                        ) : (
                          <span className="relative inline-flex items-center">
                            <span className="pointer-events-none absolute left-2.5 text-sm text-muted-foreground">$</span>
                            <Input
                              id={id}
                              type="number"
                              inputMode="decimal"
                              min={0}
                              step={1}
                              value={v}
                              aria-label={`${PLANS.find((p) => p.id === pid)?.name} ${row.label}`}
                              className="w-28 pl-6 font-mono tabular"
                              onChange={(e) => {
                                const n = Number(e.target.value);
                                if (Number.isFinite(n) && n >= 0) update(pid, { [row.key]: n });
                              }}
                            />
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {TEXT_ROWS.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  {PLAN_IDS.map((pid) => (
                    <TableCell key={pid}>
                      <Input value={matrix[pid][row.key]} aria-label={`${PLANS.find((p) => p.id === pid)?.name} ${row.label}`} className="w-28 tabular" onChange={(e) => update(pid, { [row.key]: e.target.value })} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {BOOL_ROWS.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-medium">{row.label}</TableCell>
                  {PLAN_IDS.map((pid) => (
                    <TableCell key={pid}>
                      <Switch checked={matrix[pid][row.key]} aria-label={`${row.label} on ${PLANS.find((p) => p.id === pid)?.name}`} onCheckedChange={(on) => update(pid, { [row.key]: on })} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{savedAt ? `Last saved ${fmtDate(savedAt)} by ${SUPER_ADMIN_EMAIL}.` : "Not changed since deploy."}</p>
      </CardContent>
    </Card>
  );
}

const INVOICE_COLUMNS: ColumnDef<Invoice>[] = [
  { accessorKey: "id", header: "Invoice", cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span> },
  { accessorKey: "workspaceName", header: "Workspace", cell: ({ row }) => <span className="font-medium">{row.original.workspaceName}</span> },
  { accessorKey: "amount", header: "Amount", meta: { align: "right" }, cell: ({ row }) => <span className="font-medium tabular">{fmtMoney(row.original.amount, { digits: 0 })}</span> },
  { accessorKey: "status", header: "Status", cell: ({ row }) => <InvoiceStatusBadge status={row.original.status} /> },
  { accessorKey: "issuedAt", header: "Issued", cell: ({ row }) => <span className="text-muted-foreground">{fmtDate(row.original.issuedAt)}</span> },
  { accessorKey: "dueAt", header: "Due", cell: ({ row }) => <span className={row.original.status === "past_due" ? "text-loss-foreground" : "text-muted-foreground"}>{fmtDate(row.original.dueAt)}</span> },
  {
    id: "actions",
    header: "",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => {
      const inv = row.original;
      return (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${inv.id}`} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem disabled={inv.status === "paid" || inv.status === "void"} onClick={() => toast.success(`Reminder sent for ${inv.id}`, { description: `${inv.workspaceName} · ${fmtMoney(inv.amount, { digits: 0 })} due ${fmtDate(inv.dueAt)}` })}>
              Send reminder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => toast(`Downloading ${inv.id}.pdf`)}>Download PDF</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  },
];

export function InvoicesCard() {
  const invoices = useInvoices();
  const [syncing, setSyncing] = React.useState(false);

  const totals = React.useMemo(() => {
    const list = invoices.data ?? [];
    return {
      open: list.filter((i) => i.status === "open").reduce((s, i) => s + i.amount, 0),
      pastDue: list.filter((i) => i.status === "past_due").reduce((s, i) => s + i.amount, 0),
    };
  }, [invoices.data]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoices</CardTitle>
        <CardDescription>
          {invoices.data ? `${fmtMoney(totals.open, { digits: 0 })} open · ${fmtMoney(totals.pastDue, { digits: 0 })} past due` : "This month's invoices across all workspaces."}
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              setTimeout(() => {
                setSyncing(false);
                toast.success("Stripe sync complete · 0 changes");
              }, 900);
            }}
          >
            <RefreshCw data-icon="inline-start" className={syncing ? "animate-spin" : undefined} />
            {syncing ? "Syncing" : "Sync with Stripe"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {invoices.isLoading ? (
          <TableSkeleton rows={6} cols={7} />
        ) : (invoices.data ?? []).length === 0 ? (
          <EmptyState title="No invoices this cycle" description="Invoices are issued on each workspace's billing day." />
        ) : (
          <DataTable columns={INVOICE_COLUMNS} data={invoices.data ?? []} searchPlaceholder="Search invoice or workspace…" pageSize={10} />
        )}
      </CardContent>
    </Card>
  );
}
