"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useBacktest } from "@/hooks/queries";
import { computeLevels } from "@/lib/engine";
import { fmtNum, fmtPrice } from "@/lib/format";
import type { EngineParams } from "@/lib/types";
import { ControlRow, KV, SectionTitle } from "./primitives";
import { useConsoleStore } from "./store";

const TIMEFRAMES = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
];

const schema = z.object({
  timeframe: z.enum(["5m", "15m", "1h"]),
  minScore: z.coerce.number({ error: "Enter a score." }).int("Whole numbers only.").min(50, "Below 50 the scanner fires on noise.").max(95, "Above 95 nothing qualifies."),
  maxOpen: z.coerce.number({ error: "Enter a count." }).int("Whole numbers only.").min(1, "At least 1.").max(20, "Cap is 20 concurrent setups."),
  atrStopMultiple: z.coerce.number({ error: "Enter a multiple." }).min(0.5, "At least 0.5x ATR.").max(5, "At most 5x ATR."),
  rewardToRisk: z.coerce.number({ error: "Enter a ratio." }).min(0.25, "At least 0.25.").max(5, "At most 5."),
  trailToBreakeven: z.boolean(),
  newsModelMarketHoursOnly: z.boolean(),
});
type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

export function EnginePage() {
  const params = useConsoleStore((s) => s.engineParams);
  const setParams = useConsoleStore((s) => s.setEngineParams);
  const universe = useConsoleStore((s) => s.universe);
  const [universeOpen, setUniverseOpen] = React.useState(false);
  // Remount the dialog each time it opens so its draft starts from the saved universe.
  const [universeSession, setUniverseSession] = React.useState(0);
  const openUniverse = () => {
    setUniverseSession((n) => n + 1);
    setUniverseOpen(true);
  };

  const form = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      timeframe: params.timeframe,
      minScore: params.minScore,
      maxOpen: params.maxOpen,
      atrStopMultiple: params.atrStopMultiple,
      rewardToRisk: params.rewardToRisk,
      trailToBreakeven: params.trailToBreakeven,
      newsModelMarketHoursOnly: params.newsModelMarketHoursOnly,
    },
  });
  const { errors, isDirty, isSubmitting } = form.formState;

  const [atrRaw, rrRaw] = useWatch({ control: form.control, name: ["atrStopMultiple", "rewardToRisk"] });
  const preview = React.useMemo(() => {
    const atr = Number(atrRaw);
    const rr = Number(rrRaw);
    if (!Number.isFinite(atr) || !Number.isFinite(rr) || atr <= 0 || rr <= 0) return null;
    return computeLevels(100, 1.5, { ...params, atrStopMultiple: atr, rewardToRisk: rr });
  }, [atrRaw, rrRaw, params]);

  async function onSubmit(v: FormValues) {
    await new Promise((r) => setTimeout(r, 300));
    const next: EngineParams = { ...v, universeSize: universe.length };
    setParams(next);
    form.reset(v);
    toast.success("Engine parameters saved", { description: `Applies from the next 15-minute scan. Open setups keep their current stops.` });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Parameters</CardTitle>
          <CardDescription>TradeScope scan settings for every tenant. Defaults are the measured production values from September 2026.</CardDescription>
          <CardAction>
            <Button type="submit" form="engine-form" size="sm" disabled={!isDirty || isSubmitting}>
              {isSubmitting ? "Saving" : "Save"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <form id="engine-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="engine-universe">Universe size</Label>
                <div className="flex gap-2">
                  <Input id="engine-universe" value={`${universe.length} symbols`} readOnly className="font-mono tabular" />
                  <Button type="button" variant="outline" onClick={openUniverse}>
                    Edit universe
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Large-cap US equities scanned each bar.</p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="engine-timeframe">Timeframe</Label>
                <Controller
                  control={form.control}
                  name="timeframe"
                  render={({ field }) => (
                    <Select items={TIMEFRAMES} value={field.value} onValueChange={(v) => v && field.onChange(v)}>
                      <SelectTrigger id="engine-timeframe" className="w-full" onBlur={field.onBlur}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEFRAMES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <p className="text-xs text-muted-foreground">Bar size for RSI, ADX and relative volume.</p>
              </div>
              <NumberField id="engine-minscore" label="Minimum score" help="Setups below this score are logged, not sent." error={errors.minScore?.message} {...form.register("minScore")} min={50} max={95} step={1} />
              <NumberField id="engine-maxopen" label="Max open setups" help="Concurrent alerts per tenant across all accounts." error={errors.maxOpen?.message} {...form.register("maxOpen")} min={1} max={20} step={1} />
              <NumberField id="engine-atr" label="ATR stop multiple" help="Stop = entry minus this many ATRs." error={errors.atrStopMultiple?.message} {...form.register("atrStopMultiple")} min={0.5} max={5} step={0.1} />
              <NumberField id="engine-rr" label="Reward to risk" help="Target = entry plus this share of the risk." error={errors.rewardToRisk?.message} {...form.register("rewardToRisk")} min={0.25} max={5} step={0.01} />
            </div>

            {preview ? (
              <div className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                Worked example at entry $100.00 with ATR 1.50: stop <span className="font-mono text-foreground tabular">{fmtPrice(preview.stop)}</span> ({preview.stopPct}%), target{" "}
                <span className="font-mono text-foreground tabular">{fmtPrice(preview.target)}</span> (+{preview.targetPct}%).
              </div>
            ) : null}

            <div className="divide-y divide-border border-t">
              <Controller
                control={form.control}
                name="trailToBreakeven"
                render={({ field }) => (
                  <ControlRow id="engine-trail" label="Trail stop to breakeven" help="Once price covers 1R the stop moves to entry.">
                    <Switch id="engine-trail" checked={field.value} onCheckedChange={field.onChange} />
                  </ControlRow>
                )}
              />
              <Controller
                control={form.control}
                name="newsModelMarketHoursOnly"
                render={({ field }) => (
                  <ControlRow id="engine-news" label="News model during market hours only" help="Skip headline sentiment scoring outside 09:30–16:00 ET to save inference cost.">
                    <Switch id="engine-news" checked={field.value} onCheckedChange={field.onChange} />
                  </ControlRow>
                )}
              />
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Live status</CardTitle>
            <CardDescription>Current scan cycle.</CardDescription>
          </CardHeader>
          <CardContent>
            <KV
              items={[
                { label: "Last scan", value: "14:45 ET" },
                { label: "Next scan", value: "15:00 ET" },
                { label: "Open setups", value: "5 of " + params.maxOpen },
                { label: "Alerts sent today", value: fmtNum(2_310) },
                { label: "Mailer queue", value: "0" },
                { label: "Universe", value: `${universe.length} symbols · ${params.timeframe}` },
              ]}
            />
          </CardContent>
        </Card>
        <RealityCheck />
      </div>

      <UniverseDialog key={universeSession} open={universeOpen} onOpenChange={setUniverseOpen} />
    </div>
  );
}

const NumberField = React.forwardRef<HTMLInputElement, React.ComponentProps<"input"> & { id: string; label: string; help?: string; error?: string }>(function NumberField({ id, label, help, error, ...props }, ref) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} ref={ref} type="number" inputMode="decimal" className="font-mono tabular" aria-invalid={!!error} aria-describedby={error ? `${id}-err` : help ? `${id}-help` : undefined} {...props} />
      {error ? (
        <p id={`${id}-err`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : help ? (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  );
});

function RealityCheck() {
  const bt = useBacktest();
  const s = bt.data?.stats;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reality check</CardTitle>
        <CardDescription>Backtest at {s ? `${s.riskPerTrade}%` : "0.5%"} risk per trade with the current defaults.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!s ? (
          <div className="grid gap-2" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : (
          <>
            <KV
              items={[
                { label: "Trades", value: `${s.trades} (${s.wins}W / ${s.losses}L / ${s.scratches}S)` },
                { label: "Win rate", value: `${s.winRate}%` },
                { label: "Avg win / avg loss", value: `${s.avgWinR}R / ${s.avgLossR}R` },
                { label: "Profit factor", value: <span className={s.profitFactor < 1 ? "text-loss-foreground" : "text-gain-foreground"}>{s.profitFactor.toFixed(2)}</span> },
                { label: "Expectancy", value: <span className={s.expectancyR < 0 ? "text-loss-foreground" : "text-gain-foreground"}>{s.expectancyR.toFixed(3)}R</span> },
                { label: "Total return", value: <span className={s.totalReturnPct < 0 ? "text-loss-foreground" : "text-gain-foreground"}>{s.totalReturnPct}%</span> },
                { label: "Max drawdown", value: `${s.maxDrawdownPct}%` },
                { label: "Max consecutive losses", value: String(s.maxConsecLosses) },
              ]}
            />
            <p className="text-xs text-muted-foreground">
              With a {s.avgWinR}R average win against a 1R loss, a {s.winRate}% hit rate is not enough for a positive expectancy. The engine is a signal source for traders who add their own judgment, not an automated strategy, and the marketing copy says so. Lifetime live record: {bt.data?.lifetime.wins}W / {bt.data?.lifetime.losses}L / {bt.data?.lifetime.scratches}S.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UniverseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const universe = useConsoleStore((s) => s.universe);
  const setUniverse = useConsoleStore((s) => s.setUniverse);
  const [draft, setDraft] = React.useState<string[]>(universe);
  const [input, setInput] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const add = () => {
    const sym = input.trim().toUpperCase();
    if (!/^[A-Z]{1,5}$/.test(sym)) {
      setError("Tickers are 1 to 5 letters.");
      return;
    }
    if (draft.includes(sym)) {
      setError(`${sym} is already in the universe.`);
      return;
    }
    setDraft((d) => [...d, sym]);
    setInput("");
    setError(null);
  };

  const changed = draft.length !== universe.length || draft.some((s, i) => s !== universe[i]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Scan universe</DialogTitle>
          <DialogDescription>{draft.length} symbols. Removing a symbol closes nothing; open setups on it run to their stop or target.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1.5" role="list" aria-label="Universe symbols">
            {draft.map((sym) => (
              <Badge key={sym} variant="outline" className="h-6 gap-1 pr-1 font-mono" role="listitem">
                {sym}
                <button type="button" onClick={() => setDraft((d) => d.filter((s) => s !== sym))} aria-label={`Remove ${sym}`} className="rounded-full p-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none">
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="grid gap-1.5">
            <SectionTitle>Add symbol</SectionTitle>
            <div className="flex gap-2">
              <Input
                aria-label="Ticker symbol"
                value={input}
                placeholder="e.g. SHOP"
                maxLength={5}
                className="font-mono uppercase"
                aria-invalid={!!error}
                onChange={(e) => {
                  setInput(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <Button type="button" variant="outline" onClick={add}>
                Add
              </Button>
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!changed || draft.length === 0}
            onClick={() => {
              setUniverse(draft);
              onOpenChange(false);
              toast.success(`Universe updated to ${draft.length} symbols`);
            }}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
