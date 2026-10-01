"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import { PASSWORD_RULES, passwordScore } from "@/components/onboarding/schemas";
import { cn } from "@/lib/utils";

const LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"] as const;

/** Four-segment meter plus the rule checklist. Strength is carried by text as well as color. */
export function PasswordStrength({ password, id }: { password: string; id: string }) {
  const score = passwordScore(password);
  const label = password ? LABELS[score] : "Password rules";
  const tone = score <= 1 ? "bg-loss" : score === 2 ? "bg-warn" : "bg-gain";
  return (
    <div id={id} className="grid gap-2">
      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cn("h-1 flex-1 rounded-full bg-muted transition-colors", i < score && tone)} />
          ))}
        </div>
        <span className="text-xs font-medium text-muted-foreground tabular" aria-live="polite">
          {label}
        </span>
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {PASSWORD_RULES.map((r) => {
          const ok = r.test(password);
          return (
            <li key={r.id} className={cn("inline-flex items-center gap-1.5 text-xs", ok ? "text-foreground" : "text-muted-foreground")}>
              {ok ? <CheckIcon className="size-3.5 text-gain-foreground" aria-hidden="true" /> : <MinusIcon className="size-3.5" aria-hidden="true" />}
              {r.label}
              <span className="sr-only">{ok ? ", met" : ", not met"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
