import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TONE_BADGE } from "@/components/status-dot";
import { fmtDate } from "@/lib/format";
import { PLAN_LABEL } from "@/lib/plans";
import type { PlanId, TenantStatus, WorkspaceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/* The tenant portal's small building blocks. Pure: safe for server and client components. */

export type Tone = keyof typeof TONE_BADGE;

/** "Nov 3, 2026" in Eastern time, so server and browser render the same day. */
export function fmtDay(iso: string) {
  return fmtDate(iso, { timeZone: "America/New_York" });
}

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <Badge variant="secondary" className={cn(TONE_BADGE[tone], className)}>
      {children}
    </Badge>
  );
}

/** Every tenant earns commission; "White-label" marks the ones the super admin granted it to. */
export function WhiteLabelBadge({ on, className }: { on: boolean; className?: string }) {
  return (
    <ToneBadge tone={on ? "brand" : "neutral"} className={className}>
      {on ? "White-label" : "Commission"}
    </ToneBadge>
  );
}

const PLAN_TONE: Record<PlanId, Tone> = { starter: "neutral", pro: "brand", desk: "good", enterprise: "warn" };

export function PlanBadge({ plan, className }: { plan: PlanId; className?: string }) {
  return (
    <ToneBadge tone={PLAN_TONE[plan]} className={className}>
      {PLAN_LABEL[plan]}
    </ToneBadge>
  );
}

const WORKSPACE_STATUS: Record<WorkspaceStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  trial: { label: "Trial", tone: "brand" },
  past_due: { label: "Past due", tone: "warn" },
  suspended: { label: "Suspended", tone: "bad" },
};

export function WorkspaceStatusBadge({ status }: { status: WorkspaceStatus }) {
  const s = WORKSPACE_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

const TENANT_STATUS: Record<TenantStatus, { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "good" },
  pending: { label: "Pending", tone: "warn" },
  suspended: { label: "Suspended", tone: "neutral" },
};

export function TenantStatusBadge({ status }: { status: TenantStatus }) {
  const s = TENANT_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

/** Key / value facts list. */
export function KV({ items, className }: { items: Array<{ label: string; value: React.ReactNode }>; className?: string }) {
  return (
    <dl className={cn("divide-y divide-border text-sm", className)}>
      {items.map((it) => (
        <div key={it.label} className="flex items-start justify-between gap-4 py-2">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="min-w-0 text-right font-medium break-words tabular">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Form field wrapper: label, control, error or hint. */
export function Field({ id, label, hint, error, children, className }: { id: string; label: string; hint?: string; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------- skeletons ---------------- */

export function StatGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-busy="true" aria-label="Loading metrics">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="sm" className="gap-2">
          <div className="px-3">
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="px-3">
            <Skeleton className="h-7 w-20" />
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
