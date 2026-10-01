"use client";

import * as React from "react";
import { ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtCompact, fmtMoney } from "@/lib/format";

/** Compact dollar axis: $1.2K. */
export const moneyAxis = (v: number) => (v === 0 ? "$0" : `$${fmtCompact(v, 1)}`);

type TooltipProps = React.ComponentProps<typeof ChartTooltipContent> & { config: ChartConfig };

/** Tooltip for money series: swatch, series label, full dollar value. */
export function MoneyTooltip({ config, ...props }: TooltipProps) {
  return (
    <ChartTooltipContent
      {...props}
      formatter={(value, name) => (
        <span className="flex w-full items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: `var(--color-${String(name)})` }} />
          <span className="flex-1 text-muted-foreground">{config[String(name)]?.label ?? String(name)}</span>
          <span className="font-mono font-medium text-foreground tabular">{fmtMoney(typeof value === "number" ? value : Number(value))}</span>
        </span>
      )}
    />
  );
}
