import { fmtMoney, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Signed money with semantic color. Text carries the sign; color never carries meaning alone. */
export function Pnl({ value, pct, className, compact = false }: { value: number; pct?: number; className?: string; compact?: boolean }) {
  const tone = value > 0 ? "text-gain-foreground" : value < 0 ? "text-loss-foreground" : "text-muted-foreground";
  return (
    <span className={cn("tabular font-medium", tone, className)}>
      {fmtMoney(value, { sign: true, compact })}
      {pct !== undefined ? <span className="ml-1 text-xs font-normal opacity-80">({fmtPct(pct)})</span> : null}
    </span>
  );
}

export function PctChange({ value, className, digits = 2 }: { value: number; className?: string; digits?: number }) {
  const tone = value > 0 ? "text-gain-foreground" : value < 0 ? "text-loss-foreground" : "text-muted-foreground";
  return <span className={cn("tabular font-medium", tone, className)}>{fmtPct(value, digits)}</span>;
}
