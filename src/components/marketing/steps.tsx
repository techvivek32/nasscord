import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

export interface Step {
  title: string;
  body: React.ReactNode;
}

/** Steps as a ruled list: accent mono number, serif title, body. Used for "how it works" blocks. */
export function NumberedSteps({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <ol className={cn("border-t border-foreground", className)}>
      {steps.map((s, i) => (
        <li key={s.title} className="group/step grid gap-2 border-b border-border py-6 sm:grid-cols-[4rem_1fr] sm:gap-6" {...reveal(i * 90)}>
          <span aria-hidden="true" className="font-mono text-sm text-site-accent-ink tabular">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className="grid gap-1.5">
            <h3 className="text-3xl leading-tight transition-colors group-hover/step:text-site-accent-ink">{s.title}</h3>
            <p className="max-w-[40rem] leading-relaxed text-muted-foreground">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
