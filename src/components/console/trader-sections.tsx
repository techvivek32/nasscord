"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { OrderRequestStatusBadge, SideBadge } from "@/components/terminal/badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { setWorkspaceOrderEntry, setWorkspaceStatus } from "@/lib/server/console-actions";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { ORDER_TYPE_LABEL } from "@/lib/order-entry";
import type { ConsoleOrderRow, OrderEntryState, Workspace, WorkspaceStatus } from "@/lib/types";
import { attempt, WORKSPACE_STATUS, WORKSPACE_STATUSES } from "./lib";

const STATUS_ITEMS = WORKSPACE_STATUSES.map((s) => ({ value: s, label: WORKSPACE_STATUS[s].label }));

/**
 * Status of one workspace. Picking a new value asks for confirmation, then saves through the console
 * server action (which audits the change). The page re-renders with the stored value.
 */
export function WorkspaceControls({ workspace }: { workspace: Pick<Workspace, "id" | "name" | "status"> }) {
  const [pending, setPending] = React.useState<WorkspaceStatus | null>(null);
  const [saving, startSaving] = React.useTransition();
  const id = React.useId();

  function confirm() {
    if (!pending) return;
    const next = pending;
    startSaving(async () => {
      const r = await attempt(() => setWorkspaceStatus(workspace.id, next));
      if (r.ok) {
        toast.success(`${workspace.name} is ${WORKSPACE_STATUS[next].label.toLowerCase()}`);
        setPending(null);
      } else {
        toast.error(r.error);
      }
    });
  }

  return (
    <div className="grid gap-4 sm:max-w-sm">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-status`}>Status</Label>
        <Select items={STATUS_ITEMS} value={workspace.status} onValueChange={(v) => v && v !== workspace.status && setPending(v as WorkspaceStatus)}>
          <SelectTrigger id={`${id}-status`} className="w-full" disabled={saving}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_ITEMS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Stored on the workspace and shown across the console.</p>
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && !saving && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending ? `Mark ${workspace.name} as ${WORKSPACE_STATUS[pending].label.toLowerCase()}?` : ""}</DialogTitle>
            <DialogDescription>
              The new status is stored on the workspace and written to the audit log. Members can still sign in, but a suspended workspace cannot place orders from Nasscord.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant={pending === "suspended" ? "destructive" : "default"} disabled={saving} onClick={confirm}>
              {saving ? "Saving" : "Change status"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The order entry switch of one workspace. Changing it asks first, then saves through the console server action
 * (which audits the change); the page re-renders with the stored value.
 */
export function OrderEntrySwitch({ workspace, state }: { workspace: Pick<Workspace, "id" | "name" | "status">; state: OrderEntryState }) {
  const [pending, setPending] = React.useState<boolean | null>(null);
  const [saving, startSaving] = React.useTransition();
  const id = React.useId();
  const name = workspace.name;

  function confirm() {
    if (pending === null) return;
    const enabled = pending;
    startSaving(async () => {
      const r = await attempt(() => setWorkspaceOrderEntry(workspace.id, enabled));
      if (r.ok) {
        toast.success(enabled ? `Order entry is on for ${name}` : `Order entry is off for ${name}`);
        setPending(null);
      } else {
        toast.error(r.error);
      }
    });
  }

  let line: React.ReactNode;
  if (!state.migrated) line = "Run supabase/migrations/20261121120000_order_entry.sql to use this switch.";
  else if (state.enabled && workspace.status === "suspended") line = "On, but the workspace is suspended, so it cannot place orders.";
  else if (state.enabled) {
    line = state.updatedAt ? `On since ${fmtDateTime(state.updatedAt)}${state.updatedByEmail ? ` by ${state.updatedByEmail}` : ""}.` : "On.";
  } else {
    const requested = state.requestedAt ? ` Requested ${fmtDateTime(state.requestedAt)}${state.requestedByEmail ? ` by ${state.requestedByEmail}` : ""}.` : "";
    line = `Off. Members see the terminal read only.${requested}`;
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3">
        <Switch
          id={`${id}-orders`}
          checked={state.enabled}
          disabled={saving || !state.migrated}
          onCheckedChange={(checked) => {
            if (checked !== state.enabled) setPending(checked);
          }}
        />
        <Label htmlFor={`${id}-orders`}>Order entry</Label>
      </div>
      <p className="text-xs text-muted-foreground">{line}</p>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && !saving && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending ? `Turn order entry on for ${name}?` : `Turn order entry off for ${name}?`}</DialogTitle>
            <DialogDescription>
              {pending
                ? `Members of ${name} can then preview and place orders, and cancel working orders, at their connected IBKR, E*TRADE and Alpaca (API key) accounts. Every order is confirmed by the member before it is sent. Other brokers stay read only.`
                : "The broker service refuses new orders and cancel requests from this workspace at once, and the terminal stops showing order buttons within a minute. Orders already working at a broker stay working: members cancel them in the broker's own app."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button variant={pending ? "default" : "destructive"} disabled={saving} onClick={confirm}>
              {saving ? "Saving" : pending ? "Turn on" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** An unconfirmed order nobody marked as checked: listed first. */
const isOpenUnknown = (r: ConsoleOrderRow) => r.status === "unknown" && !r.resolvedAt;

const ORDER_COLUMNS: ColumnDef<ConsoleOrderRow>[] = [
  {
    id: "time",
    accessorFn: (r) => r.sentAt ?? r.createdAt,
    header: "Time",
    cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground tabular">{fmtDateTime(row.original.sentAt ?? row.original.createdAt)}</span>,
  },
  {
    id: "member",
    accessorFn: (r) => r.userEmail ?? "",
    header: "Member",
    cell: ({ row }) => (row.original.userEmail ? <span className="font-mono text-xs">{row.original.userEmail}</span> : <span className="text-xs text-muted-foreground">Unknown</span>),
  },
  {
    id: "account",
    accessorFn: (r) => `${r.brokerId} ${r.accountDisplay} ${r.environment === "paper" ? "Paper" : "Live"}`,
    header: "Account",
    cell: ({ row }) => (
      <span className="flex items-center gap-2 whitespace-nowrap">
        <BrokerMark id={row.original.brokerId} size="xs" />
        <span className="font-mono text-xs tabular">{row.original.accountDisplay}</span>
        <Badge variant="outline">{row.original.environment === "paper" ? "Paper" : "Live"}</Badge>
      </span>
    ),
  },
  { id: "side", accessorFn: (r) => r.side, header: "Side", cell: ({ row }) => <SideBadge side={row.original.side} /> },
  {
    id: "order",
    accessorFn: (r) => `${r.quantity} ${r.symbol}`,
    header: "Order",
    cell: ({ row }) => (
      <span className="font-mono whitespace-nowrap tabular">
        {fmtNum(row.original.quantity)} {row.original.symbol}
      </span>
    ),
  },
  {
    id: "type",
    accessorFn: (r) => ORDER_TYPE_LABEL[r.orderType],
    header: "Type",
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground">
        {ORDER_TYPE_LABEL[row.original.orderType]}
        {row.original.bracket ? ", bracket" : ""}
      </span>
    ),
  },
  {
    id: "status",
    accessorFn: (r) => r.status,
    header: "Status",
    cell: ({ row }) => (
      <span className="grid justify-items-start gap-1">
        <OrderRequestStatusBadge status={row.original.status} />
        {row.original.resolvedAt ? <span className="text-xs whitespace-nowrap text-muted-foreground">Checked {fmtDateTime(row.original.resolvedAt)}</span> : null}
      </span>
    ),
  },
  {
    id: "brokerOrder",
    accessorFn: (r) => r.brokerOrderId ?? "",
    header: "Broker order",
    cell: ({ row }) => (row.original.brokerOrderId ? <span className="font-mono text-xs">{row.original.brokerOrderId}</span> : null),
  },
];

/** Orders previewed and sent from Nasscord in one workspace: unconfirmed ones nobody checked first, then newest first. */
export function NasscordOrdersCard({ rows }: { rows: ConsoleOrderRow[] }) {
  const sorted = React.useMemo(
    () =>
      [...rows].sort((a, b) => {
        const open = Number(isOpenUnknown(b)) - Number(isOpenUnknown(a));
        if (open) return open;
        return Date.parse(b.sentAt ?? b.createdAt) - Date.parse(a.sentAt ?? a.createdAt);
      }),
    [rows],
  );
  if (rows.length === 0) return <EmptyState title="No orders from this workspace yet." description="Orders its members preview or send from the terminal show up here." />;
  return <DataTable columns={ORDER_COLUMNS} data={sorted} searchPlaceholder="Search orders, members, symbols…" pageSize={10} emptyMessage="No orders match." />;
}
