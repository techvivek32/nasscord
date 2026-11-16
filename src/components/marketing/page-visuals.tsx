import { PaperCard } from "@/components/marketing/container";
import { CountUp } from "@/components/marketing/reveal";
import { cn } from "@/lib/utils";

/* Cards for the inner-page heroes, shown on a dot-grid panel. Each page states the same facts in text. */

function CardHead({ left, right }: { left: string; right: string }) {
  return (
    <div className="site-caption flex items-center justify-between gap-4 border-b border-foreground pb-3">
      <span>{left}</span>
      <span className="text-muted-foreground">{right}</span>
    </div>
  );
}

/** The commission share as one large figure, with the terms underneath. */
export function CommissionCard({ pct, notes, className }: { pct: number; notes: string[]; className?: string }) {
  return (
    <PaperCard className={cn("px-5 pt-4 pb-2", className)}>
      <CardHead left="Tenant commission" right="Program terms" />
      <div className="flex items-end justify-between gap-4 border-b border-border py-5">
        <CountUp value={pct} suffix="%" className="text-8xl leading-[0.8] tracking-[-0.05em] tabular" />
        <span className="pb-1 text-right font-serif text-2xl leading-tight italic">
          of every
          <br />
          subscription
        </span>
      </div>
      <ul>
        {notes.map((n) => (
          <li key={n} className="border-b border-border py-2.5 text-sm last:border-b-0">
            {n}
          </li>
        ))}
      </ul>
    </PaperCard>
  );
}

/** The path a request takes, top to bottom, with a signal travelling down the rule. */
export function RequestPath({ steps, className }: { steps: Array<{ name: string; note: string }>; className?: string }) {
  return (
    <PaperCard className={cn("px-5 pt-4 pb-3", className)}>
      <style>{"@keyframes path-signal{0%{top:0;opacity:0}8%,92%{opacity:1}100%{top:100%;opacity:0}}"}</style>
      <CardHead left="Request path" right="Every request" />
      <ol className="relative" aria-label="Request path">
        <span aria-hidden="true" className="absolute top-4 bottom-4 left-[0.95rem] w-px bg-border">
          <span className="absolute left-1/2 size-2 -translate-x-1/2 bg-site-accent" style={{ animation: "path-signal 3.6s ease-in-out infinite" }} />
        </span>
        {steps.map((s, i) => (
          <li key={s.name} className="relative grid grid-cols-[2rem_1fr] gap-3 border-b border-border py-2.5 last:border-b-0">
            <span className="z-10 mt-0.5 grid size-[1.9rem] place-items-center border border-border bg-card font-mono text-[0.7rem] tabular">{String(i + 1).padStart(2, "0")}</span>
            <div className="grid">
              <span className="text-sm font-medium">{s.name}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">{s.note}</span>
            </div>
          </li>
        ))}
      </ol>
    </PaperCard>
  );
}
