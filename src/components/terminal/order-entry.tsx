"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, LoaderCircleIcon, SendIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { qk, useCheckOrderRequest, useOrderRequests, useResolveOrderRequest } from "@/hooks/queries";
import { useWorkspaceId } from "@/components/workspace-scope";
import { getBroker } from "@/lib/brokers";
import { fmtNum, fmtTimeET } from "@/lib/format";
import { ORDER_COPY, ORDER_TERMS, stoppedChecking } from "@/lib/order-entry";
import type { TicketDraft } from "@/lib/order-ticket";
import { acceptOrderTerms, requestOrderEntry } from "@/lib/server/order-actions";
import type { OrderCapabilities, OrderRequest } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTradableAccounts, type OrderEntryStatus, type TradableAccount } from "@/components/terminal/hooks";
import { OrderConfirmDialog } from "@/components/terminal/order-confirm-dialog";
import { OrderTicket } from "@/components/terminal/order-ticket";

/*
 * Order entry in the terminal (docs/real-backend.md section 13). The provider sits in the terminal layout, so
 * the header, every page, the ticket sheet and the confirm dialog share one view of capabilities (polled from
 * GET /api/broker/orders/capabilities; the layout never passes the flag down, it would go stale). It owns the
 * one ticket sheet and the one confirm dialog, and only one of them is open at a time. Every order control
 * renders only when the state is "on" and the account's connection is listed in the capabilities.
 */

/** The warn tone for an Alert (ui/alert has no warn variant). */
export const WARN_ALERT = "border-warn/40 bg-warn-soft text-warn-foreground *:data-[slot=alert-description]:text-warn-foreground/90";

export interface OrderEntryValue {
  state: OrderEntryStatus;
  message: string | null;
  caps: OrderCapabilities | null;
  tradable: TradableAccount[];
  tradableLoading: boolean;
  riskPct: number;
  paperFirst: boolean;
  /**
   * The one-time notice is accepted: in the capabilities, or by "I understand" in this tab (before the
   * capabilities refetch shows it). The ticket checks this, never caps.termsAcceptedAt alone.
   */
  termsAccepted: boolean;
  /** Opens the ticket (after the one-time notice when the user has not accepted it yet). */
  open(prefill?: TicketDraft): void;
  /** Closes the ticket, keeps the draft and opens the confirm dialog on a previewed request. */
  showPreview(request: OrderRequest, draft: TicketDraft | null): void;
}

const OrderEntryContext = React.createContext<OrderEntryValue | null>(null);

const FALLBACK: OrderEntryValue = {
  state: "unavailable",
  message: ORDER_COPY.unavailable,
  caps: null,
  tradable: [],
  tradableLoading: false,
  riskPct: 1,
  paperFirst: false,
  termsAccepted: false,
  open: () => {},
  showPreview: () => {},
};

/** Order entry state for this workspace and user. Outside the provider it answers "unavailable" and opens nothing. */
export function useOrderEntry(): OrderEntryValue {
  return React.useContext(OrderEntryContext) ?? FALLBACK;
}

interface ConfirmState {
  request: OrderRequest;
  draft: TicketDraft | null;
  /** Client clock when the answer arrived: the countdown runs from here, on the server's own validity. */
  receivedAt: number;
  open: boolean;
}

export function OrderEntryProvider({ riskPct, paperFirst, children }: { riskPct: number; paperFirst: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const wid = useWorkspaceId();
  const { caps, state, message, isLoading, accounts } = useTradableAccounts();
  const [sheet, setSheet] = React.useState<{ open: boolean; count: number; draft: TicketDraft | null }>({ open: false, count: 0, draft: null });
  const [confirm, setConfirm] = React.useState<ConfirmState | null>(null);
  const [terms, setTerms] = React.useState<{ open: boolean; pending: TicketDraft | null }>({ open: false, pending: null });
  const [acceptedHere, setAcceptedHere] = React.useState(false);

  const openSheet = React.useCallback((draft: TicketDraft | null) => {
    setConfirm((c) => (c && c.open ? { ...c, open: false } : c));
    setSheet((s) => ({ open: true, count: s.count + 1, draft }));
  }, []);

  const termsAccepted = acceptedHere || !!caps?.termsAcceptedAt;

  const open = React.useCallback(
    (prefill?: TicketDraft) => {
      if (!termsAccepted) {
        setTerms({ open: true, pending: prefill ?? null });
        return;
      }
      openSheet(prefill ?? null);
    },
    [termsAccepted, openSheet],
  );

  const showPreview = React.useCallback((request: OrderRequest, draft: TicketDraft | null) => {
    setSheet((s) => ({ ...s, open: false, draft }));
    setConfirm({ request, draft, receivedAt: Date.now(), open: true });
  }, []);

  const pendingDraft = terms.pending;
  const onTermsAccepted = React.useCallback(() => {
    setAcceptedHere(true);
    if (wid) void queryClient.invalidateQueries({ queryKey: qk.orderCapabilities(wid) });
    setTerms({ open: false, pending: null });
    openSheet(pendingDraft);
  }, [openSheet, queryClient, wid, pendingDraft]);

  const closeAll = React.useCallback(() => {
    setConfirm((c) => (c ? { ...c, open: false } : c));
    setSheet((s) => ({ ...s, open: false }));
  }, []);

  const value = React.useMemo<OrderEntryValue>(
    () => ({ state, message, caps, tradable: accounts, tradableLoading: isLoading, riskPct, paperFirst, termsAccepted, open, showPreview }),
    [state, message, caps, accounts, isLoading, riskPct, paperFirst, termsAccepted, open, showPreview],
  );

  return (
    <OrderEntryContext.Provider value={value}>
      {children}
      <Sheet open={sheet.open} onOpenChange={(o) => setSheet((s) => ({ ...s, open: o }))}>
        <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetHeader className="pb-0">
            <SheetTitle>New order</SheetTitle>
            <SheetDescription>Preview the order, then confirm it before it goes to your broker.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <OrderTicket key={sheet.count} variant="sheet" draft={sheet.draft} riskPct={riskPct} paperFirst={paperFirst} />
          </div>
        </SheetContent>
      </Sheet>
      {confirm ? (
        <OrderConfirmDialog
          request={confirm.request}
          receivedAt={confirm.receivedAt}
          draft={confirm.draft}
          open={confirm.open}
          onOpenChange={(o) => setConfirm((c) => (c ? { ...c, open: o } : c))}
          onEdit={() => openSheet(confirm.draft)}
          onDone={() => setConfirm((c) => (c ? { ...c, open: false } : c))}
          onPreviewed={(request) => showPreview(request, confirm.draft)}
          onOpenOrders={() => {
            closeAll();
            router.push("/app/orders");
          }}
        />
      ) : null}
      <OrderTermsDialog open={terms.open} onOpenChange={(o) => setTerms((t) => ({ ...t, open: o }))} onAccepted={onTermsAccepted} />
    </OrderEntryContext.Provider>
  );
}

/** "Before your first order": the one-time notice a user accepts before the first preview (D20). */
export function OrderTermsDialog({ open, onOpenChange, onAccepted }: { open: boolean; onOpenChange: (open: boolean) => void; onAccepted: () => void }) {
  const [saving, setSaving] = React.useState(false);

  async function accept() {
    setSaving(true);
    let r: { ok: boolean; error?: string };
    try {
      r = await acceptOrderTerms();
    } catch {
      r = { ok: false, error: "The server did not answer. Check your connection and try again." };
    }
    setSaving(false);
    if (r.ok) onAccepted();
    else toast.error(r.error ?? "We could not save that. Try again.");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Before your first order</DialogTitle>
          <DialogDescription>Nasscord asks you to read this once, before your first order.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2 text-sm">
          {ORDER_TERMS.map((line) => (
            <li key={line} className="flex gap-2">
              <CheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>{line}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Not now
          </Button>
          <Button onClick={() => void accept()} disabled={saving}>
            {saving ? <LoaderCircleIcon className="animate-spin" /> : null}
            I understand
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "New order" for page headers: only where order entry is on and an account can take orders. */
export function NewOrderButton({ className }: { className?: string }) {
  const { state, tradable, open } = useOrderEntry();
  if (state !== "on" || tradable.length === 0) return null;
  return (
    <Button size="sm" className={className} data-tour="new-order" onClick={() => open()}>
      <SendIcon />
      New order
    </Button>
  );
}

/** "Request order entry" where it is off for the workspace (not suspended or paused): an audit row the console shows. */
export function RequestOrderEntryButton({ className }: { className?: string }) {
  const { state, caps } = useOrderEntry();
  const [phase, setPhase] = React.useState<"idle" | "sending" | "sent">("idle");
  if (state !== "off" || caps?.reason !== "off") return null;

  async function send() {
    setPhase("sending");
    let r: { ok: true; already: boolean } | { ok: false; error: string };
    try {
      r = await requestOrderEntry();
    } catch {
      r = { ok: false, error: "The server did not answer. Check your connection and try again." };
    }
    if (r.ok) {
      setPhase("sent");
      toast.success(r.already ? ORDER_COPY.requestAlready : ORDER_COPY.requestSent);
    } else {
      setPhase("idle");
      toast.error(r.error);
    }
  }

  return (
    <Button size="sm" variant="outline" className={className} disabled={phase !== "idle"} onClick={() => void send()}>
      {phase === "sending" ? <LoaderCircleIcon className="animate-spin" /> : phase === "sent" ? <CheckIcon /> : null}
      {phase === "sent" ? "Requested" : "Request order entry"}
    </Button>
  );
}

const SIDE_WORD = { BUY: "Buy", SELL: "Sell" } as const;

/** One line of the unconfirmed banner, with "Check again" and "I checked it in {Broker}". */
function UnconfirmedRow({ request }: { request: OrderRequest }) {
  const broker = getBroker(request.brokerId).short;
  const check = useCheckOrderRequest();
  const resolve = useResolveOrderRequest();
  const [asking, setAsking] = React.useState(false);
  const t = request.ticket;
  // A send still in flight (the service turns it into unknown once it is stale): nothing to mark yet.
  const sending = request.status === "sending";
  const text = sending ? ORDER_COPY.sendingNow : request.autoChecking ? (request.error ?? ORDER_COPY.unknownOutcome) : stoppedChecking(broker);

  function checkAgain() {
    check.mutate(request.id, {
      onSuccess: ({ request: r }) => {
        if (r.status === "placed") toast.success(`Nasscord found this order at ${broker}${r.brokerOrderId ? `: order ${r.brokerOrderId}` : ""}.`);
        else if (r.status === "rejected") toast.warning(r.error ?? `${broker} rejected this order.`);
        else toast(ORDER_COPY.stillUnconfirmed, { description: r.error });
      },
      onError: (err) => toast.error(err.message),
    });
  }

  function markChecked() {
    resolve.mutate(request.id, {
      onSuccess: () => {
        setAsking(false);
        toast.success("Marked as checked. Nasscord stops warning about this order.");
      },
      onError: (err) => toast.error(err.message),
    });
  }

  return (
    <li className="grid gap-1.5 border-t border-warn/30 pt-2 first:border-t-0 first:pt-0">
      <p>
        <span className="font-mono tabular">
          {SIDE_WORD[t.side]} {fmtNum(t.quantity)} {t.symbol}
        </span>{" "}
        on {broker} <span className="font-mono tabular">{request.accountDisplay}</span>, sent {fmtTimeET(request.sentAt ?? request.createdAt)}. {text}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={checkAgain} disabled={check.isPending}>
          {check.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
          Check again
        </Button>
        {sending ? null : (
          <Button size="xs" variant="ghost" onClick={() => setAsking(true)}>
            I checked it in {broker}
          </Button>
        )}
      </div>
      <Dialog open={asking} onOpenChange={(o) => !resolve.isPending && setAsking(o)}>
        <DialogContent className="sm:max-w-md" showCloseButton={!resolve.isPending}>
          <DialogHeader>
            <DialogTitle>Mark this order as checked?</DialogTitle>
            <DialogDescription>Nasscord stops warning about it. It does not change anything at {broker}.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)} disabled={resolve.isPending}>
              Keep warning
            </Button>
            <Button onClick={markChecked} disabled={resolve.isPending}>
              {resolve.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
              Mark as checked
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** Orders whose outcome Nasscord could not confirm. Shown even when order entry is off (D15). */
export function UnconfirmedOrders({ className }: { className?: string }) {
  const { data, error } = useOrderRequests();
  if (!data) return error ? <p className={cn("text-xs text-muted-foreground", className)}>{ORDER_COPY.listUnavailable}</p> : null;
  const rows = data.requests.filter((r) => !r.resolvedAt);
  if (rows.length === 0) return null;
  return (
    <Alert className={cn(WARN_ALERT, className)}>
      <TriangleAlertIcon />
      <AlertTitle>Unconfirmed orders</AlertTitle>
      <AlertDescription>
        <ul className="grid gap-2 text-sm">
          {rows.map((r) => (
            <UnconfirmedRow key={r.id} request={r} />
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
