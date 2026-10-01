"use client";

import * as React from "react";
import { ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { fmtCompact, fmtMoney } from "@/lib/format";

/** Compact dollar axis: $48.9K. */
export const moneyAxis = (v: number) => (v === 0 ? "$0" : `$${fmtCompact(v, 0)}`);

type TooltipProps = React.ComponentProps<typeof ChartTooltipContent> & { config: ChartConfig };

function Row({ config, name, children }: { config: ChartConfig; name: string; children: React.ReactNode }) {
  return (
    <span className="flex w-full items-center gap-2">
      <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: `var(--color-${name})` }} />
      <span className="flex-1 text-muted-foreground">{config[name]?.label ?? name}</span>
      <span className="font-mono font-medium text-foreground tabular">{children}</span>
    </span>
  );
}

/** Tooltip for money series: swatch, series label, full dollar value. Drop into `ChartTooltip content`. */
export function MoneyTooltip({ config, ...props }: TooltipProps) {
  return (
    <ChartTooltipContent
      {...props}
      formatter={(value, name) => (
        <Row config={config} name={String(name)}>
          {fmtMoney(typeof value === "number" ? value : Number(value), { digits: 0 })}
        </Row>
      )}
    />
  );
}

/** Tooltip for counts. */
export function CountTooltip({ config, unit = "", ...props }: TooltipProps & { unit?: string }) {
  return (
    <ChartTooltipContent
      {...props}
      formatter={(value, name) => (
        <Row config={config} name={String(name)}>
          {String(value)}
          {unit}
        </Row>
      )}
    />
  );
}
