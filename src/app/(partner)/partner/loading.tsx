import { Skeleton } from "@/components/ui/skeleton";
import { StatGridSkeleton, TableSkeleton } from "@/components/partner/primitives";

/** Route-level fallback while a partner page's server part resolves. */
export default function PartnerLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-label="Loading page">
      <div className="grid gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <StatGridSkeleton count={4} />
      <TableSkeleton rows={5} cols={6} />
    </div>
  );
}
