import { cn } from "@/lib/utils";

export interface Step {
  title: string;
  body: React.ReactNode;
}

/** Numbered steps list with a hairline rail. Used for onboarding and "how it works" blocks. */
export function NumberedSteps({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn("grid gap-6", className)}>
      {steps.map((s, i) => (
        <li key={s.title} className="relative flex gap-4">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft font-heading text-sm font-semibold text-primary tabular">
            {i + 1}
          </span>
          {i < steps.length - 1 ? <span aria-hidden="true" className="absolute top-9 left-4 h-[calc(100%-1.25rem)] w-px bg-border" /> : null}
          <div className="grid gap-1 pt-1">
            <h3 className="text-base font-semibold">{s.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
