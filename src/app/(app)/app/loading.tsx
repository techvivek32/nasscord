import { Skeleton } from "@/components/ui/skeleton";
import { AlertCardSkeleton, CardSkeleton, StatRowSkeleton } from "@/components/terminal/skeletons";

/** Route-level fallback: the shape of the alerts page while the segment streams in. */
export default function Loading() {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>
      <StatRowSkeleton />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-3 w-72 max-w-full" />
            <Skeleton className="h-7 w-44" />
          </div>
          <AlertCardSkeleton />
          <AlertCardSkeleton />
          <AlertCardSkeleton />
        </div>
        <div className="flex flex-col gap-4">
          <CardSkeleton lines={7} />
          <CardSkeleton lines={3} />
        </div>
      </div>
    </>
  );
}
