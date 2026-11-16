import { Check, Minus } from "lucide-react";
import { BROKERS } from "@/lib/brokers";
import type { Broker } from "@/lib/types";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type CellValue = boolean | string;

/** A broker as the public pages pass it: with `paperToday` when the broker service was asked (PublicBroker). */
type MatrixBroker = Broker & { paperToday?: boolean };

/** It connects for everyone today (any status but "soon"). */
const connects = (b: MatrixBroker) => b.status !== "soon";

/**
 * What a connection does in this release. The read-only views come with every broker that connects today
 * (its `status`, which the brokers page takes from the broker service), order entry follows
 * `capabilities.trading` (off for every broker), paper follows what connects today.
 */
const CAPS: Array<{ key: string; label: string; value: (b: MatrixBroker) => CellValue }> = [
  { key: "balances", label: "Accounts and balances", value: connects },
  { key: "positions", label: "Positions", value: connects },
  { key: "orders", label: "Orders and executions", value: connects },
  { key: "entry", label: "Order entry", value: (b) => (b.capabilities.trading ? true : connects(b) ? "Off in this release" : false) },
  { key: "paper", label: "Paper login", value: (b) => connects(b) && (b.paperToday ?? b.capabilities.paper) },
];

function Mark({ value, broker, cap }: { value: CellValue; broker: string; cap: string }) {
  if (typeof value === "string") return <span className="text-xs text-muted-foreground">{value}</span>;
  return (
    <span className="inline-flex items-center justify-center">
      {value ? <Check aria-hidden="true" className="size-4 text-site-accent-ink" /> : <Minus aria-hidden="true" className="size-4 text-muted-foreground/60" />}
      <span className="sr-only">
        {cap} {value ? "available" : "not available"} at {broker}
      </span>
    </span>
  );
}

/** Capability matrix from the registry, with each broker's status for everyone today. */
export function CapabilityMatrix({ brokers = BROKERS, className }: { brokers?: MatrixBroker[]; className?: string }) {
  return (
    <div className={cn("overflow-x-auto border-t border-b border-foreground", className)}>
      <Table className="min-w-[48rem]">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="site-caption text-muted-foreground">Broker</TableHead>
            <TableHead className="site-caption text-muted-foreground">Status</TableHead>
            {CAPS.map((c) => (
              <TableHead key={c.key} className="text-center site-caption text-muted-foreground">
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {brokers.map((b) => (
            <TableRow key={b.id} className="transition-colors hover:bg-site-band/60">
              <TableCell>
                <span className="inline-flex items-center gap-2.5">
                  <BrokerMark id={b.id} size="sm" />
                  <span className="font-medium">{b.name}</span>
                </span>
              </TableCell>
              <TableCell>
                <BrokerStatusBadge status={b.status} />
              </TableCell>
              {CAPS.map((c) => (
                <TableCell key={c.key} className="text-center">
                  <Mark value={c.value(b)} broker={b.name} cap={c.label} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
