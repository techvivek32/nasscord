"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const LENGTH = 6;

/**
 * Six single-digit boxes that behave like one field: typing advances, Backspace retreats,
 * arrows move, paste fills. `onComplete` fires once all six digits are present.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  describedBy,
  autoFocus = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete?: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  const refs = React.useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: LENGTH }, (_, i) => value[i] ?? "");

  const focusAt = (i: number) => refs.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus();

  const commit = (next: string) => {
    onChange(next);
    if (next.length === LENGTH && onComplete) onComplete(next);
  };

  const setDigit = (i: number, d: string) => {
    const arr = [...digits];
    arr[i] = d;
    commit(arr.join("").slice(0, LENGTH));
  };

  return (
    <div className="flex gap-2" role="group" aria-label="Six digit verification code" aria-describedby={describedBy}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={d}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of ${LENGTH}`}
          aria-invalid={invalid || undefined}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => {
            const raw = e.target.value.replace(/\D/g, "");
            if (!raw) {
              setDigit(i, "");
              return;
            }
            if (raw.length > 1) {
              // A paste or autofill landed in one box; spread it from here.
              const merged = (value.slice(0, i) + raw).slice(0, LENGTH);
              commit(merged);
              focusAt(merged.length >= LENGTH ? LENGTH - 1 : merged.length);
              return;
            }
            setDigit(i, raw);
            if (i < LENGTH - 1) focusAt(i + 1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              if (digits[i]) {
                setDigit(i, "");
              } else if (i > 0) {
                e.preventDefault();
                setDigit(i - 1, "");
                focusAt(i - 1);
              }
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              focusAt(i - 1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              focusAt(i + 1);
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").replace(/\D/g, "");
            if (!text) return;
            e.preventDefault();
            const merged = (value.slice(0, i) + text).slice(0, LENGTH);
            commit(merged);
            focusAt(merged.length >= LENGTH ? LENGTH - 1 : merged.length);
          }}
          onFocus={(e) => e.target.select()}
          className={cn(
            "h-11 w-10 rounded-lg border border-input bg-transparent text-center font-mono text-lg tabular transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:w-11 dark:bg-input/30",
          )}
        />
      ))}
    </div>
  );
}
