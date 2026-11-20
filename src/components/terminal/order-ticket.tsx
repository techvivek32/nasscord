"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { CircleAlertIcon, EyeIcon, LoaderCircleIcon, SendIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { qk, usePreviewOrder } from "@/hooks/queries";
import { useWorkspaceId } from "@/components/workspace-scope";
import { ApiError } from "@/lib/api";
import { getBroker } from "@/lib/brokers";
import { marketSession, round2, sizeByRisk } from "@/lib/engine";
import { fmtMoney, fmtNum } from "@/lib/format";
import { CANCELLABLE, ORDER_COPY, ORDER_TYPE_LABEL, TIF_LABEL, defaultTarget, normalizeSymbol } from "@/lib/order-entry";
import {
  bracketAllowed,
  buildTicketBody,
  defaultAccountId,
  emptyDraft,
  entryPrice,
  fitToCaps,
  isStockPosition,
  parsePrice,
  parseQuantity,
  sizeSuggestion,
  ticketLimitError,
  usesLimit,
  usesStop,
  type TicketDraft,
} from "@/lib/order-ticket";
import type { BrokerAccount, OrderSide, TicketOrderType, Tif } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useOrdersResult, usePositionsResult } from "@/components/terminal/broker-queries";
import { useAccountScope, useMinuteClock, type TradableAccount } from "@/components/terminal/hooks";
import { useOrderEntry } from "@/components/terminal/order-entry";
import { CardSkeleton } from "@/components/terminal/skeletons";
import { Skeleton } from "@/components/ui/skeleton";

function num(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function accountLabel(a: BrokerAccount) {
  return `${getBroker(a.brokerId).short} ${a.label} ${a.masked}`;
}

function envWord(a: TradableAccount) {
  return a.connection.environment === "paper" ? "Paper" : "Live";
}

/** A price as the user would type it back (no thousands separators). */
function priceText(p: number) {
  return p >= 1 ? p.toFixed(2) : p.toFixed(4);
}

/**
 * The order ticket: previews and places orders where order entry is on for the workspace; otherwise the
 * position-size calculator, with the reason.
 */
export function OrderTicket({
  riskPct,
  className,
  variant = "card",
  draft,
  paperFirst,
}: {
  riskPct?: number;
  className?: string;
  variant?: "card" | "sheet";
  draft?: TicketDraft | null;
  paperFirst?: boolean;
}) {
  const oe = useOrderEntry();
  const risk = riskPct ?? oe.riskPct;
  const paper = paperFirst ?? oe.paperFirst;

  if (oe.state === "loading" || (oe.state === "on" && oe.tradableLoading)) {
    return variant === "card" ? (
      <CardSkeleton lines={6} className={className} />
    ) : (
      <div className={cn("grid gap-3", className)}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (oe.state !== "on") return <SizingCalculator riskPct={risk} className={className} message={oe.message ?? ORDER_COPY.offWorkspace} />;

  const form = <TicketForm riskPct={risk} paperFirst={paper} initial={draft ?? null} />;
  if (variant === "sheet") return <div className={className}>{form}</div>;
  return <TicketCard className={className} riskPct={risk} form={form} />;
}

function TicketCard({ className, riskPct, form }: { className?: string; riskPct: number; form: React.ReactNode }) {
  return (
    <Card id="order-ticket" className={className}>
      <CardHeader>
        <CardTitle>Order ticket</CardTitle>
        <CardDescription>Preview an order and confirm it before it goes to your broker. Sizing uses your saved risk per trade, {riskPct}% of net liquidation.</CardDescription>
      </CardHeader>
      <CardContent>{form}</CardContent>
    </Card>
  );
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint}
    </div>
  );
}

function TicketForm({ riskPct, paperFirst, initial }: { riskPct: number; paperFirst: boolean; initial: TicketDraft | null }) {
  const oe = useOrderEntry();
  const scope = useAccountScope();
  const positions = usePositionsResult();
  const orders = useOrdersResult();
  const previewM = usePreviewOrder();
  const queryClient = useQueryClient();
  const wid = useWorkspaceId();
  const clock = useMinuteClock();
  const id = React.useId();
  const [draft, setDraft] = React.useState<TicketDraft>(() => initial ?? emptyDraft());
  const [notes, setNotes] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // Close: the position the user saw when the ticket opened, so a change stays named after later edits.
  const [seenQty] = React.useState<number | null>(() => initial?.expectedPositionQty ?? null);

  const tradable = oe.tradable;
  const tradableIds = new Set(tradable.map((a) => a.id));
  const fromRow = !!draft.positionId;
  const isClose = draft.intent === "close";
  // A row action stays on its row's account; otherwise the default rule picks one (or none: the user picks).
  const accountId = fromRow
    ? draft.accountId && tradableIds.has(draft.accountId)
      ? draft.accountId
      : null
    : draft.accountId && tradableIds.has(draft.accountId)
      ? draft.accountId
      : defaultAccountId({ selected: scope.selected?.id ?? null, tradable, paperFirst });
  const account = tradable.find((a) => a.id === accountId) ?? null;
  const caps = account?.caps ?? null;
  const broker = account ? getBroker(account.brokerId).short : "your broker";
  let fitted = fitToCaps({ ...draft, accountId }, caps, broker).draft;
  const sym = normalizeSymbol(fitted.symbol);

  // Positions of this account and symbol (every included account is read, whatever the header shows).
  const posData = positions.data;
  const posFailed = !!account && !!posData?.errors?.some((e) => e.connectionId === account.connectionId);
  const held =
    account && sym && posData && !posFailed
      ? posData.positions.filter((p) => p.accountId === account.id && normalizeSymbol(p.symbol) === sym && isStockPosition(p)).reduce((s, p) => s + p.qty, 0)
      : null;

  // Close: the whole position, read fresh. When it changed, the ticket follows it and says so.
  let closeLine: string | null = null;
  let closeGone = false;
  if (isClose && draft.positionId && posData && !posFailed) {
    const row = posData.positions.find((p) => p.id === draft.positionId);
    if (!row || row.qty === 0) {
      closeGone = true;
      closeLine = `You no longer hold ${sym} in this account.`;
    } else if (row.qty !== seenQty && Number.isInteger(row.qty)) {
      closeLine = `Your ${sym} position is now ${fmtNum(row.qty)} shares.`;
      fitted = { ...fitted, side: row.qty > 0 ? "SELL" : "BUY", quantityText: String(Math.abs(row.qty)), expectedPositionQty: row.qty };
    }
  }
  const working =
    isClose && account && orders.data
      ? orders.data.orders.filter((o) => o.accountId === account.id && normalizeSymbol(o.symbol) === sym && CANCELLABLE.has(o.status) && o.side === fitted.side).length
      : 0;

  const update = (patch: Partial<TicketDraft>) => {
    setError(null);
    setDraft({ ...fitted, ...patch });
  };

  function changeAccount(next: string) {
    const a = tradable.find((t) => t.id === next) ?? null;
    const res = fitToCaps({ ...fitted, accountId: next }, a?.caps ?? null, a ? getBroker(a.brokerId).short : "This broker");
    setError(null);
    setDraft(res.draft);
    setNotes(res.notes);
  }

  const showBracket = bracketAllowed(fitted, caps);
  const bracketOn = fitted.bracketOn && showBracket;
  const entry = entryPrice(fitted);
  const sizingStop = bracketOn ? parsePrice(fitted.stopLossStopText) : parsePrice(fitted.sizingStopText);
  const limits = oe.caps?.limits ?? { maxQty: 0, maxNotional: 0 };
  const sized = fitted.side === "BUY" && !isClose ? sizeSuggestion({ netLiq: account?.netLiq, riskPct, entry, stop: sizingStop !== null && entry !== null && sizingStop < entry ? sizingStop : null, maxQty: limits.maxQty }) : null;
  const allHeld = fitted.side === "SELL" && !isClose ? (held !== null ? (held > 0 ? Math.floor(held) : null) : fitted.suggestion) : null;
  const coverAll = fitted.side === "BUY" && !isClose ? (held !== null ? (held < 0 ? Math.floor(Math.abs(held)) : null) : fitted.suggestion) : null;
  const target = bracketOn && entry !== null ? defaultTarget(entry, parsePrice(fitted.stopLossStopText) ?? NaN) : null;
  const limitError = ticketLimitError(fitted, { limits }, held);

  const body = buildTicketBody(fitted, caps);
  const bodyError = "error" in body ? body.error : null;
  const canPreview = !!account && !bodyError && !limitError && !closeGone && !previewM.isPending;
  const open = clock ? marketSession(clock) === "regular" : true;

  function preview() {
    if ("error" in body) return;
    if (!oe.termsAccepted) {
      // The one-time notice comes first; the provider opens the ticket with this draft after it. Accepted in
      // this tab counts at once: the server still answers terms_not_accepted if it was not stored.
      oe.open(fitted);
      return;
    }
    setError(null);
    previewM.mutate(body, {
      onSuccess: ({ request }) => oe.showPreview(request, fitted),
      onError: (err) => {
        setError(err.message);
        if (err instanceof ApiError && err.code === "terms_not_accepted" && wid) void queryClient.invalidateQueries({ queryKey: qk.orderCapabilities(wid) });
      },
    });
  }

  if (tradable.length === 0) {
    const blocked = Object.entries(oe.caps?.blocked ?? {}).filter(([cid]) => scope.connections.some((c) => c.id === cid));
    return (
      <div className="grid gap-2 text-sm">
        <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          {ORDER_COPY.noTradableAccount}{" "}
          <Link href="/app/brokers" className="text-primary underline-offset-2 hover:underline">
            Open Brokers
          </Link>
        </p>
        {blocked.map(([cid, sentence]) => {
          const c = scope.connections.find((x) => x.id === cid);
          return (
            <p key={cid} className="flex items-start gap-2 text-xs text-muted-foreground">
              {c ? <BrokerMark id={c.brokerId} size="xs" /> : null}
              <span>{sentence}</span>
            </p>
          );
        })}
      </div>
    );
  }

  const items = tradable.map((a) => ({ value: a.id, label: `${accountLabel(a)} (${envWord(a)})` }));
  const types = caps?.types ?? [];
  const tifs: Tif[] = bracketOn ? ["GTC"] : fitted.type === "MKT" && caps && !caps.marketGtc ? ["DAY"] : (caps?.tif ?? ["DAY"]);
  const typeItems = types.map((t) => ({ value: t, label: ORDER_TYPE_LABEL[t] }));
  const tifItems = tifs.map((t) => ({ value: t, label: TIF_LABEL[t] }));

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{isClose ? "Close position" : "Order"}</span>
        {account ? (
          <Badge variant="secondary" className={cn(account.connection.environment === "paper" ? undefined : "bg-warn-soft text-warn-foreground")}>
            {envWord(account)}
          </Badge>
        ) : null}
      </div>

      <Field label="Account" htmlFor={`${id}-acct`}>
        <Select items={items} value={accountId ?? null} onValueChange={(v) => v && changeAccount(String(v))} disabled={fromRow}>
          <SelectTrigger id={`${id}-acct`} className="w-full">
            <SelectValue placeholder="Pick an account" />
          </SelectTrigger>
          <SelectContent>
            {tradable.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                <span className="flex items-center gap-2">
                  <BrokerMark id={a.brokerId} size="xs" />
                  {getBroker(a.brokerId).short} {a.label}
                  <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
                  <Badge variant="secondary" className="ml-auto">
                    {envWord(a)}
                  </Badge>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {notes.map((n) => (
        <p key={n} className="-mt-1 text-xs text-muted-foreground">
          {n}
        </p>
      ))}

      <div className="grid grid-cols-[auto_1fr] items-end gap-2">
        <ToggleGroup value={[fitted.side]} onValueChange={(v) => v[0] && !isClose && update({ side: v[0] as OrderSide })} variant="outline" spacing={0} aria-label="Side" disabled={isClose}>
          <ToggleGroupItem value="BUY">{(held !== null ? held < 0 : fitted.side === "BUY" && fitted.suggestion !== null) && !isClose ? "Buy to cover" : "Buy"}</ToggleGroupItem>
          <ToggleGroupItem value="SELL">Sell</ToggleGroupItem>
        </ToggleGroup>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-sym`} className="sr-only">
            Symbol
          </Label>
          <Input
            id={`${id}-sym`}
            value={fitted.symbol}
            onChange={(e) => update({ symbol: normalizeSymbol(e.target.value.replace(/\s+$/, "")) + (/\s$/.test(e.target.value) ? " " : "") })}
            placeholder="Symbol"
            className="font-mono uppercase"
            autoComplete="off"
            maxLength={10}
            readOnly={fromRow}
          />
        </div>
      </div>
      {fitted.side === "SELL" && !isClose && account && sym ? (
        <p className="-mt-1 text-xs text-muted-foreground">
          {held === null
            ? posData
              ? `Nasscord could not read your ${sym} position right now.`
              : "Reading your position..."
            : held > 0
              ? `You hold ${fmtNum(held, Number.isInteger(held) ? 0 : 4)} ${sym} in this account.`
              : `You hold no ${sym} in this account. Nasscord does not sell short.`}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Order type" htmlFor={`${id}-type`}>
          <Select items={typeItems} value={fitted.type} onValueChange={(v) => v && update({ type: v as TicketOrderType })}>
            <SelectTrigger id={`${id}-type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {ORDER_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Time in force" htmlFor={`${id}-tif`}>
          <Select items={tifItems} value={fitted.tif} onValueChange={(v) => v && update({ tif: v as Tif })} disabled={bracketOn}>
            <SelectTrigger id={`${id}-tif`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tifs.map((t) => (
                <SelectItem key={t} value={t}>
                  {TIF_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {bracketOn ? <p className="-mt-1 text-xs text-muted-foreground">A bracket is sent as Good till cancelled, so its stop-loss and take-profit stay after today&apos;s close.</p> : null}
      {fitted.type === "MKT" && caps && !caps.marketGtc ? <p className="-mt-1 text-xs text-muted-foreground">{broker} takes Market orders as Day orders only.</p> : null}

      {usesLimit(fitted.type) || usesStop(fitted.type) ? (
        <div className="grid grid-cols-2 gap-2">
          {usesStop(fitted.type) ? (
            <Field label="Stop price" htmlFor={`${id}-stop`}>
              <PriceInput id={`${id}-stop`} value={fitted.stopText} onChange={(v) => update({ stopText: v })} />
            </Field>
          ) : null}
          {usesLimit(fitted.type) ? (
            <Field label="Limit price" htmlFor={`${id}-limit`}>
              <PriceInput id={`${id}-limit`} value={fitted.limitText} onChange={(v) => update({ limitText: v })} />
            </Field>
          ) : null}
        </div>
      ) : null}

      <Field
        label={isClose ? "Whole position" : "Quantity"}
        htmlFor={`${id}-qty`}
        hint={
          <div className="flex flex-wrap gap-1.5">
            {sized !== null ? (
              <Button type="button" size="xs" variant="outline" onClick={() => update({ quantityText: String(sized) })}>
                Use {fmtNum(sized)} shares ({riskPct}% risk)
              </Button>
            ) : null}
            {allHeld !== null ? (
              <Button type="button" size="xs" variant="outline" onClick={() => update({ quantityText: String(allHeld) })}>
                Use {fmtNum(allHeld)} (all you hold)
              </Button>
            ) : null}
            {coverAll !== null ? (
              <Button type="button" size="xs" variant="outline" onClick={() => update({ quantityText: String(coverAll) })}>
                Use {fmtNum(coverAll)} (cover all)
              </Button>
            ) : null}
          </div>
        }
      >
        <Input
          id={`${id}-qty`}
          inputMode="numeric"
          value={fitted.quantityText}
          onChange={(e) => update({ quantityText: e.target.value.trim() })}
          className="font-mono tabular"
          placeholder="Shares"
          readOnly={isClose}
          aria-invalid={fitted.quantityText !== "" && parseQuantity(fitted.quantityText) === null ? true : undefined}
        />
      </Field>
      {closeLine ? <p className="-mt-1 text-xs font-medium">{closeLine}</p> : null}
      {limitError ? (
        <p role="alert" className="-mt-1 text-xs text-destructive">
          {limitError}
        </p>
      ) : null}

      {!bracketOn && !isClose && fitted.side === "BUY" ? (
        <Field
          label="Stop for sizing only"
          htmlFor={`${id}-sizing`}
          hint={
            <p className="text-xs text-muted-foreground">
              {caps?.bracket ? "Nasscord does not send this stop. Turn on the stop-loss below to send one." : `Place your stop in ${broker} after the entry fills.`}
            </p>
          }
        >
          <PriceInput id={`${id}-sizing`} value={fitted.sizingStopText} onChange={(v) => update({ sizingStopText: v })} placeholder="optional" />
        </Field>
      ) : null}

      {showBracket ? (
        <div className="grid gap-3 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-bracket`}>Add a stop-loss and take-profit</Label>
            <Switch id={`${id}-bracket`} checked={bracketOn} onCheckedChange={(c) => update({ bracketOn: c, tif: c ? "GTC" : fitted.tif })} />
          </div>
          {bracketOn ? (
            <>
              <div className={cn("grid gap-2", caps?.bracket?.stopTypes.includes("STP_LMT") ? "grid-cols-2" : "grid-cols-1")}>
                <Field label="Stop-loss stop price" htmlFor={`${id}-sl`}>
                  <PriceInput id={`${id}-sl`} value={fitted.stopLossStopText} onChange={(v) => update({ stopLossStopText: v })} />
                </Field>
                {caps?.bracket?.stopTypes.includes("STP_LMT") ? (
                  <Field label="Stop-loss limit price" htmlFor={`${id}-sll`}>
                    <PriceInput id={`${id}-sll`} value={fitted.stopLossLimitText} onChange={(v) => update({ stopLossLimitText: v })} placeholder="optional" />
                  </Field>
                ) : null}
              </div>
              <p className="-mt-1 text-xs text-muted-foreground">TradeScope sets its stop at 2.2 x ATR; Nasscord has no ATR source, so enter your stop.</p>
              <Field
                label="Take-profit price"
                htmlFor={`${id}-tp`}
                hint={
                  target !== null ? (
                    <div>
                      <Button type="button" size="xs" variant="outline" onClick={() => update({ takeProfitText: priceText(target) })}>
                        Use {priceText(target)} (0.72 R, TradeScope&apos;s reward to risk)
                      </Button>
                    </div>
                  ) : null
                }
              >
                <PriceInput id={`${id}-tp`} value={fitted.takeProfitText} onChange={(v) => update({ takeProfitText: v })} />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}

      {isClose && working > 0 ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn-foreground">
          You have {fmtNum(working)} working {working === 1 ? "order" : "orders"} on {sym} in this account. Nasscord does not close a position while orders on its side are working, because they could open a new position
          after it closes. Cancel them first in{" "}
          <Link href="/app/orders" className="underline underline-offset-2">
            Orders
          </Link>
          .
        </p>
      ) : null}

      <div className="grid gap-1 text-xs text-muted-foreground">
        {(caps?.notes ?? []).map((n) => (
          <p key={n}>{n}</p>
        ))}
        {!open ? <p>Outside regular hours by Nasscord&apos;s clock, which does not know market holidays. Nasscord sends regular-session orders only, so this order waits for the next session.</p> : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <Button size="lg" className="w-full" onClick={preview} disabled={!canPreview} aria-describedby={bodyError ? `${id}-why` : undefined}>
        {previewM.isPending ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
        Preview order
      </Button>
      {bodyError && !error ? (
        <p id={`${id}-why`} className="-mt-1 text-xs text-muted-foreground">
          {bodyError}
        </p>
      ) : null}
    </div>
  );
}

function PriceInput({ id, value, onChange, placeholder = "0.00" }: { id: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const invalid = value.trim() !== "" && parsePrice(value) === null;
  return (
    <Input
      id={id}
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value.trim())}
      className="font-mono tabular"
      placeholder={placeholder}
      autoComplete="off"
      aria-invalid={invalid ? true : undefined}
    />
  );
}

/**
 * The position-size calculator, shown where order entry is not on: sizes a trade over a real account's net
 * liquidation and the user's saved risk per trade. Placing is disabled and says why; nothing is sent.
 */
function SizingCalculator({ riskPct, className, message }: { riskPct: number; className?: string; message: string }) {
  const scope = useAccountScope();
  const id = React.useId();
  const [side, setSide] = React.useState<OrderSide>("BUY");
  const [symbol, setSymbol] = React.useState("");
  const [entryText, setEntryText] = React.useState("");
  const [stopText, setStopText] = React.useState("");
  const [targetText, setTargetText] = React.useState("");
  const [chosen, setChosen] = React.useState<string | null>(null);

  // Sizing needs a net liquidation the broker reported, in US dollars: entry and stop are US share prices.
  const reporting = React.useMemo(() => scope.scoped.filter((a) => typeof a.netLiq === "number" && a.netLiq > 0), [scope.scoped]);
  const eligible = React.useMemo(() => reporting.filter((a) => !a.currency || a.currency.toUpperCase() === "USD"), [reporting]);
  const accountId = chosen && eligible.some((a) => a.id === chosen) ? chosen : (eligible[0]?.id ?? "");
  const account = eligible.find((a) => a.id === accountId) ?? null;

  const entry = num(entryText);
  const stop = num(stopText);
  const target = num(targetText);
  const long = side === "BUY";
  const stopOk = long ? stop < entry : stop > entry;
  const targetOk = long ? target > entry : target < entry;
  const stopError = entry > 0 && stop > 0 && !stopOk ? `The stop goes ${long ? "below" : "above"} the entry for a ${long ? "buy" : "sell"}.` : null;
  const targetError = !stopError && entry > 0 && target > 0 && !targetOk ? `The target goes ${long ? "above" : "below"} the entry for a ${long ? "buy" : "sell"}.` : null;
  const sizing = account && entry > 0 && stop > 0 && stopOk ? sizeByRisk(account.netLiq ?? 0, riskPct, entry, stop) : null;
  const rr = sizing && target > 0 && targetOk ? Math.abs(target - entry) / Math.max(0.01, Math.abs(entry - stop)) : null;

  if (scope.isLoading) return <CardSkeleton lines={6} className={className} />;

  const items = eligible.map((a) => ({ value: a.id, label: accountLabel(a) }));

  return (
    <Card id="order-ticket" className={className}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Order ticket</CardTitle>
          <Badge variant="secondary" className="gap-1">
            <EyeIcon />
            Read only
          </Badge>
        </div>
        <CardDescription>Size a trade so a stop-out costs {riskPct}% of the account&apos;s net liquidation, your saved risk per trade.</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {eligible.length === 0 ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {scope.connections.length === 0 ? (
              <>
                Sizing uses an account&apos;s net liquidation.{" "}
                <Link href="/app/brokers" className="text-primary underline-offset-2 hover:underline">
                  Connect a broker
                </Link>{" "}
                to size against your own account.
              </>
            ) : reporting.length > 0 ? (
              "Sizing works in US dollars, and the accounts in view report their balance in another currency."
            ) : (
              "No account in view reports a net liquidation right now, so there is nothing to size against."
            )}
          </p>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-acct`}>Account</Label>
            <Select items={items} value={accountId} onValueChange={(v) => v && setChosen(String(v))}>
              <SelectTrigger id={`${id}-acct`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {eligible.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="flex items-center gap-2">
                      <BrokerMark id={a.brokerId} size="xs" />
                      {getBroker(a.brokerId).short} {a.label}
                      <span className="font-mono text-xs text-muted-foreground tabular">{a.masked}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {account ? (
              <p className="text-xs text-muted-foreground">
                Net liq <span className="font-mono tabular">{fmtMoney(account.netLiq ?? 0, { digits: 0 })}</span>
                {account.buyingPower !== undefined ? (
                  <>
                    {" · "}buying power <span className="font-mono tabular">{fmtMoney(account.buyingPower, { digits: 0 })}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        )}

        <div className="grid grid-cols-[auto_1fr] gap-2">
          <ToggleGroup value={[side]} onValueChange={(v) => v[0] && setSide(v[0] as OrderSide)} variant="outline" spacing={0} aria-label="Side">
            <ToggleGroupItem value="BUY">Buy</ToggleGroupItem>
            <ToggleGroupItem value="SELL">Sell</ToggleGroupItem>
          </ToggleGroup>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-sym`} className="sr-only">
              Symbol
            </Label>
            <Input id={`${id}-sym`} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="Symbol" className="font-mono uppercase" autoComplete="off" maxLength={12} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-entry`}>Entry</Label>
            <Input id={`${id}-entry`} inputMode="decimal" value={entryText} onChange={(e) => setEntryText(e.target.value)} className="font-mono tabular" placeholder="0.00" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-stop`}>Stop</Label>
            <Input id={`${id}-stop`} inputMode="decimal" value={stopText} onChange={(e) => setStopText(e.target.value)} className="font-mono tabular" placeholder="0.00" aria-invalid={stopError ? true : undefined} aria-describedby={stopError ? `${id}-err` : undefined} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-target`}>Target</Label>
            <Input id={`${id}-target`} inputMode="decimal" value={targetText} onChange={(e) => setTargetText(e.target.value)} className="font-mono tabular" placeholder="optional" aria-invalid={targetError ? true : undefined} aria-describedby={targetError ? `${id}-err` : undefined} />
          </div>
        </div>
        {stopError || targetError ? (
          <p id={`${id}-err`} role="alert" className="-mt-1 text-xs text-destructive">
            {stopError ?? targetError}
          </p>
        ) : null}

        <dl className="grid gap-1 rounded-lg bg-muted/60 p-3 text-xs" aria-live="polite">
          {sizing ? (
            <>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Quantity</dt>
                <dd className="font-mono font-semibold tabular">{fmtNum(sizing.qty)} sh</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">At risk to the stop</dt>
                <dd className="font-mono tabular">{fmtMoney(sizing.riskDollars)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Position value</dt>
                <dd className="font-mono tabular">{fmtMoney(sizing.notional, { digits: 0 })}</dd>
              </div>
              {rr !== null ? (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Reward to risk</dt>
                  <dd className="font-mono tabular">
                    {rr.toFixed(2)} ({fmtMoney(round2(Math.abs(target - entry) * sizing.qty))} to the target)
                  </dd>
                </div>
              ) : null}
              {sizing.cappedByCash ? <p className="text-muted-foreground">Capped so the position stays within 95% of net liquidation.</p> : null}
            </>
          ) : (
            <p className="text-muted-foreground">{account ? "Enter an entry and a stop to see the quantity." : "Pick an account to size against."}</p>
          )}
        </dl>

        <Button size="lg" className="w-full" disabled aria-describedby={`${id}-off`}>
          <SendIcon />
          {side === "BUY" ? "Buy" : "Sell"} {sizing && sizing.qty > 0 ? fmtNum(sizing.qty) : ""} {symbol || "shares"}
        </Button>
        <p id={`${id}-off`} className="-mt-1 text-xs text-muted-foreground">
          {message}
        </p>
      </CardContent>
    </Card>
  );
}
