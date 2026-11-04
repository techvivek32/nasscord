import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Key / value facts list. Labels muted, values right-aligned. */
export function KV({ items, className }: { items: Array<{ label: string; value: React.ReactNode }>; className?: string }) {
  return (
    <dl className={cn("divide-y divide-border text-sm", className)}>
      {items.map((it) => (
        <div key={it.label} className="flex items-center justify-between gap-4 py-2">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="min-w-0 text-right font-medium break-words tabular">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Section heading inside cards and detail pages. */
export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
      {hint}
    </div>
  );
}

/** Uppercase table header cell class, for the small hand-built tables. */
export const TH = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

/* ---------------- skeletons ---------------- */

export function StatGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-busy="true" aria-label="Loading metrics">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="sm" className="gap-2">
          <div className="px-3">
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="px-3">
            <Skeleton className="h-7 w-24" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5, className }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} aria-busy="true" aria-label="Loading table">
      <Skeleton className="h-8 w-full sm:w-64" />
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="flex gap-4 border-b px-3 py-3">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 border-b px-3 py-3 last:border-0">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className={cn("h-4 flex-1", c === 0 && "h-5")} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
