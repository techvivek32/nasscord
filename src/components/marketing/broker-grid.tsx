import { BROKER_STATUS } from "@/lib/brokers";
import type { Broker, BrokerStatus } from "@/lib/types";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/** Brokers as a ruled grid of cells: monogram, name, status, one line on what the connection does. */
export function BrokerGrid({ brokers, className, compact = false }: { brokers: Broker[]; className?: string; compact?: boolean }) {
  return (
    <ul className={cn("grid border-t border-l border-border sm:grid-cols-2 lg:grid-cols-3", !compact && "xl:grid-cols-4", className)}>
      {brokers.map((b, i) => (
        <li key={b.id} className="group/broker grid content-start gap-4 border-r border-b border-border p-5 transition-colors duration-300 hover:bg-site-band/60" {...reveal((i % 4) * 60)}>
          <div className="flex items-start justify-between gap-3">
            <BrokerMark id={b.id} size="md" className="rounded-[9px] transition-transform duration-500 group-hover/broker:-rotate-6" />
            <BrokerStatusBadge status={b.status} className="rounded-[2px] font-mono text-[0.65rem] tracking-wide uppercase" />
          </div>
          <div className="grid gap-1.5">
            <span className="font-serif text-2xl leading-tight">{b.name}</span>
            <p className={cn("text-sm leading-relaxed text-muted-foreground", compact && "line-clamp-3")}>{b.blurb}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

const ORDER: BrokerStatus[] = ["live", "beta", "sync", "soon"];

/** Status legend built from BROKER_STATUS so labels never drift from the badges. */
export function BrokerLegend({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-4 text-sm", className)}>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {ORDER.map((s) => (
          <div key={s} className="flex items-start gap-3">
            <dt className="shrink-0 pt-px">
              <BrokerStatusBadge status={s} className="rounded-[2px] font-mono text-[0.65rem] tracking-wide uppercase" />
            </dt>
            <dd className="text-muted-foreground">{BROKER_STATUS[s].description}</dd>
          </div>
        ))}
      </dl>
      <p className="max-w-[44rem] text-sm text-muted-foreground">
        Fidelity and Robinhood publish no trading API, so Nasscord syncs their positions and balances read-only through a licensed aggregator.
        Orders for those accounts still go through the broker&apos;s own app.
      </p>
    </div>
  );
}
