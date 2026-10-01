import { cn } from "@/lib/utils";

export function Container({ className, children, narrow = false }: { className?: string; children: React.ReactNode; narrow?: boolean }) {
  return <div className={cn("mx-auto w-full px-4 sm:px-6 lg:px-10", narrow ? "max-w-3xl" : "max-w-6xl", className)}>{children}</div>;
}

export function Section({ id, className, children }: { id?: string; className?: string; children: React.ReactNode }) {
  return (
    <section id={id} className={cn("scroll-mt-20 border-t border-border py-16 first:border-t-0 sm:py-24", className)}>
      {children}
    </section>
  );
}

/** `as="h1"` on the section that opens a page, so every page has exactly one top-level heading. */
export function SectionHead({ eyebrow, title, lede, className, as: Heading = "h2" }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; className?: string; as?: "h1" | "h2" }) {
  return (
    <div className={cn("mb-10 grid max-w-2xl gap-3 sm:mb-12", className)}>
      {eyebrow ? <span className="text-xs font-semibold tracking-[0.1em] text-primary uppercase">{eyebrow}</span> : null}
      <Heading className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</Heading>
      {lede ? <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">{lede}</p> : null}
    </div>
  );
}
