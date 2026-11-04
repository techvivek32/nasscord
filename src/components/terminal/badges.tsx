import { Badge } from "@/components/ui/badge";
import { TONE_BADGE } from "@/components/status-dot";
import type { OrderSide, OrderStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const ORDER_STATUS: Record<OrderStatus, { label: string; tone: keyof typeof TONE_BADGE }> = {
  submitted: { label: "Submitted", tone: "neutral" },
  verifying: { label: "Verifying", tone: "warn" },
  working: { label: "Working", tone: "warn" },
  verified: { label: "Verified", tone: "brand" },
  filled: { label: "Filled", tone: "good" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  rejected: { label: "Rejected", tone: "bad" },
};

export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  const s = ORDER_STATUS[status];
  return (
    <Badge variant="secondary" className={cn(TONE_BADGE[s.tone], className)}>
      {s.label}
    </Badge>
  );
}

export function SideBadge({ side, className }: { side: OrderSide; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("font-mono tracking-wide", side === "BUY" ? TONE_BADGE.good : TONE_BADGE.bad, className)}>
      {side}
    </Badge>
  );
}
