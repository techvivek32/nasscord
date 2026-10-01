import { Check, Minus } from "lucide-react";
import { BROKERS } from "@/lib/brokers";
import type { Broker } from "@/lib/types";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const CAPS: Array<{ key: keyof Broker["capabilities"]; label: string }> = [
  { key: "trading", label: "Trading" },
  { key: "options", label: "Options" },
  { key: "extendedHours", label: "Extended hours" },
  { key: "paper", label: "Paper" },
];

function Mark({ on, broker, cap }: { on: boolean; broker: string; cap: string }) {
  return (
    <span className="inline-flex items-center justify-center">
      {on ? <Check aria-hidden="true" className="size-4 text-site-accent-ink" /> : <Minus aria-hidden="true" className="size-4 text-muted-foreground/60" />}
      <span className="sr-only">
        {cap} {on ? "supported" : "not supported"} at {broker}
      </span>
    </span>
  );
}

/** Capability matrix straight from the registry. */
export function CapabilityMatrix({ brokers = BROKERS, className }: { brokers?: Broker[]; className?: string }) {
  return (
    <div className={cn("overflow-x-auto border-t border-b border-foreground", className)}>
      <Table className="min-w-[40rem]">
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
                  <Mark on={b.capabilities[c.key]} broker={b.name} cap={c.label} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
