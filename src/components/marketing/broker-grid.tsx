import { BROKER_STATUS } from "@/lib/brokers";
import type { Broker, BrokerStatus } from "@/lib/types";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Grid of broker tiles. Pass any subset of the registry. */
export function BrokerGrid({ brokers, className, compact = false }: { brokers: Broker[]; className?: string; compact?: boolean }) {
  return (
    <ul className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", !compact && "xl:grid-cols-4", className)}>
      {brokers.map((b) => (
        <li key={b.id}>
          <Card size="sm" className="h-full gap-3">
            <div className="flex items-start gap-3 px-3">
              <BrokerMark id={b.id} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-heading text-sm font-semibold">{b.name}</span>
                  <BrokerStatusBadge status={b.status} />
                </div>
                <p className={cn("mt-1 text-xs leading-relaxed text-muted-foreground", compact && "line-clamp-2")}>{b.blurb}</p>
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

const ORDER: BrokerStatus[] = ["live", "beta", "sync", "soon"];

/** Status legend built from BROKER_STATUS so labels never drift from the badges. */
export function BrokerLegend({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-3 text-sm", className)}>
      <dl className="grid gap-2 sm:grid-cols-2">
        {ORDER.map((s) => (
          <div key={s} className="flex items-start gap-3">
            <dt className="shrink-0 pt-px">
              <BrokerStatusBadge status={s} />
            </dt>
            <dd className="text-muted-foreground">{BROKER_STATUS[s].description}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm text-muted-foreground">
        Fidelity and Robinhood publish no trading API, so Nasscord syncs their positions and balances read-only through a licensed aggregator.
        Orders for those accounts still go through the broker&apos;s own app.
      </p>
    </div>
  );
}
