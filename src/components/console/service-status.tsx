import { StatusDot } from "@/components/status-dot";
import type { BrokerServiceStatus } from "@/lib/server/console";
import { fmtDateTime } from "@/lib/format";
import { fmtUptime } from "./lib";
import { KV } from "./primitives";

/* The broker service's own report (GET /health and, for the super admin, GET /v1/health), read defensively. */

export interface GatewaySlot {
  port: number;
  connectionId: string;
  ready: boolean;
  authenticated: boolean;
  competing: boolean;
  startedAt: string | null;
  expiredAt: string | null;
}

export interface ServiceReport {
  version: string | null;
  uptimeSec: number | null;
  running: number | null;
  slotsFree: number | null;
  slotsTotal: number | null;
  /** The IBKR gateway bundle was found on the service host. Null when the service did not say. */
  bundle: boolean | null;
  slots: GatewaySlot[];
  /** Connection counts by broker and DB status, as the service counts them. */
  connections: Record<string, Record<string, number>>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function readServiceReport(status: BrokerServiceStatus): ServiceReport {
  const detail = obj(status.detail) ?? {};
  const gateways = obj(detail.gateways) ?? {};
  const slots = Array.isArray(gateways.slots)
    ? gateways.slots.flatMap((raw): GatewaySlot[] => {
        const s = obj(raw);
        const port = num(s?.port);
        if (!s || port === null) return [];
        return [{ port, connectionId: str(s.connectionId) ?? "", ready: s.ready === true, authenticated: s.authenticated === true, competing: s.competing === true, startedAt: str(s.startedAt), expiredAt: str(s.expiredAt) }];
      })
    : [];
  const connections: Record<string, Record<string, number>> = {};
  for (const [broker, counts] of Object.entries(obj(detail.connections) ?? {})) {
    const c = obj(counts);
    if (!c) continue;
    connections[broker] = Object.fromEntries(Object.entries(c).flatMap(([k, v]) => (num(v) === null ? [] : [[k, v as number]])));
  }
  return {
    version: str(status.health?.version) ?? str(detail.version),
    uptimeSec: num(status.health?.uptimeSec) ?? num(detail.uptimeSec),
    running: num(gateways.running) ?? num(status.health?.gateways?.running),
    slotsFree: num(gateways.slotsFree) ?? num(status.health?.gateways?.slotsFree),
    slotsTotal: num(gateways.total),
    bundle: typeof gateways.bundle === "boolean" ? gateways.bundle : null,
    slots,
    connections,
  };
}

/** One line: answering or not, with the reason. */
export function ServiceStatusLine({ status }: { status: BrokerServiceStatus }) {
  if (!status.configured) return <StatusDot tone="neutral" label="Not set up" />;
  if (!status.reachable) return <StatusDot tone="bad" label="Not answering" />;
  return <StatusDot tone={status.health?.ok === false ? "warn" : "good"} label={status.health?.ok === false ? "Answering, reports a problem" : "Answering"} />;
}

/** Facts about the broker service: status, version, uptime and gateway slots. */
export function ServiceFacts({ status, checkedAt }: { status: BrokerServiceStatus; checkedAt: string }) {
  const r = readServiceReport(status);
  return (
    <div className="grid gap-3">
      <KV
        items={[
          { label: "Status", value: <ServiceStatusLine status={status} /> },
          ...(status.error ? [{ label: "Reason", value: <span className="font-normal text-muted-foreground">{status.error}</span> }] : []),
          ...(r.version ? [{ label: "Version", value: <span className="font-mono text-xs">{r.version}</span> }] : []),
          ...(r.uptimeSec !== null ? [{ label: "Uptime", value: fmtUptime(r.uptimeSec) }] : []),
          ...(r.running !== null ? [{ label: "IBKR gateways running", value: String(r.running) }] : []),
          ...(r.slotsFree !== null ? [{ label: "Gateway slots free", value: r.slotsTotal !== null ? `${r.slotsFree} of ${r.slotsTotal}` : String(r.slotsFree) }] : []),
          ...(r.bundle !== null ? [{ label: "IBKR gateway bundle", value: r.bundle ? "Found" : <span className="text-warn-foreground">Missing on the service host</span> }] : []),
          { label: "Checked", value: <span className="font-normal text-muted-foreground">{fmtDateTime(checkedAt)}</span> },
        ]}
      />
      {status.reachable && !status.detail ? <p className="text-xs text-muted-foreground">The service answered /health but not /v1/health, so per-broker counts and gateway slots are missing.</p> : null}
    </div>
  );
}
