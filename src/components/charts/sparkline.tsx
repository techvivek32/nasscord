import { cn } from "@/lib/utils";

/**
 * Dependency-free SVG sparkline. Stroke 1.75, 12% area wash, end dot with a surface ring.
 * `color` accepts any CSS color, including `var(--gain)`.
 */
export function Sparkline({
  data,
  color = "var(--primary)",
  className,
  area = true,
  width = 96,
  height = 28,
}: {
  data: number[];
  color?: string;
  className?: string;
  area?: boolean;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return <span className={cn("inline-block", className)} style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const p = 3;
  const x = (i: number) => p + (i / (data.length - 1)) * (width - 2 * p);
  const y = (v: number) => p + (1 - (v - min) / range) * (height - 2 * p);
  const d = data.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const last = data[data.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn("block overflow-visible", className)} preserveAspectRatio="none" aria-hidden="true">
      {area ? <path d={`${d}L${x(data.length - 1).toFixed(1)} ${height - p}L${x(0).toFixed(1)} ${height - p}Z`} fill={color} fillOpacity={0.12} /> : null}
      <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(data.length - 1)} cy={y(last)} r={3} fill={color} stroke="var(--card)" strokeWidth={1.5} />
    </svg>
  );
}
