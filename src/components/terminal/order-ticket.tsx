"use client";

import * as React from "react";
import { toast } from "sonner";
import { CheckIcon, ClockIcon, LoaderCircleIcon, SendIcon } from "lucide-react";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getBroker } from "@/lib/brokers";
import { marketSession, round2, sizeByRisk } from "@/lib/engine";
import { fmtMoney, fmtNum } from "@/lib/format";
import type { BrokerAccount, Order, OrderSide, OrderType, Tif } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAccountScope, useMinuteClock, usePaperMode } from "@/components/terminal/hooks";
import { CardSkeleton } from "@/components/terminal/skeletons";
import { type TicketDraft, useTerminalStore } from "@/components/terminal/store";

const ORDER_TYPES: Record<OrderType, string> = { LMT: "Limit", MKT: "Market", STP: "Stop", MIT: "Market if touched", TRAIL: "Trailing stop" };
const RISK_PCT = 1;
const STEP_MS = 650;

type Placing = { step: number; broker: string; ref: string } | null;

interface Form {
  side: OrderSide;
  symbol: string;
  /** Empty means "use the risk-sized quantity". */
  qty: string;
  type: OrderType;
  limit: string;
  stop: string;
  target: string;
  trailBE: boolean;
  tif: Tif;
}

const EMPTY: Form = { side: "BUY", symbol: "", qty: "", type: "LMT", limit: "", stop: "", target: "", trailBE: true, tif: "GTC" };

function fromTicket(t: TicketDraft): Form {
  return { ...EMPTY, symbol: t.symbol, limit: String(t.entry), stop: String(t.stop), target: String(t.target) };
}

function num(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function accountLabel(a: BrokerAccount) {
  return `${getBroker(a.brokerId).short} ${a.label} ${a.masked}`;
}

function makeRef(brokerId: string) {
  const n = Math.floor(1000 + Math.random() * 8999);
  return brokerId === "ibkr" ? `129${n}` : brokerId === "alpaca" ? `a${n.toString(16)}-${Math.floor(Math.random() * 90 + 10)}` : `${n}`;
}

/** Parent order plus bracket legs. Lives outside the component so ids and refs are minted in the event, not in render. */
function buildOrders(account: BrokerAccount, f: Form, qty: number, extended: boolean) {
  const ts = Date.now();
  const ref = makeRef(account.brokerId);
  const entry = num(f.limit);
  const stop = num(f.stop);
  const target = num(f.target);
  const parentId = `loc_${ts}`;
  const parent: Order = {
    id: parentId,
    clientId: `nova-${Math.floor(ts / 1000)}-${Math.random().toString(16).slice(2, 6)}`,
    accountId: account.id,
    brokerId: account.brokerId,
    symbol: f.symbol.trim().toUpperCase(),
    side: f.side,
    qty,
    type: f.type,
    price: f.type === "MKT" ? undefined : entry,
    tif: f.tif,
    status: "submitted",
    placedAt: new Date(ts).toISOString(),
    outsideRth: extended,
  };
  const exitSide: OrderSide = f.side === "BUY" ? "SELL" : "BUY";
  const legAt = new Date(ts + 1000).toISOString();
  const children: Order[] = [];
  if (target > 0) children.push({ ...parent, id: `${parentId}_t`, side: exitSide, type: "LMT", price: target, tif: "GTC", status: "working", parentId, placedAt: legAt, brokerRef: `${ref}1` });
  if (stop > 0) children.push({ ...parent, id: `${parentId}_s`, side: exitSide, type: "STP", price: stop, tif: "GTC", status: "working", parentId, placedAt: legAt, brokerRef: `${ref}2` });
  return { parent, children, ref };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Order ticket with the verified sequence. Sized to 1% risk from the selected account,
 * bracket prefilled from the loaded alert, extended-hours rules applied from the market session.
 */
export function OrderTicket({ className }: { className?: string }) {
  const scope = useAccountScope();
  const { paperMode, hydrated } = usePaperMode();
  const addLocalOrders = useTerminalStore((s) => s.addLocalOrders);
  const updateLocalOrder = useTerminalStore((s) => s.updateLocalOrder);
  const now = useMinuteClock();
  const id = React.useId();

  const eligible = React.useMemo(() => (paperMode ? scope.included.filter((a) => a.type === "paper") : scope.scoped.filter((a) => a.type !== "paper")), [paperMode, scope.included, scope.scoped]);

  const [form, setForm] = React.useState<Form>(() => {
    const t = useTerminalStore.getState().ticket;
    return t ? fromTicket(t) : EMPTY;
  });
  const [chosenAccountId, setChosenAccountId] = React.useState<string | null>(() => useTerminalStore.getState().ticket?.accountId ?? null);
  const [placing, setPlacing] = React.useState<Placing>(null);

  // An alert's Buy button loads the ticket through the store; react to that outside render.
  React.useEffect(
    () =>
      useTerminalStore.subscribe((state, prev) => {
        if (state.ticket && state.ticket !== prev.ticket) {
          setForm(fromTicket(state.ticket));
          if (state.ticket.accountId) setChosenAccountId(state.ticket.accountId);
        }
      }),
    [],
  );

  const patch = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));

  // Derived: the account stays valid for the current mode and scope without an effect.
  const accountId = chosenAccountId && eligible.some((a) => a.id === chosenAccountId) ? chosenAccountId : (eligible[0]?.id ?? "");
  const account = eligible.find((a) => a.id === accountId) ?? null;
  const entry = num(form.limit);
  const stopN = num(form.stop);
  const targetN = num(form.target);
  // The stop sits below a buy and above a sell, the target on the other side. A limit bracket on the wrong side would trigger at once.
  const long = form.side === "BUY";
  const stopOnRiskSide = long ? stopN < entry : stopN > entry;
  const targetOnRewardSide = long ? targetN > entry : targetN < entry;
  const sideWord = long ? "buy" : "sell";
  const stopError = form.type === "LMT" && entry > 0 && stopN > 0 && !stopOnRiskSide ? `Stop must be ${long ? "below" : "above"} the limit price for a ${sideWord}.` : null;
  const targetError = form.type === "LMT" && entry > 0 && targetN > 0 && !targetOnRewardSide ? `Target must be ${long ? "above" : "below"} the limit price for a ${sideWord}.` : null;
  const bracketError = stopError ?? targetError;
  const sizing = account && entry > 0 && stopN > 0 && stopOnRiskSide ? sizeByRisk(account.netLiq, RISK_PCT, entry, stopN) : null;
  const qtyN = form.qty === "" ? (sizing?.qty ?? 0) : Math.floor(num(form.qty));
  const qtyEdited = form.qty !== "";

  const session = now ? marketSession(now) : "regular";
  const extended = session === "pre" || session === "post";
  const closed = session === "closed";
  const notional = qtyN * entry;
  const canPlace = !!account && form.symbol.trim().length > 0 && qtyN > 0 && (form.type === "MKT" ? !extended : entry > 0) && !bracketError && !placing && hydrated;

  const place = async () => {
    if (!account) return;
    const broker = getBroker(account.brokerId);
    const { parent, children, ref } = buildOrders(account, form, qtyN, extended);
    const sym = parent.symbol;
    setPlacing({ step: 0, broker: broker.short, ref });
    addLocalOrders([parent]);
    await wait(STEP_MS);
    setPlacing({ step: 1, broker: broker.short, ref });
    await wait(STEP_MS);
    setPlacing({ step: 2, broker: broker.short, ref });
    updateLocalOrder(parent.id, { status: "verifying", brokerRef: ref });
    await wait(STEP_MS + 200);
    updateLocalOrder(parent.id, { status: "verified" });
    if (children.length) addLocalOrders(children);
    setPlacing({ step: 3, broker: broker.short, ref });
    const legs = children.length === 2 ? "stop and target" : stopN > 0 ? "stop" : "target";
    toast.success(`Live at ${broker.short} · #${ref} · Submitted`, {
      description: `${form.side} ${fmtNum(qtyN)} ${sym} ${form.type === "MKT" ? "at market" : `@ ${entry.toFixed(2)}`}${children.length ? ` with ${legs} attached` : ""}${paperMode ? " (paper)" : ""}. Confirmed in the broker order book.`,
    });
    await wait(1400);
    setPlacing(null);
    setForm(EMPTY);
  };

  if (scope.isLoading || !hydrated) return <CardSkeleton lines={7} className={className} />;

  const items = eligible.map((a) => ({ value: a.id, label: accountLabel(a) }));

  return (
    <Card id="order-ticket" className={cn("scroll-mt-20", className)}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Order ticket</CardTitle>
          <span className={cn("rounded-4xl px-2 py-0.5 text-xs font-medium", paperMode ? "bg-warn-soft text-warn-foreground" : "bg-gain-soft text-gain-foreground")}>{paperMode ? "Paper" : "Live"}</span>
        </div>
        <CardDescription>Bracket orders through your own broker session, verified in the order book before they count.</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3">
        {eligible.length === 0 ? (
          <Alert>
            <AlertTitle>{paperMode ? "No paper account in scope" : "No live account in scope"}</AlertTitle>
            <AlertDescription>{paperMode ? "Connect Alpaca, IBKR or another broker with paper support, or turn paper mode off in the sidebar." : "Pick a live account in the header, or include one under Brokers."}</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-acct`}>Account</Label>
            <Select items={items} value={accountId} onValueChange={(v) => v && setChosenAccountId(String(v))}>
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
                Net liq {fmtMoney(account.netLiq, { digits: 0 })} · buying power {fmtMoney(account.buyingPower, { digits: 0 })}
              </p>
            ) : null}
          </div>
        )}

        <div className="grid grid-cols-[auto_1fr] gap-2">
          <ToggleGroup value={[form.side]} onValueChange={(v) => v[0] && patch({ side: v[0] as OrderSide })} variant="outline" spacing={0} aria-label="Side">
            <ToggleGroupItem value="BUY" className="aria-pressed:bg-gain-soft aria-pressed:text-gain-foreground">
              Buy
            </ToggleGroupItem>
            <ToggleGroupItem value="SELL" className="aria-pressed:bg-loss-soft aria-pressed:text-loss-foreground">
              Sell
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-sym`} className="sr-only">
              Symbol
            </Label>
            <Input id={`${id}-sym`} value={form.symbol} onChange={(e) => patch({ symbol: e.target.value.toUpperCase() })} placeholder="Symbol" className="font-mono uppercase" autoComplete="off" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-qty`}>Quantity</Label>
            <Input id={`${id}-qty`} inputMode="numeric" value={qtyEdited ? form.qty : qtyN > 0 ? String(qtyN) : ""} onChange={(e) => patch({ qty: e.target.value })} className="font-mono tabular" placeholder="0" aria-describedby={`${id}-qty-hint`} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-type`}>Order type</Label>
            <Select items={ORDER_TYPES} value={form.type} onValueChange={(v) => v && patch({ type: v as OrderType })}>
              <SelectTrigger id={`${id}-type`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ORDER_TYPES) as OrderType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    <span className="font-mono">{t}</span> <span className="text-muted-foreground">{ORDER_TYPES[t]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {sizing ? (
          <p className="-mt-1 text-xs text-muted-foreground" id={`${id}-qty-hint`}>
            Sized to {RISK_PCT}% risk:{" "}
            <span className="font-mono tabular">
              {fmtNum(sizing.qty)} sh · {fmtMoney(sizing.riskDollars, { digits: 0 })}
            </span>{" "}
            at risk{sizing.cappedByCash ? " (capped at 95% of cash)" : ""}
            {qtyEdited && qtyN !== sizing.qty ? (
              <>
                {" "}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => patch({ qty: "" })}>
                  Use sized qty
                </button>
              </>
            ) : null}
          </p>
        ) : (
          <p className="-mt-1 text-xs text-muted-foreground" id={`${id}-qty-hint`}>
            Enter a limit price and a stop to size the position to {RISK_PCT}% of net liquidation.
          </p>
        )}

        {form.type !== "MKT" ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-limit`}>{form.type === "LMT" ? "Limit price" : form.type === "TRAIL" ? "Trail amount" : "Trigger price"}</Label>
            <Input id={`${id}-limit`} inputMode="decimal" value={form.limit} onChange={(e) => patch({ limit: e.target.value })} className="font-mono tabular" placeholder="0.00" />
          </div>
        ) : null}

        <fieldset className="grid gap-2 rounded-lg border p-3">
          <legend className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Bracket</legend>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-stop`}>Stop</Label>
              <Input id={`${id}-stop`} inputMode="decimal" value={form.stop} onChange={(e) => patch({ stop: e.target.value })} className="font-mono tabular" placeholder="entry - 2.2 x ATR" aria-invalid={stopError ? true : undefined} aria-describedby={stopError ? `${id}-bracket-err` : undefined} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-target`}>Target</Label>
              <Input id={`${id}-target`} inputMode="decimal" value={form.target} onChange={(e) => patch({ target: e.target.value })} className="font-mono tabular" placeholder="0.72 R" aria-invalid={!stopError && targetError ? true : undefined} aria-describedby={!stopError && targetError ? `${id}-bracket-err` : undefined} />
            </div>
          </div>
          {bracketError ? (
            <p id={`${id}-bracket-err`} role="alert" className="text-xs text-destructive">
              {bracketError}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={`${id}-trail`} className="font-normal">
              Trail stop to breakeven
            </Label>
            <Switch id={`${id}-trail`} checked={form.trailBE} onCheckedChange={(c) => patch({ trailBE: c })} />
          </div>
          {entry > 0 && stopN > 0 && targetN > 0 && !bracketError ? (
            <p className="text-xs text-muted-foreground">
              Risk {fmtMoney(round2(Math.abs(entry - stopN) * qtyN))} · reward {fmtMoney(round2(Math.abs(targetN - entry) * qtyN))} · R:R {(Math.abs(targetN - entry) / Math.max(0.01, Math.abs(entry - stopN))).toFixed(2)}
            </p>
          ) : null}
        </fieldset>

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" id={`${id}-tif`}>
            Time in force
          </span>
          <ToggleGroup value={[form.tif]} onValueChange={(v) => v[0] && patch({ tif: v[0] as Tif })} variant="outline" size="sm" spacing={0} aria-labelledby={`${id}-tif`}>
            <ToggleGroupItem value="GTC">GTC</ToggleGroupItem>
            <ToggleGroupItem value="DAY">DAY</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {extended ? (
          <Alert>
            <ClockIcon />
            <AlertTitle>Extended hours</AlertTitle>
            <AlertDescription>Limit orders only, outsideRTH on. Market orders wait for the 09:30 ET open.</AlertDescription>
          </Alert>
        ) : null}
        {closed ? (
          <Alert>
            <ClockIcon />
            <AlertTitle>Market closed</AlertTitle>
            <AlertDescription>The order queues at the broker and goes live at 04:00 ET pre-market.</AlertDescription>
          </Alert>
        ) : null}

        {placing ? <PlacingStepper placing={placing} /> : null}

        <Button size="lg" className="w-full" disabled={!canPlace} onClick={() => void place()}>
          {placing ? <LoaderCircleIcon className="animate-spin" /> : <SendIcon />}
          {placing ? "Placing…" : `${form.side === "BUY" ? "Buy" : "Sell"} ${qtyN > 0 ? fmtNum(qtyN) : ""} ${form.symbol || "shares"}${notional > 0 ? ` · ${fmtMoney(notional, { digits: 0 })}` : ""}`}
        </Button>
      </CardContent>
    </Card>
  );
}

function PlacingStepper({ placing }: { placing: NonNullable<Placing> }) {
  const steps = [`Sent to ${placing.broker}`, "Confirmations answered (1)", "Verifying in order book…", `Live at ${placing.broker} · #${placing.ref} · Submitted`];
  const lastIdx = steps.length - 1;
  return (
    <ol className="grid gap-1.5 rounded-lg bg-muted/60 p-3" aria-live="polite">
      {steps.map((label, i) => {
        const state = i < placing.step || (i === placing.step && i === lastIdx) ? "done" : i === placing.step ? "active" : "todo";
        return (
          <li key={label} className={cn("flex items-center gap-2 text-xs", state === "todo" && "text-muted-foreground", state === "done" && i === lastIdx && "font-medium text-gain-foreground")}>
            {state === "done" ? <CheckIcon className="size-3.5 text-gain-foreground" aria-hidden="true" /> : state === "active" ? <LoaderCircleIcon className="size-3.5 animate-spin text-primary" aria-hidden="true" /> : <span className="inline-block size-3.5 rounded-full border border-input" aria-hidden="true" />}
            {label}
          </li>
        );
      })}
    </ol>
  );
}
