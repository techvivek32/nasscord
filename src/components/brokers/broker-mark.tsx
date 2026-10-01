import { getBroker, BROKER_STATUS } from "@/lib/brokers";
import type { BrokerId, BrokerStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** Monogram tile. The registry color is the only hardcoded color in the UI. */
export function BrokerMark({ id, size = "md", className }: { id: BrokerId; size?: "xs" | "sm" | "md" | "lg"; className?: string }) {
  const b = getBroker(id);
  const dims = { xs: "size-5 text-[8px] rounded", sm: "size-6 text-[9px] rounded-md", md: "size-9 text-xs rounded-lg", lg: "size-12 text-sm rounded-xl" }[size];
  return (
    <span
      aria-label={b.name}
      title={b.name}
      className={cn("inline-grid shrink-0 place-items-center font-heading font-bold tracking-tight text-white", dims, className)}
      style={{ background: b.color }}
    >
      {b.monogram}
    </span>
  );
}

/** Row of small monograms, for tenant tables. */
export function BrokerMarks({ ids, max = 4, className }: { ids: BrokerId[]; max?: number; className?: string }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {shown.map((id) => (
        <BrokerMark key={id} id={id} size="sm" />
      ))}
      {rest > 0 ? <span className="text-xs text-muted-foreground">+{rest}</span> : null}
    </span>
  );
}

const STATUS_CLASS: Record<BrokerStatus, string> = {
  live: "bg-gain-soft text-gain-foreground",
  beta: "bg-warn-soft text-warn-foreground",
  sync: "bg-brand-soft text-primary",
  soon: "bg-muted text-muted-foreground",
};

export function BrokerStatusBadge({ status, className }: { status: BrokerStatus; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(STATUS_CLASS[status], className)}>
      {BROKER_STATUS[status].label}
    </Badge>
  );
}
