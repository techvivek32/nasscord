import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { brokerNames, publicBrokers, type PublicBroker } from "@/lib/server/broker-availability";
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

/** At most this many monograms on the cord from md up (three a side); one a side below md, so it fits 375px. */
const MAX_MARKS = 6;

/**
 * The cord, held still: the brokers that connect today on either side, joined to the Nasscord mark by dashed lines.
 * Decorative; the headline under it says the same thing in words.
 */
function StillCord({ brokers }: { brokers: PublicBroker[] }) {
  const shown = brokers.slice(0, MAX_MARKS);
  const half = Math.ceil(shown.length / 2);
  const left = shown.slice(0, half);
  const right = shown.slice(half);
  // How many brokers a "+N" stands for: on phones every one past the first of each side, from md up those past MAX_MARKS.
  const restPhone = brokers.length - Math.min(left.length, 1) - Math.min(right.length, 1);
  const restWide = brokers.length - shown.length;
  const side = (list: PublicBroker[], align: "left" | "right", more = false) => (
    <div className={cn("flex items-center gap-2", align === "right" && "flex-row-reverse")}>
      {list.map((b, i) => (
        <BrokerMark key={b.id} id={b.id} size="md" className={cn("rounded-[9px]", i > 0 && "hidden md:inline-grid")} />
      ))}
      {more && restPhone > 0 ? <span className="font-mono text-xs text-muted-foreground tabular md:hidden">+{restPhone}</span> : null}
      {more && restWide > 0 ? <span className="hidden font-mono text-xs text-muted-foreground tabular md:inline">+{restWide}</span> : null}
    </div>
  );
  return (
    <div aria-hidden="true" className="flex items-center justify-center">
      {side(left, "left")}
      <span className="mx-3 w-8 border-t border-dashed border-input sm:mx-4 sm:w-14" />
      <LogoMark size={56} className="rounded-[15px] shadow-[0_14px_30px_-12px_color-mix(in_oklab,var(--primary)_70%,transparent)]" />
      <span className="mx-3 w-8 border-t border-dashed border-input sm:mx-4 sm:w-14" />
      {side(right, "right", true)}
    </div>
  );
}

/**
 * Closing call to action: a centered card on the dot-grid band, with the still cord, a serif headline, one line of
 * copy, the actions and a short note. Actions default to Sign up / Become a tenant. The brokers on the cord and in
 * the default line are the ones that connect for everyone today (the broker service's answer, see publicBrokers).
 */
export async function CtaBand({
  title = (
    <>
      Your brokers, on one <em>screen</em>.
    </>
  ),
  lede,
  primary = { label: "Sign up", href: "/signup" },
  secondary = { label: "Become a tenant", href: "/tenants" },
  note = "No card required · Custody stays at your broker",
}: {
  title?: React.ReactNode;
  lede?: string;
  primary?: Action;
  secondary?: Action | null;
  note?: string | null;
}) {
  const { today } = await publicBrokers();
  const connect = today.length && today.length <= 3 ? `connect ${brokerNames(today, { joiner: "or" })}` : "connect your brokers";
  return (
    <section className="dotgrid border-t border-border bg-site-band py-20 sm:py-28">
      <Container>
        <div
          className="mx-auto grid max-w-4xl justify-items-center gap-8 rounded-[1.75rem] border border-border bg-card px-6 py-14 text-center shadow-[0_30px_80px_-50px_color-mix(in_oklab,var(--primary)_55%,transparent)] sm:px-16 sm:py-20"
          {...reveal(0, "scale")}
        >
          <StillCord brokers={today} />
          <h2 className="max-w-3xl text-5xl leading-[0.98] text-balance sm:text-7xl [&_em]:italic">{title}</h2>
          <p className="max-w-xl text-lg leading-relaxed text-pretty text-muted-foreground">
            {lede ?? `Sign up, ${connect}, and see every account, position, order and execution in one place.`}
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
