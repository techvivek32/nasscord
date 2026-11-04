"use client";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export interface EnvironmentOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

/** Two or more environments as radio cards (IBKR Live or Paper, E*TRADE Production or Sandbox). */
export function EnvironmentChoice<T extends string>({
  name,
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  /** Builds the element ids only. */
  name: string;
  /** The group's accessible name, for example "IBKR environment". */
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: EnvironmentOption<T>[];
  disabled?: boolean;
}) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as T)} aria-label={label} className="grid gap-2 sm:grid-cols-2" disabled={disabled}>
      {options.map((o) => {
        const id = `${name}-${o.value}`;
        return (
          <Label
            key={o.value}
            htmlFor={id}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 font-normal transition-colors hover:bg-muted/60",
              value === o.value && "border-primary/60 bg-brand-soft/40",
            )}
          >
            <RadioGroupItem id={id} value={o.value} className="mt-0.5" />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </Label>
        );
      })}
    </RadioGroup>
  );
}
