import { getBroker } from "@/lib/brokers";
import type { BrokerId } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEFT: BrokerId[] = ["ibkr", "schwab", "etrade", "tastytrade", "alpaca", "tradestation"];
const OUTPUTS = ["Alerts", "Verified orders", "Positions & P&L"];

const NODE = 40;
const NODE_X = 24;
const HUB = { cx: 300, cy: 210, size: 72 };
const PILL = { x: 410, w: 140, h: 36 };

const FLOW_CSS = "@keyframes cord-flow{to{stroke-dashoffset:-168}}.cord-flow{stroke-dasharray:12 156;animation:cord-flow 4.2s linear infinite}";

/**
 * The signature "cord" diagram: broker monograms on the left feed one Nasscord hub, which fans out into
 * alerts, verified orders and positions. Every color except the broker tiles comes from a CSS token, so the
 * drawing follows the theme (and a white-label accent) automatically. The flowing dash respects reduced motion
 * through the global rule in globals.css.
 */
export function CordDiagram({ className }: { className?: string }) {
  const hubLeft = HUB.cx - HUB.size / 2;
  const hubRight = HUB.cx + HUB.size / 2;
  const leftYs = LEFT.map((_, i) => 50 + i * 64);
  const rightYs = [130, 210, 290];

  const inPath = (y: number) => `M${NODE_X + NODE} ${y} C ${NODE_X + NODE + 96} ${y}, ${hubLeft - 84} ${HUB.cy}, ${hubLeft} ${HUB.cy}`;
  const outPath = (y: number) => `M${hubRight} ${HUB.cy} C ${hubRight + 44} ${HUB.cy}, ${PILL.x - 40} ${y}, ${PILL.x} ${y}`;

  return (
    <svg viewBox="0 0 560 420" role="img" aria-labelledby="cord-title cord-desc" className={cn("block h-auto w-full", className)}>
      <title id="cord-title">How Nasscord connects your brokers</title>
      <desc id="cord-desc">
        Six broker connections flow into one Nasscord hub, which produces alerts, verified orders and a combined positions and P&amp;L view.
      </desc>
      <style>{FLOW_CSS}</style>

      {/* inbound cords */}
      {leftYs.map((y, i) => (
        <g key={LEFT[i]}>
          <path d={inPath(y)} fill="none" stroke="var(--input)" strokeWidth={1.5} />
          <path
            d={inPath(y)}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinecap="round"
            className="cord-flow"
            style={{ animationDelay: `${i * 0.55}s` }}
          />
        </g>
      ))}

      {/* outbound cords */}
      {rightYs.map((y, i) => (
        <g key={OUTPUTS[i]}>
          <path d={outPath(y)} fill="none" stroke="var(--input)" strokeWidth={1.5} />
          <path
            d={outPath(y)}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinecap="round"
            className="cord-flow"
            style={{ animationDelay: `${1.2 + i * 0.7}s` }}
          />
        </g>
      ))}

      {/* broker nodes */}
      {LEFT.map((id, i) => {
        const b = getBroker(id);
        const y = leftYs[i];
        return (
          <g key={id}>
            <rect x={NODE_X} y={y - NODE / 2} width={NODE} height={NODE} rx={10} fill={b.color} />
            <text x={NODE_X + NODE / 2} y={y + 4.5} textAnchor="middle" fontSize={13} fontWeight={700} letterSpacing="-0.02em" className="fill-white font-heading">
              {b.monogram}
            </text>
            <text x={NODE_X + NODE / 2} y={y + NODE / 2 + 13} textAnchor="middle" fontSize={9.5} fill="var(--muted-foreground)" className="font-sans">
              {b.short}
            </text>
          </g>
        );
      })}

      {/* hub */}
      <rect x={hubLeft} y={HUB.cy - HUB.size / 2} width={HUB.size} height={HUB.size} rx={18} fill="var(--primary)" />
      <g transform={`translate(${HUB.cx - 20.8} ${HUB.cy - 20.8}) scale(2.6)`}>
        <path d="M2 12V4l6 8V4l6 8" stroke="var(--primary-foreground)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>
      <text x={HUB.cx} y={HUB.cy + HUB.size / 2 + 22} textAnchor="middle" fontSize={14} fontWeight={600} letterSpacing="-0.01em" fill="var(--foreground)" className="font-heading">
        Nasscord
      </text>
      <text x={HUB.cx} y={HUB.cy + HUB.size / 2 + 38} textAnchor="middle" fontSize={9.5} fill="var(--muted-foreground)" className="font-sans">
        one session per broker
      </text>

      {/* output pills */}
      {OUTPUTS.map((label, i) => {
        const y = rightYs[i];
        return (
          <g key={label}>
            <rect x={PILL.x} y={y - PILL.h / 2} width={PILL.w} height={PILL.h} rx={PILL.h / 2} fill="var(--card)" stroke="var(--border)" />
            <circle cx={PILL.x + 18} cy={y} r={3.5} fill="var(--primary)" />
            <text x={PILL.x + 30} y={y + 4} fontSize={12} fontWeight={500} fill="var(--foreground)" className="font-sans">
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
