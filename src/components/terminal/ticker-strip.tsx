"use client";

import { useTickers } from "@/hooks/queries";
import { fmtPrice } from "@/lib/format";
import { PctChange } from "@/components/pnl";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Quote strip under the header. Scrolls sideways on narrow screens. */
export function TickerStrip({ className }: { className?: string }) {
  const { data, isLoading } = useTickers();
  return (
    <div className={cn("border-b bg-card/60", className)} role="region" aria-label="Market quotes">
      <div className="flex items-center gap-5 overflow-x-auto px-3 py-1.5 font-mono text-xs tabular [scrollbar-width:none] sm:px-4 lg:px-6 [&::-webkit-scrollbar]:hidden">
        {isLoading || !data
          ? Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-3.5 w-28 shrink-0" />)
          : data.map((t) => (
              <span key={t.symbol} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <span className="font-medium">{t.symbol}</span>
                <span className="text-foreground/80">{fmtPrice(t.last)}</span>
                <PctChange value={t.changePct} className="font-normal" />
              </span>
            ))}
      </div>
    </div>
  );
}
