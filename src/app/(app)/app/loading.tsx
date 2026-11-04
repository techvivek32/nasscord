import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton, StatRowSkeleton } from "@/components/terminal/skeletons";

/** Route-level fallback for every terminal page while the segment streams in: header, a stat row, a panel. */
export default function Loading() {
  return (
    <>
      <div className="space-y-2">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <StatRowSkeleton />
      <CardSkeleton lines={5} />
    </>
  );
}
