"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCancelOrder } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { getBroker } from "@/lib/brokers";
import { fmtNum } from "@/lib/format";
import { ORDER_COPY, ORDER_TYPE_LABEL, formatOrderPrice } from "@/lib/order-entry";
import type { BrokerAccount, Order, TicketOrderType } from "@/lib/types";
import { SideBadge } from "@/components/terminal/badges";

function priceText(o: Order) {
  if (o.type === "MKT") return "Market";
  if (o.type === "STP_LMT") return `stop ${o.stopPrice !== undefined ? formatOrderPrice(o.stopPrice) : "?"} limit ${o.price !== undefined ? formatOrderPrice(o.price) : "?"}`;
  if (o.type === "TRAIL") return o.trailPct !== undefined ? `trail ${o.trailPct.toFixed(1)}%` : "trail";
  return o.price !== undefined ? formatOrderPrice(o.price) : "";
}

function typeLabel(t: Order["type"]) {
  return t in ORDER_TYPE_LABEL ? ORDER_TYPE_LABEL[t as TicketOrderType] : t;
}

/**
 * "Cancel this order?" for a working order at IBKR, E*TRADE or Alpaca (API key). One cancel goes to the broker
 * after the user confirms; Nasscord never repeats it. A cancel whose answer was lost stays in the dialog with
 * the order still possibly working.
 */
export function CancelOrderDialog({
  order,
  account,
  hasChildren,
  open,
  onOpenChange,
}: {
  order: Order | null;
  account: BrokerAccount | null;
  /** IBKR: the table lists orders attached to this one (a bracket's exits). */
  hasChildren: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const cancel = useCancelOrder();
  const [error, setError] = React.useState<{ message: string; unknown: boolean } | null>(null);
  const pending = cancel.isPending;

  function close() {
    if (pending) return;
    setError(null);
    onOpenChange(false);
  }

  function confirm() {
    if (!order || pending) return;
    setError(null);
    cancel.mutate(
      { accountId: order.accountId, orderId: order.id },
      {
        onSuccess: (result) => {
          toast.success(result.message);
          onOpenChange(false);
        },
        onError: (err) => {
          const unknown = err instanceof ApiError && err.code === "cancel_unknown";
          setError({ message: unknown ? ORDER_COPY.cancelUnknown : err.message, unknown });
        },
      },
    );
  }

  const broker = order ? getBroker(order.brokerId).short : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Cancel this order?</DialogTitle>
          <DialogDescription>
            Nasscord asks {broker || "the broker"} to cancel it once. Part of it can still fill before the cancel lands.
          </DialogDescription>
        </DialogHeader>
        {order ? (
          <dl className="grid gap-1.5 rounded-lg bg-muted/60 p-3 text-xs">
            <div className="grid grid-cols-[6rem_1fr] gap-2">
              <dt className="text-muted-foreground">Account</dt>
              <dd className="flex items-center gap-1.5">
                <BrokerMark id={order.brokerId} size="xs" />
                {broker} {account?.label ?? ""} <span className="font-mono tabular">{account?.masked ?? ""}</span>
              </dd>
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-2">
              <dt className="text-muted-foreground">Order</dt>
              <dd className="flex flex-wrap items-center gap-1.5 font-mono tabular">
                <SideBadge side={order.side} />
                {fmtNum(order.qty)} {order.symbol}
              </dd>
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-2">
              <dt className="text-muted-foreground">Type</dt>
              <dd>{typeLabel(order.type)}</dd>
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-2">
              <dt className="text-muted-foreground">Price</dt>
              <dd className="font-mono tabular">{priceText(order)}</dd>
            </div>
            {order.brokerRef ? (
              <div className="grid grid-cols-[6rem_1fr] gap-2">
                <dt className="text-muted-foreground">{broker} order</dt>
                <dd className="font-mono tabular">{order.brokerRef}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {order && order.brokerId === "alpaca" && (order.parentId || order.legRole) ? (
          <p className="text-sm">Alpaca cancels the whole bracket when you cancel any part of it.</p>
        ) : null}
        {order && order.brokerId === "ibkr" && hasChildren ? <p className="text-sm">IBKR may also cancel the stop-loss and take-profit attached to this order.</p> : null}
        {error ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{error.unknown ? "Cancel not confirmed" : "Not cancelled"}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {error?.unknown ? (
            <Button
              variant="outline"
              onClick={() => {
                close();
                router.push("/app/orders");
              }}
            >
              Open Orders
            </Button>
          ) : (
            <Button variant="outline" onClick={close} disabled={pending}>
              Keep order
            </Button>
          )}
          <Button variant="destructive" onClick={confirm} disabled={pending || !order || !!error?.unknown}>
            {pending ? <LoaderCircleIcon className="animate-spin" /> : null}
            Cancel order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
