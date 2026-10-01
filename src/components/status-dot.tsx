import { cn } from "@/lib/utils";

type Tone = "good" | "warn" | "bad" | "neutral" | "brand";

const DOT: Record<Tone, string> = {
  good: "bg-gain",
  warn: "bg-warn",
  bad: "bg-loss",
  neutral: "bg-muted-foreground/60",
  brand: "bg-primary",
};

/** Small status indicator: dot + label. Meaning is always carried by the label text too. */
export function StatusDot({ tone, label, pulse = false, className }: { tone: Tone; label: React.ReactNode; pulse?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm font-medium", className)}>
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])}>
        {pulse ? <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", DOT[tone])} /> : null}
      </span>
      {label}
    </span>
  );
}

export const TONE_BADGE: Record<Tone, string> = {
  good: "bg-gain-soft text-gain-foreground",
  warn: "bg-warn-soft text-warn-foreground",
  bad: "bg-loss-soft text-loss-foreground",
  neutral: "bg-muted text-muted-foreground",
  brand: "bg-brand-soft text-primary",
};
