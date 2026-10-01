import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function StatRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="sm" className="gap-2">
          <Skeleton className="mx-3 h-3 w-24" />
          <Skeleton className="mx-3 h-7 w-32" />
          <Skeleton className="mx-3 h-3 w-20" />
        </Card>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-full sm:w-64" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <div className="border-b px-3 py-3">
          <Skeleton className="h-3 w-2/3" />
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b px-3 py-3 last:border-0">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="ml-auto h-3 w-20" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function AlertCardSkeleton() {
  return (
    <Card className="gap-3">
      <div className="flex items-start gap-3 px-4">
        <Skeleton className="size-12 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-64" />
        </div>
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="grid grid-cols-3 gap-3 px-4">
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
      <div className="flex items-center justify-between px-4">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-7 w-24" />
      </div>
    </Card>
  );
}

export function CardSkeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <Card className={cn("gap-3", className)}>
      <Skeleton className="mx-4 h-4 w-32" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="mx-4 h-8" />
      ))}
    </Card>
  );
}

export function ChartSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("gap-3", className)}>
      <Skeleton className="mx-4 h-4 w-40" />
      <Skeleton className="mx-4 h-56" />
    </Card>
  );
}
