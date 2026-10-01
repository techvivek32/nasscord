"use client";

import * as React from "react";
import { ENGINE_DEFAULTS, computeLevels, sizeByRisk } from "@/lib/engine";
import { fmtMoney, fmtPrice } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "Try it": how the terminal sizes a trade. Account size, entry and ATR in; stop, target and quantity out, using the
 * same engine functions as the order ticket (stop 2.2x ATR, target 0.72 R, 1% of net liquidation at risk).
 */
export function RiskCalculator({ defaults }: { defaults: { netLiq: number; entry: number; atr: number; symbol: string } }) {
  // Start from the exact account and alert values so the numbers match the alert shown elsewhere on the page.
  const [netLiq, setNetLiq] = React.useState(defaults.netLiq);
  const [entry, setEntry] = React.useState(defaults.entry);
  const [atrPct, setAtrPct] = React.useState((defaults.atr / defaults.entry) * 100);

  const atr = (entry * atrPct) / 100;
  const lv = computeLevels(entry, atr);
  const size = sizeByRisk(netLiq, 1, lv.entry, lv.stop);
  const reward = Math.round(size.qty * (lv.target - lv.entry) * 100) / 100;

  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,26rem)_1fr] lg:gap-16">
      <div className="grid content-start gap-8">
        <div className="grid gap-2">
          <p className="text-sm leading-relaxed text-muted-foreground">
            With <strong className="font-medium text-foreground">{fmtMoney(netLiq, { digits: 0 })}</strong> in the account and {defaults.symbol} at{" "}
            <strong className="font-medium text-foreground">${fmtPrice(entry)}</strong>, the ticket buys
          </p>
          <p className="text-[clamp(3.5rem,8vw,5.5rem)] leading-none tracking-[-0.035em] tabular" aria-live="polite">
            <span key={size.qty} className="inline-block animate-site-rise">
              {size.qty.toLocaleString("en-US")}
            </span>
            <span className="ml-3 font-serif text-3xl tracking-normal italic">shares</span>
          </p>
        </div>
        <dl className="grid grid-cols-2 border-t border-border">
          <div className="grid gap-1 border-r border-border py-4 pr-4">
            <dt className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden="true" className="size-2.5 bg-site-accent" />
              At risk to the stop
            </dt>
            <dd className="text-lg font-medium tabular">{fmtMoney(size.riskDollars, { digits: 0 })}</dd>
          </div>
          <div className="grid gap-1 py-4 pl-4">
            <dt className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden="true" className="size-2.5 bg-site-accent-soft" />
              Made at the target
            </dt>
            <dd className="text-lg font-medium tabular">{fmtMoney(reward, { digits: 0 })}</dd>
          </div>
        </dl>
        <Slider label="Account size" value={netLiq} min={5_000} max={250_000} step={500} onChange={setNetLiq} display={fmtMoney(netLiq, { digits: 0 })} />
        <div className="grid grid-cols-2 gap-6">
          <Slider label="Entry price" value={entry} min={5} max={1_000} step={0.1} onChange={(v) => setEntry(Math.round(v * 100) / 100)} display={`$${fmtPrice(entry)}`} />
          <Slider label="ATR, % of price" value={atrPct} min={0.3} max={5} step={0.05} onChange={(v) => setAtrPct(Math.round(v * 100) / 100)} display={`${atrPct.toFixed(2)}%`} />
        </div>
      </div>

      <figure className="grid content-start gap-4">
        <LevelsFigure entry={lv.entry} stop={lv.stop} target={lv.target} />
        <figcaption className="grid grid-cols-[auto_1fr] gap-4 border-t border-border pt-4 font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
          <span className="text-foreground">FIG. 1</span>
          <span>
            Stop at {ENGINE_DEFAULTS.atrStopMultiple}x ATR below entry ({fmtPrice(lv.stop)}), target at {ENGINE_DEFAULTS.rewardToRisk} R ({fmtPrice(lv.target)}). Quantity is sized so a
            stop-out costs 1% of net liquidation, capped at 95% of it{size.cappedByCash ? " (the cap applies here)" : ""}. Illustration, not advice.
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }) {
  const id = React.useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="grid gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="site-label">
          {label}
        </label>
        <span className="font-mono text-sm tabular">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        className={cn(
          "h-5 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none",
          "[&::-webkit-slider-runnable-track]:h-px [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--foreground)_var(--pct),var(--border)_var(--pct))]",
          "[&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:size-[15px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110",
          "[&::-moz-range-track]:h-px [&::-moz-range-track]:bg-border [&::-moz-range-progress]:h-px [&::-moz-range-progress]:bg-foreground [&::-moz-range-thumb]:size-[15px] [&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground",
          "focus-visible:[&::-webkit-slider-thumb]:ring-3 focus-visible:[&::-webkit-slider-thumb]:ring-ring/50",
        )}
      />
    </div>
  );
}

/** Price levels as a figure: the reward band (soft accent) above entry, the risk band (accent) below, and a path to target. */
function LevelsFigure({ entry, stop, target }: { entry: number; stop: number; target: number }) {
  const W = 760;
  const H = 320;
  const span = target - stop || 1;
  const min = stop - span * 0.45;
  const max = target + span * 0.35;
  const y = (p: number) => H - ((p - min) / (max - min)) * H;
  const x0 = 70;
  const x1 = W - 120;

  // A deterministic walk from entry that dips toward the stop, then climbs to the target.
  const pts: Array<[number, number]> = [];
  const n = 26;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const drift = entry + (target - entry) * Math.pow(t, 1.6) - (entry - stop) * 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.8)) * (1 - t);
    const wiggle = Math.sin(i * 2.1) * span * 0.035;
    pts.push([x0 + (x1 - x0) * t, y(drift + wiggle)]);
  }
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");

  const rows = [
    { k: "Target", v: target, tone: "text-foreground" },
    { k: "Entry", v: entry, tone: "text-foreground" },
    { k: "Stop", v: stop, tone: "text-site-accent-ink" },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H + 30}`} className="site-draw h-auto w-full" role="img" aria-label={`Entry ${fmtPrice(entry)}, stop ${fmtPrice(stop)}, target ${fmtPrice(target)}`}>
      <rect x={x0} y={y(target)} width={x1 - x0} height={y(entry) - y(target)} fill="var(--site-accent-soft)" opacity={0.85} className="transition-all duration-500" />
      <rect x={x0} y={y(entry)} width={x1 - x0} height={y(stop) - y(entry)} fill="var(--site-accent)" className="transition-all duration-500" />
      {rows.map((r) => (
        <g key={r.k}>
          <line x1={x0 - 10} x2={x1 + 10} y1={y(r.v)} y2={y(r.v)} stroke="var(--foreground)" strokeWidth={1} strokeDasharray={r.k === "Entry" ? undefined : "2 4"} />
          <text x={x1 + 18} y={y(r.v) + 4} className={cn("fill-current font-mono text-[12px]", r.tone)}>
            {r.k.toUpperCase()} {fmtPrice(r.v)}
          </text>
        </g>
      ))}
      <path d={line} fill="none" stroke="var(--foreground)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" style={{ "--site-path": 1400, strokeDasharray: 1400 } as React.CSSProperties} />
      <line x1={x0} x2={x1} y1={H + 4} y2={H + 4} stroke="var(--foreground)" strokeWidth={1.5} />
      <text x={x0} y={H + 24} className="fill-muted-foreground font-mono text-[12px]">
        Entry
      </text>
      <text x={x1} y={H + 24} textAnchor="end" className="fill-muted-foreground font-mono text-[12px]">
        Exit at target or stop
      </text>
    </svg>
  );
}
