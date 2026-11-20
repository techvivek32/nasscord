import { BROKER_STATUS } from "@/lib/brokers";
import type { PublicAvailability } from "@/lib/server/broker-availability";
import type { BrokerStatus } from "@/lib/types";
import { BrokerMark, BrokerStatusBadge } from "@/components/brokers/broker-mark";
import { PaperCard } from "@/components/marketing/container";
import { CountUp } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

/*
 * The broker statuses as everyone sees them right now (src/lib/server/broker-availability.ts), for the
 * public pages. Server components: the page reads the availability once and passes it down.
 */

const ORDER: BrokerStatus[] = ["live", "beta", "sync", "soon"];

const STATUS_DOT: Record<BrokerStatus, string> = {
  live: "bg-gain",
  beta: "bg-warn",
  sync: "bg-site-accent-soft",
  soon: "bg-muted-foreground/50",
};

/** Statuses that have brokers right now, in display order. */
export function statusesInUse(availability: PublicAvailability): BrokerStatus[] {
  return ORDER.filter((s) => availability.brokers.some((b) => b.status === s));
}

/** Broker count by status, with every monogram underneath (dimmed while it does not connect). */
export function AvailabilityCard({ availability, className }: { availability: PublicAvailability; className?: string }) {
  const { brokers } = availability;
  return (
    <PaperCard className={cn("px-5 pt-4 pb-5", className)}>
      <div className="site-caption flex items-center justify-between gap-4 border-b border-foreground pb-3">
        <span>Broker registry</span>
        <span className="text-muted-foreground">{brokers.length} brokers</span>
      </div>
      <dl>
        {statusesInUse(availability).map((s) => (
          <div key={s} className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm">
            <dt className="flex items-center gap-2.5">
              <span aria-hidden="true" className={cn("size-2.5", STATUS_DOT[s])} />
              {BROKER_STATUS[s].label}
            </dt>
            <dd className="font-mono tabular">
              <CountUp value={brokers.filter((b) => b.status === s).length} />
            </dd>
          </div>
        ))}
      </dl>
      <div aria-hidden="true" className="mt-4 flex flex-wrap gap-1.5">
        {brokers.map((b, i) => (
          <span key={b.id} className="animate-site-rise" style={{ "--d": `${500 + i * 45}ms` } as React.CSSProperties}>
            <BrokerMark id={b.id} size="sm" className={cn(b.status === "soon" && "opacity-50")} />
          </span>
        ))}
      </div>
      {availability.source === "service" ? (
        <p className="mt-4 font-mono text-[0.7rem] leading-relaxed text-muted-foreground">Checked against the broker service every few minutes.</p>
      ) : null}
    </PaperCard>
  );
}

/** The legend for the statuses in use, with the order entry note. */
export function AvailabilityLegend({ availability, className }: { availability: PublicAvailability; className?: string }) {
  return (
    <div className={cn("grid gap-4 text-sm", className)}>
      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
        {statusesInUse(availability).map((s) => (
          <div key={s} className="flex items-start gap-3">
            <dt className="shrink-0 pt-px">
              <BrokerStatusBadge status={s} className="rounded-[2px] font-mono text-[0.65rem] tracking-wide uppercase" />
            </dt>
            <dd className="text-muted-foreground">{BROKER_STATUS[s].description}</dd>
          </div>
        ))}
      </dl>
      <p className="max-w-[44rem] text-sm text-muted-foreground">
        Order entry works for IBKR, E*TRADE and Alpaca (API key) in workspaces where Nasscord switches it on; every other broker is read only, so you
        place those orders in the broker&apos;s own app. Nasscord shows what is there: accounts, balances, positions, orders and executions.
      </p>
    </div>
  );
}
