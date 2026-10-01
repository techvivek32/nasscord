import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";

/**
 * Stat tile: label · value · optional delta (colored by whether up is good) · optional sparkline.
 * Use the same tile everywhere a KPI appears (terminal, console, partner portal).
 */
export function StatCard({
  label,
  value,
  delta,
  deltaLabel,
  upIsGood = true,
  spark,
  sparkColor,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  /** Signed number or preformatted string. */
  delta?: number | string;
  deltaLabel?: string;
  upIsGood?: boolean;
  spark?: number[];
  sparkColor?: string;
  hint?: React.ReactNode;
  className?: string;
}) {
  const deltaNum = typeof delta === "number" ? delta : undefined;
  const good = deltaNum === undefined ? undefined : upIsGood ? deltaNum >= 0 : deltaNum <= 0;
  const deltaText = typeof delta === "string" ? delta : deltaNum !== undefined ? `${deltaNum > 0 ? "+" : ""}${deltaNum}` : null;

  return (
    <Card size="sm" className={cn("gap-2", className)}>
      <div className="flex items-center justify-between gap-2 px-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {hint}
      </div>
      <div className="px-3 font-heading text-[1.65rem] leading-none font-semibold tracking-tight text-card-foreground">{value}</div>
      {(deltaText || spark) && (
        <div className="flex items-end justify-between gap-3 px-3">
          {deltaText ? (
            <span className={cn("inline-flex items-center gap-1 text-xs font-semibold", good === undefined ? "text-muted-foreground" : good ? "text-gain-foreground" : "text-loss-foreground")}>
              {good !== undefined && (good ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />)}
              {deltaText}
              {deltaLabel ? <span className="font-normal text-muted-foreground">{deltaLabel}</span> : null}
            </span>
          ) : (
            <span />
          )}
          {spark ? <Sparkline data={spark} className="h-7 w-24" color={sparkColor} /> : null}
        </div>
      )}
    </Card>
  );
}
