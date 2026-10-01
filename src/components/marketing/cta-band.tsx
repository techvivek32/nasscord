import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/marketing/container";

interface Action {
  label: string;
  href: string;
}

/** Closing call to action band. Left-aligned, token colors only. Actions default to Start free / Become a tenant. */
export function CtaBand({
  title = "Your brokers, one terminal.",
  lede,
  primary = { label: "Start free", href: "/signup" },
  secondary = { label: "Become a tenant", href: "/tenants" },
}: {
  title?: string;
  lede?: string;
  primary?: Action;
  secondary?: Action | null;
}) {
  return (
    <Container className="pb-16 sm:pb-24">
      <div className="grid gap-6 rounded-2xl bg-primary px-6 py-10 text-primary-foreground sm:px-10 sm:py-14 lg:grid-cols-[1fr_auto] lg:items-center">
        <div className="grid gap-2">
          <h2 className="text-3xl font-semibold tracking-tight text-primary-foreground sm:text-4xl">{title}</h2>
          <p className="max-w-xl text-base text-primary-foreground/80">
            {lede ?? "Connect your first broker in about two minutes. The Starter plan is free and needs no card."}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" variant="secondary" render={<Link href={primary.href} />}>
            {primary.label}
          </Button>
          {secondary ? (
            <Button
              size="lg"
              variant="outline"
              className="border-primary-foreground/40 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground dark:border-primary-foreground/40 dark:bg-transparent dark:hover:bg-primary-foreground/10"
              render={<Link href={secondary.href} />}
            >
              {secondary.label}
            </Button>
          ) : null}
        </div>
      </div>
    </Container>
  );
}
