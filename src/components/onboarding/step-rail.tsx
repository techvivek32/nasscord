"use client";

import { CheckIcon } from "lucide-react";
import { STEPS, type WizardStep } from "@/components/onboarding/data";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

/** Desktop rail: numbered list with done / current / upcoming states. Completed steps are buttons. */
export function StepRail({ current, furthest, onSelect }: { current: WizardStep; furthest: WizardStep; onSelect: (step: WizardStep) => void }) {
  return (
    <nav aria-label="Setup steps">
      <ol className="grid gap-1">
        {STEPS.map((s) => {
          const state = s.id < current ? "done" : s.id === current ? "current" : "upcoming";
          const clickable = s.id <= furthest && s.id !== current && current !== 5;
          const inner = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular",
                  state === "done" && "bg-primary text-primary-foreground",
                  state === "current" && "border-2 border-primary text-primary",
                  state === "upcoming" && "border border-input text-muted-foreground",
                )}
              >
                {state === "done" ? <CheckIcon className="size-3.5" /> : s.id}
              </span>
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", state === "upcoming" && "text-muted-foreground")}>{s.title}</span>
                <span className="block text-xs text-muted-foreground">{s.description}</span>
              </span>
            </>
          );
          return (
            <li key={s.id} aria-current={state === "current" ? "step" : undefined}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {inner}
                  <span className="sr-only">, completed. Return to this step</span>
                </button>
              ) : (
                <div className={cn("flex items-center gap-3 rounded-lg px-2 py-2", state === "current" && "bg-brand-soft")}>{inner}</div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Mobile: compact "Title / Step n of 5" line with a progress bar. */
export function StepProgress({ current }: { current: WizardStep }) {
  const step = STEPS.find((s) => s.id === current) ?? STEPS[0];
  const pct = (current / STEPS.length) * 100;
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{step.title}</span>
        <span className="text-xs text-muted-foreground tabular">
          Step {current} of {STEPS.length}
        </span>
      </div>
      <Progress value={pct} aria-label={`Setup progress: step ${current} of ${STEPS.length}`} />
    </div>
  );
}
