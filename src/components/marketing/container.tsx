import { LogoMark } from "@/components/brand/logo";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/** 80rem column with a fluid gutter. */
export function Container({ className, children, narrow = false }: { className?: string; children: React.ReactNode; narrow?: boolean }) {
  return <div className={cn("mx-auto w-full px-[clamp(1rem,4vw,3rem)]", narrow ? "max-w-3xl" : "max-w-[80rem]", className)}>{children}</div>;
}

/** A page band separated by a hairline. `tone="band"` sets it on the darker paper. */
export function Section({ id, className, children, tone = "plain" }: { id?: string; className?: string; children: React.ReactNode; tone?: "plain" | "band" }) {
  return (
    <section id={id} className={cn("relative scroll-mt-20 border-t border-border py-20 first:border-t-0 sm:py-28", tone === "band" && "bg-site-band", className)}>
      {children}
    </section>
  );
}

/** Spaced uppercase label with an optional accent section number: "01  THE PLATFORM". */
export function Eyebrow({ children, index, className }: { children: React.ReactNode; index?: number; className?: string }) {
  return (
    <span className={cn("site-label inline-flex items-baseline gap-3 text-foreground", className)}>
      {index !== undefined ? <span className="font-mono tracking-normal text-site-accent-ink tabular">{String(index).padStart(2, "0")}</span> : null}
      <span>{children}</span>
    </span>
  );
}

/**
 * Section heading: eyebrow, a large serif title (wrap the emphasis word in <em>) and an optional lede. Reveals on scroll.
 * `as="h1"` on the section that opens a page, so every page has exactly one top-level heading.
 */
export function SectionHead({
  eyebrow,
  index,
  title,
  lede,
  className,
  as: Heading = "h2",
}: {
  eyebrow?: string;
  index?: number;
  title: React.ReactNode;
  lede?: React.ReactNode;
  className?: string;
  as?: "h1" | "h2";
}) {
  return (
    <div className={cn("mb-12 grid max-w-3xl gap-5 sm:mb-16", className)} {...reveal()}>
      {eyebrow ? <Eyebrow index={index}>{eyebrow}</Eyebrow> : null}
      <Heading className="text-5xl leading-[0.98] text-balance sm:text-6xl [&_em]:italic">{title}</Heading>
      {lede ? <p className="max-w-[40rem] text-lg leading-relaxed text-pretty text-muted-foreground">{lede}</p> : null}
    </div>
  );
}

/**
 * Opening band for inner pages: eyebrow, serif title, lede and actions on the left; an optional card (`aside`) on a
 * dot-grid panel to the right. Everything rises in on load, no scroll needed.
 */
export function PageHero({
  eyebrow,
  title,
  lede,
  actions,
  aside,
  children,
  className,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  aside?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("relative border-b border-border py-16 sm:py-24", className)}>
      <Container className={cn("grid gap-12", aside && "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-center lg:gap-16")}>
        <div className="grid gap-7">
          <span className="animate-site-rise">
            <Eyebrow>{eyebrow}</Eyebrow>
          </span>
          <h1 className="animate-site-rise text-6xl leading-[0.92] text-balance sm:text-7xl lg:text-[5.5rem] [&_em]:italic" style={{ "--d": "80ms" } as React.CSSProperties}>
            {title}
          </h1>
          {lede ? (
            <p className="max-w-[36rem] animate-site-rise text-lg leading-relaxed text-pretty text-muted-foreground" style={{ "--d": "160ms" } as React.CSSProperties}>
              {lede}
            </p>
          ) : null}
          {actions ? (
            <div className="flex animate-site-rise flex-wrap items-center gap-x-7 gap-y-3" style={{ "--d": "240ms" } as React.CSSProperties}>
              {actions}
            </div>
          ) : null}
          {children ? (
            <div className="animate-site-rise" style={{ "--d": "320ms" } as React.CSSProperties}>
              {children}
            </div>
          ) : null}
        </div>
        {aside ? (
          <DotPanel className="animate-site-rise" style={{ "--d": "200ms" } as React.CSSProperties}>
            <div className="mx-auto w-full max-w-md">{aside}</div>
          </DotPanel>
        ) : null}
      </Container>
    </section>
  );
}

/** White panel with a dot grid and a soft border, the surface the charts and hero cards sit on. */
export function DotPanel({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div
      {...rest}
      className={cn("dotgrid rounded-[1.75rem] border border-border bg-card p-6 shadow-[0_30px_80px_-50px_color-mix(in_oklab,var(--primary)_55%,transparent)] sm:p-10", className)}
    >
      {children}
    </div>
  );
}

/** Raised card: square, hairline, a faint lift. */
export function PaperCard({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div {...rest} className={cn("border border-border bg-card text-card-foreground shadow-[0_24px_60px_-40px_color-mix(in_oklab,var(--site-ink)_60%,transparent)]", className)}>
      {children}
    </div>
  );
}

/** Centered statement on the band surface: the mark, one big serif sentence and a mono caption line. */
export function Statement({ children, caption, className }: { children: React.ReactNode; caption?: string; className?: string }) {
  return (
    <section className={cn("border-t border-border bg-site-band py-24 sm:py-32", className)}>
      <Container className="grid justify-items-center gap-8 text-center" narrow>
        <span aria-hidden="true" {...reveal()}>
          <LogoMark size={44} className="rounded-[11px]" />
        </span>
        <p className="font-serif text-4xl leading-[1.05] text-balance sm:text-6xl [&_em]:italic" {...reveal(100)}>
          {children}
        </p>
        {caption ? (
          <p className="site-caption text-muted-foreground" {...reveal(200)}>
            {caption}
          </p>
        ) : null}
      </Container>
    </section>
  );
}
