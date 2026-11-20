"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, InfoIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { qk, useCheckOrderRequest, useOrderRequest, usePlaceOrder, usePreviewOrder } from "@/hooks/queries";
import { useWorkspaceId } from "@/components/workspace-scope";
import { ApiError, fetchOrderRequest, type PlaceResult } from "@/lib/api";
import { getBroker } from "@/lib/brokers";
import { fmtMoney, fmtNum } from "@/lib/format";
import { ACTIVE_REQUEST, DUPLICATE_CODES, ORDER_COPY, ORDER_TYPE_LABEL, PLACED_CHECK_CODES, TIF_LABEL, formatOrderPrice, isDangerWarning } from "@/lib/order-entry";
import type { TicketDraft } from "@/lib/order-ticket";
import type { OrderRequest, OrderWarning } from "@/lib/types";
import { cn } from "@/lib/utils";
import { OrderRequestStatusBadge, SideBadge } from "@/components/terminal/badges";
import { useAccountScope } from "@/components/terminal/hooks";
import { WARN_ALERT } from "@/components/terminal/order-entry";

/*
 * The confirm dialog of order entry: shows the broker's preview of one ticket, places it once, and follows
 * what became of it. Place is armed 750 ms after a new preview (or a new question round) shows, is guarded by
 * a ref set in the click handler, and is disabled while pending. The dialog cannot close while a place is
 * pending. Any place failure other than a JSON 4xx is "checking": the dialog reads the stored row and never
 * offers to send an unconfirmed ticket again.
 */

const ARM_MS = 750;
const CHECKING_MS = 60_000;
const PREVIEW_TTL_MS = 120_000;

/** Refusals after which the same request can be placed again (the row is still a preview). */
const RETRY_CODES = new Set(["rate_limited", "busy"]);
/** Refusals that need a new preview. */
const PREVIEW_AGAIN_CODES = new Set(["preview_expired", "capabilities_changed", "confirm_mismatch", "notices_not_acknowledged"]);
/** Refusals that end the dialog: order entry or the user's access changed. Capabilities are read again. */
const CLOSE_CODES = new Set([
  "order_entry_off",
  "workspace_suspended",
  "order_entry_paused",
  "not_your_preview",
  "not_your_connection",
  "forbidden",
  "no_workspace",
  "not_member",
  "cross_site",
  "not_json",
  "signed_out",
]);

const SIDE_WORD = { BUY: "Buy", SELL: "Sell" } as const;

/* One-second clock as an external store: no Date.now() during render, null on the server. */
function subscribeSecond(onChange: () => void) {
  const t = window.setInterval(onChange, 1000);
  return () => window.clearInterval(t);
}
const secondNow = () => Math.floor(Date.now() / 1000) * 1000;
const secondServer = () => null;
function useSecondClock(): number | null {
  return React.useSyncExternalStore(subscribeSecond, secondNow, secondServer);
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

function money(v: number) {
  return fmtMoney(v);
}

function summary(r: OrderRequest) {
  const t = r.ticket;
  return `${SIDE_WORD[t.side]} ${fmtNum(t.quantity)} ${t.symbol}`;
}

/** Remaining validity of a preview or a question round: the server's own window, counted from when the answer arrived here. */
function remainingMs(r: OrderRequest, receivedAt: number, now: number | null): number | null {
  if (now === null) return null;
  const span = Date.parse(r.expiresAt) - Date.parse(r.updatedAt);
  const valid = Number.isFinite(span) ? Math.min(PREVIEW_TTL_MS, Math.max(0, span)) : PREVIEW_TTL_MS;
  return valid - Math.max(0, now - receivedAt);
}

interface Props {
  request: OrderRequest;
  receivedAt: number;
  draft: TicketDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Back to the ticket with the draft (the preview expires on its own). */
  onEdit: () => void;
  /** Close the dialog. */
  onDone: () => void;
  /** A new preview of the same ticket arrived. */
  onPreviewed: (request: OrderRequest) => void;
  /** Close the dialog and the ticket, then open /app/orders. */
  onOpenOrders: () => void;
}

export function OrderConfirmDialog({ request, receivedAt, draft, open, onOpenChange, onEdit, onDone, onPreviewed, onOpenOrders }: Props) {
  const [busy, setBusy] = React.useState(false);
  const editRef = React.useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onOpenChange(false)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg" showCloseButton={!busy} initialFocus={() => editRef.current ?? true}>
        <ConfirmBody
          key={request.id}
          initial={request}
          receivedAt={receivedAt}
          draft={draft}
          active={open}
          editRef={editRef}
          setBusy={setBusy}
          onEdit={onEdit}
          onDone={onDone}
          onPreviewed={onPreviewed}
          onOpenOrders={onOpenOrders}
        />
      </DialogContent>
    </Dialog>
  );
}

type Refusal = { code?: string; message: string; retryAfterSec?: number; at: number };

function ConfirmBody({
  initial,
  receivedAt,
  draft,
  active,
  editRef,
  setBusy,
  onEdit,
  onDone,
  onPreviewed,
  onOpenOrders,
}: {
  initial: OrderRequest;
  receivedAt: number;
  draft: TicketDraft | null;
  active: boolean;
  editRef: React.RefObject<HTMLButtonElement | null>;
  setBusy: (busy: boolean) => void;
  onEdit: () => void;
  onDone: () => void;
  onPreviewed: (request: OrderRequest) => void;
  onOpenOrders: () => void;
}) {
  const queryClient = useQueryClient();
  const wid = useWorkspaceId();
  const scope = useAccountScope();
  const placeM = usePlaceOrder();
  const previewM = usePreviewOrder();
  const checkM = useCheckOrderRequest();
  const now = useSecondClock();

  const [view, setView] = React.useState<{ request: OrderRequest; at: number }>({ request: initial, at: receivedAt });
  const [checking, setChecking] = React.useState<number | null>(null);
  const [checkingOver, setCheckingOver] = React.useState<number | null>(null);
  const [refusal, setRefusal] = React.useState<Refusal | null>(null);
  const [retryReady, setRetryReady] = React.useState<number | null>(null);
  const [reading, setReading] = React.useState(false);
  const [ticked, setTicked] = React.useState(false);
  const [armed, setArmed] = React.useState<string | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const placingRef = React.useRef(false);
  const toasted = React.useRef(new Set<string>());

  const pollingOn = checking !== null && checkingOver !== checking && active;
  const poll = useOrderRequest(checking !== null && active ? initial.id : null, { poll: pollingOn });

  // The newest answer wins: the place or check answer we hold, or the polled row. A row the server has not
  // changed keeps the time it first arrived, so reading it again never extends the preview's countdown.
  const polled = poll.data && poll.dataUpdatedAt > view.at ? poll.data.request : null;
  const latest = polled ? { request: polled, at: polled.updatedAt === view.request.updatedAt ? view.at : poll.dataUpdatedAt } : view;
  const r = latest.request;
  const status = r.status;
  const broker = getBroker(r.brokerId).short;
  const live = r.environment === "production";
  const roundKey = `${r.id}:${status}:${r.clientOrderId}`;
  const left = status === "preview" || status === "needs_confirmation" ? remainingMs(r, latest.at, now) : null;
  const expired = status === "expired" || (left !== null && left <= 0);

  // Place is armed 750 ms after a new preview or question round shows.
  React.useEffect(() => {
    const t = window.setTimeout(() => setArmed(roundKey), ARM_MS);
    return () => window.clearTimeout(t);
  }, [roundKey]);

  // "Checking" polls for 60 s, then says the order is still unconfirmed.
  React.useEffect(() => {
    if (checking === null) return;
    const t = window.setTimeout(() => setCheckingOver(checking), Math.max(0, CHECKING_MS - (Date.now() - checking)));
    return () => window.clearTimeout(t);
  }, [checking]);

  // While checking, a row the service has not claimed yet (still a preview) is read again every 2 s too.
  const refetch = poll.refetch;
  React.useEffect(() => {
    if (!pollingOn || (status !== "preview" && status !== "needs_confirmation")) return;
    const t = window.setInterval(() => void refetch(), 2_000);
    return () => window.clearInterval(t);
  }, [pollingOn, status, refetch]);

  // After rate_limited or busy, Place comes back once the wait is over (same request id).
  React.useEffect(() => {
    if (!refusal || !refusal.code || !RETRY_CODES.has(refusal.code)) return;
    const wait = (refusal.retryAfterSec ?? 5) * 1000;
    const t = window.setTimeout(() => setRetryReady(refusal.at), Math.max(0, wait - (Date.now() - refusal.at)));
    return () => window.clearTimeout(t);
  }, [refusal]);

  // One toast per outcome.
  React.useEffect(() => {
    const key = `${r.id}:${status}`;
    if (toasted.current.has(key)) return;
    if (status === "placed") {
      toasted.current.add(key);
      const check = (r.preview?.warnings ?? []).find((w) => PLACED_CHECK_CODES.has(w.code));
      if (check) toast.warning(`Check this order in Orders: ${check.text}`);
      else toast.success(`Order placed: ${summary(r)}`);
    } else if (status === "rejected") {
      toasted.current.add(key);
      toast.error(`Not placed: ${summary(r)}`);
    }
  }, [r, status]);

  /** The row with the time it arrived here: unchanged rows keep their first arrival time. */
  function stamp(row: OrderRequest): { request: OrderRequest; at: number } {
    return row.updatedAt === latest.request.updatedAt ? { request: row, at: latest.at } : { request: row, at: Date.now() };
  }

  function startChecking() {
    setChecking(Date.now());
    setCheckingOver(null);
  }

  async function readAfterRefusal(err: unknown) {
    const e = err instanceof ApiError ? err : null;
    setReading(true);
    let row: OrderRequest | null = null;
    try {
      row = (await fetchOrderRequest(r.id)).request;
    } catch {
      row = null;
    }
    setReading(false);
    if (row && row.status !== "preview" && row.status !== "needs_confirmation") {
      setView(stamp(row));
      setRefusal(null);
      if (ACTIVE_REQUEST.has(row.status)) startChecking();
      return;
    }
    if (row) setView(stamp(row));
    const code = e?.code;
    setRefusal({ code, message: e?.message ?? ORDER_COPY.unknownOutcome, retryAfterSec: e?.retryAfterSec, at: Date.now() });
    if (code && CLOSE_CODES.has(code) && wid) void queryClient.invalidateQueries({ queryKey: qk.orderCapabilities(wid) });
  }

  function onPlaced(res: PlaceResult) {
    if ("request" in res) {
      setView(stamp(res.request));
      setRefusal(null);
      if (ACTIVE_REQUEST.has(res.request.status)) startChecking();
      return;
    }
    // Anything but a JSON refusal: the order may have gone out. Read the row, never send again.
    setRefusal(null);
    startChecking();
  }

  function place() {
    if (placingRef.current || !canPlace) return;
    placingRef.current = true;
    setBusy(true);
    const acknowledged = (r.preview?.notices ?? []).map((n) => n.key);
    const input =
      status === "needs_confirmation" ? { requestId: r.id, acknowledged, confirmBrokerMessages: r.brokerMessages.map((m) => m.id) } : { requestId: r.id, acknowledged };
    placeM.mutate(input, {
      onSuccess: onPlaced,
      onError: (err) => void readAfterRefusal(err),
      onSettled: () => {
        placingRef.current = false;
        setBusy(false);
      },
    });
  }

  function previewAgain() {
    setPreviewError(null);
    setBusy(true);
    previewM.mutate(r.ticket, {
      onSuccess: ({ request }) => onPreviewed(request),
      onError: (err) => setPreviewError(err.message),
      onSettled: () => setBusy(false),
    });
  }

  function checkAgain() {
    checkM.mutate(r.id, {
      onSuccess: ({ request }) => setView(stamp(request)),
      onError: (err) => toast.error(err.message),
    });
  }

  const warnings = r.preview?.warnings ?? [];
  const needsTick = warnings.some((w) => DUPLICATE_CODES.has(w.code));
  const refusedCode = refusal?.code ?? "";
  const retryable = !!refusal && RETRY_CODES.has(refusedCode);
  const placeHiddenByRefusal = !!refusal && !retryable;
  const placeable = (status === "preview" || status === "needs_confirmation") && !expired;
  const canPlace =
    placeable &&
    !placeHiddenByRefusal &&
    (!retryable || retryReady === refusal?.at) &&
    armed === roundKey &&
    !placeM.isPending &&
    !reading &&
    !previewM.isPending &&
    (!needsTick || ticked);

  const t = r.ticket;
  const isClose = t.intent === "close";
  const account = scope.accounts.find((a) => a.id === r.accountId) ?? null;

  /* ---------- title ---------- */
  const checkWarning = warnings.find((w) => PLACED_CHECK_CODES.has(w.code));
  let title: string;
  if (status === "placed") title = checkWarning ? (checkWarning.code === "ibkr_waiting_decision" ? "IBKR is holding this order for a decision" : "Order placed: check it now") : "Order placed";
  else if (status === "needs_confirmation" && !expired) title = `${broker} asks you to confirm`;
  else if (status === "rejected") title = `Not placed: ${summary(r)}`;
  else if (status === "unknown") title = `Unconfirmed: ${summary(r)}`;
  else if (status === "sending") title = `Sending: ${summary(r)}`;
  else if (expired) title = "This preview expired";
  else if (status === "cancel_requested" || status === "cancelled") title = summary(r);
  else title = isClose ? `Confirm: close ${t.symbol}` : `Confirm: ${summary(r)}`;

  const envLine = live ? (
    <Alert className={WARN_ALERT}>
      <TriangleAlertIcon />
      <AlertTitle className="tracking-wide">LIVE ACCOUNT</AlertTitle>
      <AlertDescription>
        This order goes to your live {broker} account <span className="font-mono tabular">{r.accountDisplay}</span>. It uses real money.
      </AlertDescription>
    </Alert>
  ) : (
    <Alert>
      <InfoIcon />
      <AlertTitle className="tracking-wide">PAPER ACCOUNT</AlertTitle>
      <AlertDescription>
        This order goes to your {broker} paper account <span className="font-mono tabular">{r.accountDisplay}</span>. {broker} simulates the fills.
      </AlertDescription>
    </Alert>
  );

  const editButton = (
    <Button ref={editRef} variant="outline" onClick={onEdit} disabled={placeM.isPending || previewM.isPending}>
      Edit order
    </Button>
  );
  const previewAgainButton = (
    <Button onClick={previewAgain} disabled={previewM.isPending || placeM.isPending}>
      {previewM.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
      Preview again
    </Button>
  );
  const closeButton = (
    <Button variant="outline" onClick={onDone}>
      Close
    </Button>
  );
  const placeLabel = `${live ? "Place live order: " : ""}${summary(r)}`;
  const placeButton = (
    <Button onClick={place} disabled={!canPlace}>
      {placeM.isPending || reading ? <LoaderCircleIcon className="animate-spin" /> : null}
      {status === "needs_confirmation" ? "Send anyway" : placeLabel}
    </Button>
  );

  /* ---------- body by state ---------- */
  let body: React.ReactNode;
  let footer: React.ReactNode;
  const reviewing = placeable || (expired && (status === "preview" || status === "needs_confirmation" || status === "expired"));

  if (status === "placed") {
    const legs = r.brokerOrderIds ?? [];
    const shown = warnings.filter((w) => PLACED_CHECK_CODES.has(w.code));
    body = (
      <div className="grid gap-3">
        {shown.map((w) => (
          <WarningAlert key={w.code} warning={w} danger={isDangerWarning(w.code, r.environment)} />
        ))}
        <p>
          {broker} order <span className="font-mono tabular">{r.brokerOrderId ?? "number not reported"}</span>.
        </p>
        {legs.length > 1 ? (
          <p className="text-xs text-muted-foreground">
            {legs.map((l, i) => (
              <span key={l.id}>
                {i > 0 ? ", " : ""}
                {l.role === "take_profit" ? "take-profit" : l.role === "stop_loss" ? "stop-loss" : "entry"} <span className="font-mono tabular">{l.id}</span>
              </span>
            ))}
          </p>
        ) : null}
        <BrokerMessages request={r} />
      </div>
    );
    footer = checkWarning ? (
      <>
        <Button variant="outline" onClick={onDone}>
          Done
        </Button>
        <Button onClick={onOpenOrders}>View in Orders</Button>
      </>
    ) : (
      <>
        <Button variant="outline" onClick={onOpenOrders}>
          View in Orders
        </Button>
        <Button onClick={onDone}>Done</Button>
      </>
    );
  } else if (status === "rejected") {
    const error = r.error ?? `${broker} did not take this order.`;
    body = (
      <div className="grid gap-3">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{error}</AlertTitle>
          {/nothing was placed/i.test(error) ? null : <AlertDescription>Nothing was placed.</AlertDescription>}
        </Alert>
        <BrokerMessages request={r} />
      </div>
    );
    footer = (
      <>
        {closeButton}
        {editButton}
      </>
    );
  } else if (status === "unknown" || status === "sending") {
    const polling = pollingOn;
    body = (
      <div className="grid gap-3">
        {status === "unknown" ? (
          <Alert className={WARN_ALERT}>
            <TriangleAlertIcon />
            <AlertTitle>{r.error ?? ORDER_COPY.unknownOutcome}</AlertTitle>
          </Alert>
        ) : null}
        {polling ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <LoaderCircleIcon className="size-4 animate-spin" />
            {status === "sending" ? "Sending..." : `Checking with ${broker}...`}
          </p>
        ) : checking !== null ? (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {ORDER_COPY.stillUnconfirmed}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Request <span className="font-mono tabular">{r.clientOrderId}</span>. Nasscord never sends this ticket again by itself.
        </p>
      </div>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onOpenOrders}>
          Open Orders
        </Button>
        {status === "unknown" ? (
          <Button onClick={checkAgain} disabled={checkM.isPending}>
            {checkM.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
            Check again
          </Button>
        ) : null}
      </>
    );
  } else if (status === "cancel_requested" || status === "cancelled") {
    body = (
      <p className="flex items-center gap-2">
        <OrderRequestStatusBadge status={status} />
        {broker} order <span className="font-mono tabular">{r.brokerOrderId ?? ""}</span>
      </p>
    );
    footer = (
      <>
        <Button variant="outline" onClick={onOpenOrders}>
          View in Orders
        </Button>
        <Button onClick={onDone}>Done</Button>
      </>
    );
  } else if (reviewing) {
    body = (
      <div className="grid gap-3">
        {status === "needs_confirmation" && !expired ? (
          <div className="grid gap-2">
            <ul className="grid gap-1.5 rounded-lg bg-muted/60 p-3 text-sm">
              {r.brokerMessages.map((m) => (
                <li key={m.id} className="whitespace-pre-line">
                  {m.text}
                </li>
              ))}
            </ul>
            <p className="text-sm">{broker} has not placed this order yet. Sending it again asks {broker} to place it with these warnings accepted.</p>
          </div>
        ) : null}
        <OrderDetails request={r} account={account} now={now} />
        {!expired ? (
          <Warnings warnings={warnings} environment={r.environment} draft={draft} request={r} netLiq={account?.netLiq} />
        ) : null}
        {!expired && needsTick ? (
          <div className="flex items-start gap-2 rounded-lg border border-border p-3">
            <Checkbox id={`dup-${r.id}`} checked={ticked} onCheckedChange={(c) => setTicked(c === true)} className="mt-0.5" />
            <Label htmlFor={`dup-${r.id}`} className="text-sm leading-snug font-normal">
              {ORDER_COPY.duplicateTick}
            </Label>
          </div>
        ) : null}
        {!expired && (r.preview?.notices ?? []).length > 0 ? (
          <div className="grid gap-1.5 text-xs text-muted-foreground">
            {(r.preview?.notices ?? []).map((n) => (
              <p key={n.key}>{n.text}</p>
            ))}
          </div>
        ) : null}
        {checking !== null && placeable ? <p className="text-sm">{ORDER_COPY.notSentYet}</p> : null}
        {refusal ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{refusal.message}</AlertTitle>
          </Alert>
        ) : null}
        {previewError ? (
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>{previewError}</AlertTitle>
          </Alert>
        ) : null}
        {expired ? (
          <p className="text-sm">This preview expired. Preview the order again.</p>
        ) : left !== null ? (
          <p className="text-xs text-muted-foreground tabular" aria-live="off">
            This preview is good for {Math.floor(Math.max(0, left) / 60_000)} min {Math.floor((Math.max(0, left) % 60_000) / 1000)} s.
          </p>
        ) : null}
      </div>
    );
    if (expired || (refusal && PREVIEW_AGAIN_CODES.has(refusedCode))) {
      footer = (
        <>
          {editButton}
          {previewAgainButton}
        </>
      );
    } else if (refusal && (CLOSE_CODES.has(refusedCode) || refusedCode === "not_found")) {
      footer = closeButton;
    } else if (refusal && !retryable) {
      footer = (
        <>
          {closeButton}
          {editButton}
        </>
      );
    } else if (status === "needs_confirmation") {
      footer = (
        <>
          <Button variant="outline" onClick={onDone} disabled={placeM.isPending}>
            Do not send
          </Button>
          {placeButton}
        </>
      );
    } else {
      footer = (
        <>
          {editButton}
          {placeButton}
        </>
      );
    }
  } else {
    body = <p className="text-sm text-muted-foreground">{r.error ?? ORDER_COPY.unknownOutcome}</p>;
    footer = closeButton;
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5">
          <BrokerMark id={r.brokerId} size="xs" />
          {broker} <span className="font-mono tabular">{r.accountDisplay}</span>
          {account ? <span>· {account.label}</span> : null}
        </DialogDescription>
      </DialogHeader>
      {envLine}
      {body}
      <DialogFooter>{footer}</DialogFooter>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono break-words tabular">{children}</dd>
    </div>
  );
}

function OrderDetails({ request: r, account, now }: { request: OrderRequest; account: { label: string } | null; now: number | null }) {
  const t = r.ticket;
  const p = r.preview;
  const broker = getBroker(r.brokerId).short;
  const name = p?.instrument?.name;
  const q = p?.quote;
  const quoteAt = q?.at ? Date.parse(q.at) : NaN;
  const quoteParts = q
    ? [q.bid !== undefined ? `bid ${formatOrderPrice(q.bid)}` : null, q.ask !== undefined ? `ask ${formatOrderPrice(q.ask)}` : null, q.last !== undefined ? `last ${formatOrderPrice(q.last)}` : null]
    : [];
  if (q && now !== null && Number.isFinite(quoteAt)) quoteParts.push(`${ago(now - quoteAt)} ago`);
  return (
    <dl className="grid gap-1.5 rounded-lg bg-muted/60 p-3 text-xs">
      <Row label="Account">
        {broker} {account?.label ? `${account.label} ` : ""}
        {r.accountDisplay} ({r.environment === "production" ? "Live" : "Paper"})
      </Row>
      <Row label="Side">
        <SideBadge side={t.side} />
      </Row>
      <Row label="Quantity">
        {fmtNum(t.quantity)}
        {t.intent === "close" ? " (whole position)" : ""}
      </Row>
      <Row label="Symbol">
        {name ? `${t.symbol}, ${name}` : t.symbol}
        {name ? null : <span className="block font-sans text-muted-foreground">{broker} did not give a name for this symbol.</span>}
      </Row>
      <Row label="Type">{ORDER_TYPE_LABEL[t.type]}</Row>
      {t.limitPrice !== undefined ? <Row label="Limit price">{formatOrderPrice(t.limitPrice)}</Row> : null}
      {t.stopPrice !== undefined ? <Row label="Stop price">{formatOrderPrice(t.stopPrice)}</Row> : null}
      <Row label="Time in force">{TIF_LABEL[t.tif]}</Row>
      {t.bracket ? (
        <>
          <Row label="Stop-loss">{formatOrderPrice(t.bracket.stopLoss.stopPrice)}</Row>
          {t.bracket.stopLoss.limitPrice !== undefined ? <Row label="Stop-loss limit">{formatOrderPrice(t.bracket.stopLoss.limitPrice)}</Row> : null}
          <Row label="Take-profit">{formatOrderPrice(t.bracket.takeProfit.limitPrice)}</Row>
        </>
      ) : null}
      {p ? (
        <Row label="Position">
          {fmtNum(p.position.before)} now, {fmtNum(p.position.after)} after a full fill
        </Row>
      ) : null}
      {p && (p.estimate.notional !== undefined || p.estimate.commission !== undefined || p.estimate.total !== undefined) ? (
        <Row label="Estimated value">
          {[
            p.estimate.notional !== undefined ? `about ${money(p.estimate.notional)}` : null,
            p.estimate.commission !== undefined ? `commission ${money(p.estimate.commission)}` : null,
            p.estimate.total !== undefined ? `total ${money(p.estimate.total)}` : null,
          ]
            .filter(Boolean)
            .join("; ")}
          <span className="block font-sans text-muted-foreground">Estimate from {p.estimate.source}</span>
        </Row>
      ) : null}
      {p?.estimate.brokerText ? (
        <Row label={broker}>
          {[p.estimate.brokerText.amount, p.estimate.brokerText.commission ? `commission ${p.estimate.brokerText.commission}` : null, p.estimate.brokerText.total ? `total ${p.estimate.brokerText.total}` : null]
            .filter(Boolean)
            .join("; ")}
        </Row>
      ) : null}
      {q ? (
        <Row label="Quote">
          <span className="font-sans">{q.source}:</span> {quoteParts.filter(Boolean).join(", ")}
        </Row>
      ) : null}
      {p?.buyingPower !== undefined ? <Row label="Buying power">{money(p.buyingPower)}</Row> : null}
      {p?.marketOpen !== undefined ? <Row label="Market">{p.marketOpen ? "Open" : "Closed"}</Row> : null}
    </dl>
  );
}

function WarningAlert({ warning, danger }: { warning: OrderWarning; danger: boolean }) {
  return (
    <Alert variant={danger ? "destructive" : undefined} className={danger ? undefined : WARN_ALERT}>
      {danger ? <CircleAlertIcon /> : <TriangleAlertIcon />}
      <AlertDescription className={danger ? undefined : "text-warn-foreground"}>{warning.text}</AlertDescription>
    </Alert>
  );
}

function Warnings({
  warnings,
  environment,
  draft,
  request,
  netLiq,
}: {
  warnings: OrderWarning[];
  environment: "production" | "paper";
  draft: TicketDraft | null;
  request: OrderRequest;
  netLiq?: number;
}) {
  const ordered = [...warnings.filter((w) => w.source === "broker"), ...warnings.filter((w) => w.source !== "broker")];
  const notional = request.preview?.estimate.notional;
  const share = notional !== undefined && netLiq && netLiq > 0 && notional > netLiq / 2 ? Math.round((notional / netLiq) * 100) : null;
  const noStopLoss = !!draft && draft.sizingStopText.trim() !== "" && !request.ticket.bracket;
  if (ordered.length === 0 && !noStopLoss && share === null) return null;
  return (
    <div className="grid gap-2">
      {ordered.map((w, i) =>
        DUPLICATE_CODES.has(w.code) || isDangerWarning(w.code, environment) ? (
          <WarningAlert key={`${w.code}-${i}`} warning={w} danger={isDangerWarning(w.code, environment)} />
        ) : (
          <p key={`${w.code}-${i}`} className="flex items-start gap-2 text-sm">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn-foreground" aria-hidden />
            <span>
              {w.source === "broker" ? <span className="text-muted-foreground">{getBroker(request.brokerId).short}: </span> : null}
              {w.text}
            </span>
          </p>
        ),
      )}
      {noStopLoss ? <WarningAlert warning={{ code: "no_stop_loss", text: ORDER_COPY.noStopLoss, source: "nasscord" }} danger={false} /> : null}
      {share !== null ? (
        <p className={cn("flex items-start gap-2 text-sm")}>
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn-foreground" aria-hidden />
          <span>This order is worth {share}% of this account&apos;s net liquidation.</span>
        </p>
      ) : null}
    </div>
  );
}

function BrokerMessages({ request }: { request: OrderRequest }) {
  if (!request.brokerMessages.length) return null;
  return (
    <ul className="grid gap-1 text-xs text-muted-foreground">
      {request.brokerMessages.map((m) => (
        <li key={m.id}>
          {getBroker(request.brokerId).short}: {m.text}
        </li>
      ))}
    </ul>
  );
}
