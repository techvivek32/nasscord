import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CONNECTABLE_BROKERS } from "@/lib/brokers";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/marketing/container";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

interface Action {
  label: string;
  href: string;
}

/**
 * The cord, held still: the brokers that connect today on either side, joined to the Nasscord mark by dashed lines.
 * Decorative; the headline under it says the same thing in words.
 */
function StillCord() {
  const half = Math.ceil(CONNECTABLE_BROKERS.length / 2);
  const left = CONNECTABLE_BROKERS.slice(0, half);
  const right = CONNECTABLE_BROKERS.slice(half);
  const side = (brokers: typeof left, align: "left" | "right") => (
    <div className={cn("flex items-center gap-2", align === "right" && "flex-row-reverse")}>
      {brokers.map((b) => (
        <BrokerMark key={b.id} id={b.id} size="md" className="rounded-[9px]" />
      ))}
    </div>
  );
  return (
    <div aria-hidden="true" className="flex items-center justify-center">
      {side(left, "left")}
      <span className="mx-3 w-8 border-t border-dashed border-input sm:mx-4 sm:w-14" />
      <LogoMark size={56} className="rounded-[15px] shadow-[0_14px_30px_-12px_color-mix(in_oklab,var(--primary)_70%,transparent)]" />
      <span className="mx-3 w-8 border-t border-dashed border-input sm:mx-4 sm:w-14" />
      {side(right, "right")}
    </div>
  );
}

/**
 * Closing call to action: a centered card on the dot-grid band, with the still cord, a serif headline, one line of
 * copy, the actions and a short note. Actions default to Start free / Become a tenant.
 */
export function CtaBand({
  title = (
    <>
      Your brokers, on one <em>screen</em>.
    </>
  ),
  lede,
  primary = { label: "Start free", href: "/signup" },
  secondary = { label: "Become a tenant", href: "/tenants" },
  note = "Starter is free · No card required · Nothing is charged in this release",
}: {
  title?: React.ReactNode;
  lede?: string;
  primary?: Action;
  secondary?: Action | null;
  note?: string | null;
}) {
  return (
    <section className="dotgrid border-t border-border bg-site-band py-20 sm:py-28">
      <Container>
        <div
          className="mx-auto grid max-w-4xl justify-items-center gap-8 rounded-[1.75rem] border border-border bg-card px-6 py-14 text-center shadow-[0_30px_80px_-50px_color-mix(in_oklab,var(--primary)_55%,transparent)] sm:px-16 sm:py-20"
          {...reveal(0, "scale")}
        >
          <StillCord />
          <h2 className="max-w-3xl text-5xl leading-[0.98] text-balance sm:text-7xl [&_em]:italic">{title}</h2>
          <p className="max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
            {lede ?? "Sign up, connect Interactive Brokers or E*TRADE, and see every account, position, order and execution in one place."}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
            <Button size="lg" className="group/cta h-12 rounded-[2px] px-7 text-base" render={<Link href={primary.href} />}>
              {primary.label}
              <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-1" />
            </Button>
            {secondary ? (
              <Link href={secondary.href} className="site-link">
                {secondary.label}
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            ) : null}
          </div>
          {note ? <p className="site-caption border-t border-border pt-6 text-muted-foreground">{note}</p> : null}
        </div>
      </Container>
    </section>
  );
}
