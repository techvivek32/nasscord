"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { fmtDateTime, fmtNum } from "@/lib/format";
import type { BrokerId, BrokerRequest } from "@/lib/types";
import { ToneBadge } from "./badges";
import { fmtDay } from "./lib";
import type { GatewaySlot } from "./service-status";

/** One registry broker with its stored connections counted on the server. */
export interface BrokerRow {
  id: BrokerId;
  name: string;
  blurb: string;
  connectable: boolean;
  method: string;
  total: number;
  connected: number;
  expiring: number;
  pending: number;
  /** Expired or in error. */
  failing: number;
  disconnected: number;
  accounts: number;
}

const count = (n: number, tone?: "warn" | "bad") => <span className={`tabular ${n === 0 ? "text-muted-foreground" : tone === "bad" ? "text-loss-foreground" : tone === "warn" ? "text-warn-foreground" : ""}`}>{fmtNum(n)}</span>;

const REGISTRY_COLUMNS: ColumnDef<BrokerRow>[] = [
  {
    id: "name",
    accessorFn: (b) => b.name,
    header: "Broker",
    cell: ({ row }) => (
      <span className="flex items-center gap-2.5">
        <BrokerMark id={row.original.id} size="md" />
        <span className="grid gap-0.5">
          <span className="font-medium">{row.original.name}</span>
          <span className="max-w-64 truncate text-xs text-muted-foreground">{row.original.method}</span>
        </span>
      </span>
    ),
  },
  {
    id: "available",
    accessorFn: (b) => (b.connectable ? 1 : 0),
    header: "Availability",
    cell: ({ row }) => (row.original.connectable ? <ToneBadge tone="good">Connectable</ToneBadge> : <ToneBadge tone="neutral">Not available yet</ToneBadge>),
  },
  { accessorKey: "total", header: "Connections", meta: { align: "right" }, cell: ({ row }) => count(row.original.total) },
  { accessorKey: "connected", header: "Connected", meta: { align: "right" }, cell: ({ row }) => count(row.original.connected) },
  { accessorKey: "expiring", header: "Expiring", meta: { align: "right" }, cell: ({ row }) => count(row.original.expiring, "warn") },
  { accessorKey: "pending", header: "Waiting for login", meta: { align: "right" }, cell: ({ row }) => count(row.original.pending) },
  { accessorKey: "failing", header: "Expired or error", meta: { align: "right" }, cell: ({ row }) => count(row.original.failing, "bad") },
  { accessorKey: "accounts", header: "Accounts", meta: { align: "right" }, cell: ({ row }) => count(row.original.accounts) },
];

export function BrokerRegistryTable({ rows }: { rows: BrokerRow[] }) {
  return <DataTable columns={REGISTRY_COLUMNS} data={rows} searchable={false} pageSize={20} />;
}

const REQUEST_COLUMNS: ColumnDef<BrokerRequest>[] = [
  { accessorKey: "brokerName", header: "Broker asked for", cell: ({ row }) => <span className="font-medium">{row.original.brokerName}</span> },
  { accessorKey: "email", header: "From", cell: ({ row }) => <span className="font-mono text-xs">{row.original.email}</span> },
  { accessorKey: "createdAt", header: "Sent", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.createdAt)}</span> },
];

export function BrokerRequestsTable({ requests }: { requests: BrokerRequest[] }) {
  if (requests.length === 0) return <EmptyState title="No broker requests yet" description="Requests sent from the public brokers page appear here." />;
  return <DataTable columns={REQUEST_COLUMNS} data={requests} searchPlaceholder="Search broker or email…" pageSize={10} />;
}

const SLOT_COLUMNS: ColumnDef<GatewaySlot>[] = [
  { accessorKey: "port", header: "Port", cell: ({ row }) => <span className="font-mono text-xs tabular">{row.original.port}</span> },
  { accessorKey: "connectionId", header: "Connection", cell: ({ row }) => <span className="font-mono text-[11px] text-muted-foreground">{row.original.connectionId}</span> },
  {
    id: "state",
    accessorFn: (s) => (s.authenticated ? 2 : s.ready ? 1 : 0),
    header: "State",
    cell: ({ row }) => {
      const s = row.original;
      if (s.competing) return <ToneBadge tone="warn">Competing session</ToneBadge>;
      if (s.authenticated) return <ToneBadge tone="good">Signed in</ToneBadge>;
      if (s.ready) return <ToneBadge tone="brand">Waiting for login</ToneBadge>;
      return <ToneBadge tone="neutral">Starting</ToneBadge>;
    },
  },
  { accessorKey: "startedAt", header: "Started", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{row.original.startedAt ? fmtDateTime(row.original.startedAt) : ""}</span> },
];

export function GatewaySlotsTable({ slots }: { slots: GatewaySlot[] }) {
  if (slots.length === 0) return <EmptyState title="No IBKR gateways running" description="A gateway starts when a trader connects IBKR and stops when they disconnect or the session ends." />;
  return <DataTable columns={SLOT_COLUMNS} data={slots} searchable={false} pageSize={10} />;
}
