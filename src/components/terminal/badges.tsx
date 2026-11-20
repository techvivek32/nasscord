import { Badge } from "@/components/ui/badge";
import { TONE_BADGE } from "@/components/status-dot";
import type { OrderRequestStatus, OrderSide, OrderStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const ORDER_STATUS: Record<OrderStatus, { label: string; tone: keyof typeof TONE_BADGE }> = {
  submitted: { label: "Submitted", tone: "neutral" },
  verifying: { label: "Verifying", tone: "warn" },
  working: { label: "Working", tone: "warn" },
  verified: { label: "Verified", tone: "brand" },
  cancel_requested: { label: "Cancel requested", tone: "warn" },
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

const ORDER_REQUEST_STATUS: Record<OrderRequestStatus, { label: string; tone: keyof typeof TONE_BADGE }> = {
  preview: { label: "Preview", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  sending: { label: "Sending", tone: "warn" },
  placed: { label: "Placed", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
  unknown: { label: "Unconfirmed", tone: "warn" },
  needs_confirmation: { label: "Needs your confirmation", tone: "warn" },
  cancel_requested: { label: "Cancel requested", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** What became of an order ticket previewed in Nasscord (order_requests, as the broker service answers it). */
export function OrderRequestStatusBadge({ status, className }: { status: OrderRequestStatus; className?: string }) {
  const s = ORDER_REQUEST_STATUS[status] ?? ORDER_REQUEST_STATUS.unknown;
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
