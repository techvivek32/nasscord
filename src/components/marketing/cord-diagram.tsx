import { getBroker } from "@/lib/brokers";
import type { BrokerId } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEFT: BrokerId[] = ["ibkr", "schwab", "etrade", "tastytrade", "alpaca", "tradestation"];
const OUTPUTS = ["Alerts", "Verified orders", "Positions & P&L"];

const NODE = 44;
const NODE_X = 28;
const HUB = { cx: 300, cy: 210, size: 80 };
const PILL = { x: 412, w: 150, h: 40 };

/* Scoped to the SVG. Transforms use the element's own box so pop and ring animations stay centred. */
const CORD_CSS = `
@keyframes cord-flow{to{stroke-dashoffset:-168}}
@keyframes cord-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes cord-ring{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(1.7)}}
@keyframes cord-lit{0%,100%{opacity:0}12%,40%{opacity:1}}
@keyframes cord-draw{from{stroke-dashoffset:520}to{stroke-dashoffset:0}}
.cord-flow{stroke-dasharray:12 156;animation:cord-flow 4.2s linear infinite}
.cord-wire{stroke-dasharray:520;animation:cord-draw 1.4s cubic-bezier(.2,.7,.2,1) both}
.cord-pop{transform-box:fill-box;transform-origin:center;animation:cord-pop .6s cubic-bezier(.2,.9,.3,1.3) both}
.cord-ring{transform-box:fill-box;transform-origin:center;animation:cord-ring 3s cubic-bezier(0,0,.2,1) infinite}
.cord-lit{animation:cord-lit 4.2s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.cord-flow,.cord-wire,.cord-pop,.cord-ring,.cord-lit{animation:none}.cord-lit{opacity:0}}
`;

/**
 * The "cord" chart: six broker monograms feed one Nasscord hub, which fans out into alerts, verified orders and the
 * combined positions view. Wires draw themselves in, signals flow along them, the hub pulses and each output lights
 * up as a signal arrives. Colors come from tokens (the broker tiles use the registry colors), so it follows the theme.
 */
export function CordDiagram({ className }: { className?: string }) {
  const hubLeft = HUB.cx - HUB.size / 2;
  const hubRight = HUB.cx + HUB.size / 2;
  const leftYs = LEFT.map((_, i) => 46 + i * 66);
  const rightYs = [128, 210, 292];

  const inPath = (y: number) => `M${NODE_X + NODE} ${y} C ${NODE_X + NODE + 96} ${y}, ${hubLeft - 84} ${HUB.cy}, ${hubLeft} ${HUB.cy}`;
  const outPath = (y: number) => `M${hubRight} ${HUB.cy} C ${hubRight + 44} ${HUB.cy}, ${PILL.x - 40} ${y}, ${PILL.x} ${y}`;

  return (
    <svg viewBox="0 0 580 420" role="img" aria-labelledby="cord-title cord-desc" className={cn("block h-auto w-full overflow-visible", className)}>
      <title id="cord-title">How Nasscord connects your brokers</title>
      <desc id="cord-desc">
        Six broker connections flow into one Nasscord hub, which produces alerts, verified orders and a combined positions and P&amp;L view.
      </desc>
      <style>{CORD_CSS}</style>

      {/* inbound cords */}
      {leftYs.map((y, i) => (
        <g key={LEFT[i]}>
          <path d={inPath(y)} fill="none" stroke="var(--input)" strokeWidth={1.5} className="cord-wire" style={{ animationDelay: `${0.15 + i * 0.08}s` }} />
          <path d={inPath(y)} fill="none" stroke="var(--primary)" strokeWidth={2.5} strokeLinecap="round" className="cord-flow" style={{ animationDelay: `${i * 0.55}s` }} />
        </g>
      ))}

      {/* outbound cords */}
      {rightYs.map((y, i) => (
        <g key={OUTPUTS[i]}>
          <path d={outPath(y)} fill="none" stroke="var(--input)" strokeWidth={1.5} className="cord-wire" style={{ animationDelay: `${0.7 + i * 0.1}s` }} />
          <path d={outPath(y)} fill="none" stroke="var(--primary)" strokeWidth={2.5} strokeLinecap="round" className="cord-flow" style={{ animationDelay: `${1.2 + i * 0.7}s` }} />
        </g>
      ))}

      {/* broker nodes */}
      {LEFT.map((id, i) => {
        const b = getBroker(id);
        const y = leftYs[i];
        return (
          <g key={id} className="cord-pop" style={{ animationDelay: `${i * 0.07}s` }}>
            <rect x={NODE_X} y={y - NODE / 2} width={NODE} height={NODE} rx={11} fill={b.color} />
            <text x={NODE_X + NODE / 2} y={y + 5} textAnchor="middle" fontSize={14} fontWeight={700} letterSpacing="-0.02em" className="fill-white font-sans">
              {b.monogram}
            </text>
            <text x={NODE_X + NODE / 2} y={y + NODE / 2 + 14} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)" className="font-sans">
              {b.short}
            </text>
          </g>
        );
      })}

      {/* hub with pulse rings */}
      {[0, 1].map((r) => (
        <rect key={r} x={hubLeft} y={HUB.cy - HUB.size / 2} width={HUB.size} height={HUB.size} rx={20} fill="none" stroke="var(--primary)" strokeWidth={1.5} className="cord-ring" style={{ animationDelay: `${r * 1.5}s` }} />
      ))}
      <g className="cord-pop" style={{ animationDelay: "0.45s" }}>
        <rect x={hubLeft} y={HUB.cy - HUB.size / 2} width={HUB.size} height={HUB.size} rx={20} fill="var(--primary)" />
        <g transform={`translate(${HUB.cx - 24} ${HUB.cy - 24}) scale(3)`}>
          <path d="M2 12V4l6 8V4l6 8" stroke="var(--primary-foreground)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
      </g>
      <text x={HUB.cx} y={HUB.cy + HUB.size / 2 + 24} textAnchor="middle" fontSize={15} fontWeight={600} letterSpacing="-0.01em" fill="var(--foreground)" className="font-sans">
        Nasscord
      </text>
      <text x={HUB.cx} y={HUB.cy + HUB.size / 2 + 41} textAnchor="middle" fontSize={10.5} fill="var(--muted-foreground)" className="font-sans">
        one session per broker
      </text>

      {/* output pills, lit in turn as the signal arrives */}
      {OUTPUTS.map((label, i) => {
        const y = rightYs[i];
        return (
          <g key={label} className="cord-pop" style={{ animationDelay: `${0.9 + i * 0.1}s` }}>
            <rect x={PILL.x} y={y - PILL.h / 2} width={PILL.w} height={PILL.h} rx={PILL.h / 2} fill="var(--card)" stroke="var(--border)" />
            <rect x={PILL.x} y={y - PILL.h / 2} width={PILL.w} height={PILL.h} rx={PILL.h / 2} fill="none" stroke="var(--primary)" strokeWidth={1.5} className="cord-lit" style={{ animationDelay: `${1.9 + i * 0.7}s` }} />
            <circle cx={PILL.x + 20} cy={y} r={4} fill="var(--primary)" />
            <text x={PILL.x + 34} y={y + 4.5} fontSize={13} fontWeight={500} fill="var(--foreground)" className="font-sans">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The chart on its card, as on the original Nasscord site: white surface, soft border, dot grid. */
export function CordCard({ className }: { className?: string }) {
  return (
    <div className={cn("dotgrid rounded-[1.75rem] border border-border bg-card p-3 shadow-[0_30px_80px_-50px_color-mix(in_oklab,var(--primary)_55%,transparent)] sm:p-6", className)}>
      <CordDiagram />
    </div>
  );
}
