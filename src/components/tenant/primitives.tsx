import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TONE_BADGE } from "@/components/status-dot";
import { PLAN_LABEL } from "@/lib/plans";
import type { Payout, PlanId, WorkspaceStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/* Local copies of the console helpers. The tenant portal owns its own so it never depends on
   another area's in-progress files; promote to src/components when the integrator merges. */

export type Tone = keyof typeof TONE_BADGE;

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

const PAYOUT_STATUS: Record<Payout["status"], { label: string; tone: Tone }> = {
  scheduled: { label: "Scheduled", tone: "brand" },
  paid: { label: "Paid", tone: "good" },
  on_hold: { label: "On hold", tone: "warn" },
};

export function PayoutStatusBadge({ status }: { status: Payout["status"] }) {
  const s = PAYOUT_STATUS[status];
  return <ToneBadge tone={s.tone}>{s.label}</ToneBadge>;
}

/** Key / value facts list. */
export function KV({ items, className }: { items: Array<{ label: string; value: React.ReactNode }>; className?: string }) {
  return (
    <dl className={cn("divide-y divide-border text-sm", className)}>
      {items.map((it) => (
        <div key={it.label} className="flex items-start justify-between gap-4 py-2">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className="min-w-0 text-right font-medium tabular">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Label + help on the left, a control on the right. */
export function ControlRow({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="grid gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          {label}
        </label>
        {help ? (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

/** Form field wrapper: label, control, error. */
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

export function ErrorState({ title = "Could not load this page.", description = "Refresh to try again. If it keeps happening, write to support@nasscord.com." }: { title?: string; description?: string }) {
  return (
    <div role="alert" className="rounded-xl border border-dashed border-input px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
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
          <div className="px-3">
            <Skeleton className="h-3 w-28" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function ChartCardSkeleton({ title, className }: { title?: string; className?: string }) {
  return (
    <Card className={className} aria-busy="true">
      <CardHeader>{title ? <CardTitle>{title}</CardTitle> : <Skeleton className="h-4 w-40" />}</CardHeader>
      <CardContent>
        <Skeleton className="aspect-[16/9] w-full rounded-lg" />
      </CardContent>
    </Card>
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

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-border" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-3">
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16" />
        </li>
      ))}
    </ul>
  );
}

export function FormSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading form">
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="grid gap-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}
