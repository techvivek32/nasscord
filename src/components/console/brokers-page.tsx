"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { CallbackUrl } from "@/components/brokers/connect/callback-url";
import { REACH_RANK, type BrokerReach } from "@/lib/console-brokers";
import { fmtDateTime, fmtNum } from "@/lib/format";
import type { BrokerId, BrokerRequest, ConnectAudience, ConnectReasonCode } from "@/lib/types";
import { ToneBadge } from "./badges";
import { fmtDay, type Tone } from "./lib";
import type { GatewaySlot } from "./service-status";

/**
 * Who may connect a broker right now, from the broker service's own answer (GET /v1/options):
 * everyone, only the super admin, built but missing a setting, closed (off or not built), or unknown
 * when the service did not answer. Worked out by reachOf in src/lib/console-brokers.ts.
 */
export type { BrokerReach };

/** Label and tone of each reach. The sort rank is REACH_RANK, shared with the server page. */
const REACH: Record<BrokerReach, { label: string; tone: Tone }> = {
  everyone: { label: "Everyone", tone: "good" },
  owner: { label: "Only you", tone: "brand" },
  setup: { label: "Not set up", tone: "warn" },
  closed: { label: "Not available yet", tone: "neutral" },
  unknown: { label: "Unknown", tone: "neutral" },
};

/** One registry broker with its stored connections counted on the server. */
export interface BrokerRow {
  id: BrokerId;
  name: string;
  /** Its ways of connecting, in words ("SnapTrade · Schwab Trader API (OAuth)"). */
  ways: string;
  reach: BrokerReach;
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
          <span className="max-w-72 truncate text-xs text-muted-foreground" title={row.original.ways}>
            {row.original.ways}
          </span>
        </span>
      </span>
    ),
  },
  {
    id: "reach",
    accessorFn: (b) => REACH_RANK[b.reach],
    header: "Open to",
    cell: ({ row }) => <ToneBadge tone={REACH[row.original.reach].tone}>{REACH[row.original.reach].label}</ToneBadge>,
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

/* ---------------------------------------------------------------- ways of connecting */

/** One way of connecting a broker, as the broker service answers it for the super admin. */
export interface ConnectOptionRow {
  key: string;
  brokerId: BrokerId;
  brokerName: string;
  /** The spec's title ("Connect with your Alpaca API key"). */
  way: string;
  /** The method in words ("Alpaca API key"), plus whose app for OAuth. */
  method: string;
  /** The BROKER_AUDIENCE gate key ("schwab_oauth.user"). */
  gateKey: string;
  audience: ConnectAudience;
  available: boolean;
  reasonCode: ConnectReasonCode | null;
  /** The service's sentence; for the super admin it names the missing setting. */
  reason: string | null;
  environments: string[];
}

const AUDIENCE: Record<ConnectAudience, { label: string; tone: Tone }> = {
  all: { label: "Everyone", tone: "good" },
  superadmin: { label: "Only you", tone: "brand" },
  off: { label: "Off", tone: "neutral" },
};

const STATE: Record<ConnectReasonCode | "ready", { label: string; tone: Tone }> = {
  ready: { label: "Ready", tone: "good" },
  not_built: { label: "Not built", tone: "neutral" },
  not_configured: { label: "Not set up", tone: "warn" },
  off: { label: "Switched off", tone: "neutral" },
  owner_only: { label: "Only you", tone: "brand" },
  no_environment: { label: "No environment", tone: "warn" },
};

const stateOf = (o: ConnectOptionRow) => (o.available ? "ready" : (o.reasonCode ?? "not_built"));

const OPTION_COLUMNS: ColumnDef<ConnectOptionRow>[] = [
  {
    id: "broker",
    accessorFn: (o) => o.brokerName,
    header: "Broker",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <BrokerMark id={row.original.brokerId} size="sm" />
        <span className="font-medium">{row.original.brokerName}</span>
      </span>
    ),
  },
  {
    id: "way",
    accessorFn: (o) => `${o.way} ${o.method} ${o.gateKey}`,
    header: "Way",
    cell: ({ row }) => (
      <span className="grid gap-0.5">
        <span className="max-w-72 whitespace-normal">{row.original.way}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{row.original.gateKey}</span>
      </span>
    ),
  },
  {
    id: "audience",
    accessorFn: (o) => o.audience,
    header: "BROKER_AUDIENCE",
    cell: ({ row }) => <ToneBadge tone={AUDIENCE[row.original.audience]?.tone ?? "neutral"}>{AUDIENCE[row.original.audience]?.label ?? row.original.audience}</ToneBadge>,
  },
  {
    id: "state",
    accessorFn: (o) => stateOf(o),
    header: "State",
    cell: ({ row }) => {
      const s = STATE[stateOf(row.original)];
      return (
        <span className="grid gap-1">
          <ToneBadge tone={s.tone}>{s.label}</ToneBadge>
          {!row.original.available && row.original.reason ? <span className="max-w-72 text-xs whitespace-normal text-muted-foreground">{row.original.reason}</span> : null}
        </span>
      );
    },
  },
  {
    id: "environments",
    accessorFn: (o) => o.environments.join(", "),
    header: "Environments",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.environments.length ? row.original.environments.join(", ") : "None"}</span>,
  },
];

export function ConnectOptionsTable({ rows }: { rows: ConnectOptionRow[] }) {
  if (rows.length === 0) return <EmptyState title="No answer from the broker service" description="The ways of connecting are listed once the broker service answers GET /v1/options." />;
  return <DataTable columns={OPTION_COLUMNS} data={rows} searchPlaceholder="Search broker or way…" pageSize={25} />;
}

/** The callback URLs to register with each broker, one per OAuth broker plus SnapTrade's. */
export function CallbackUrlList({ items }: { items: Array<{ url: string; label: string }> }) {
  if (items.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {items.map((i) => (
        <CallbackUrl key={i.url} url={i.url} label={i.label} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- requests and gateways */

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
