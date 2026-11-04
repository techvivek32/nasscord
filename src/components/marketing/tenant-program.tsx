import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { COMMISSION_PCT, WHITE_LABEL_FEE } from "@/lib/plans";
import { EXAMPLE_BRANDING, TENANT_ANCHOR, TENANT_OFFER_BADGE, WhiteLabelPreview } from "@/components/marketing/tenant-offers";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/*
 * The tenant program on the home page: the two offers as term sheets, commission for every tenant and white-label as
 * the add-on. Server component. Terms say plainly what works in this release; billing and payouts are not on yet.
 */

interface TermSheet {
  id: keyof typeof TENANT_ANCHOR;
  title: React.ReactNode;
  summary: string;
  terms: Array<[string, string]>;
  link: string;
}

const SHEETS: TermSheet[] = [
  {
    id: "commission",
    title: "Commission",
    summary: "Every tenant gets it, from the first trader who signs up with their code.",
    terms: [
      ["Share", `${COMMISSION_PCT}% of subscription revenue`],
      ["For how long", "As long as the trader stays"],
      ["How traders join", "Your code at signup, or your link"],
      ["In the portal", "Your code, your link and the traders who joined"],
      ["Today", "Billing is not on yet, so nothing is earned or paid out"],
    ],
    link: "Read about commission",
  },
  {
    id: "white_label",
    title: <em className="italic">White-label</em>,
    summary: "Your brand on the terminal your traders use. Nasscord runs the broker connections and the infrastructure.",
    terms: [
      ["Your brand", "Your name and accent colors on the terminal, and your own domain"],
      ["Approval", "Turned on by Nasscord after review"],
      ["Platform fee", `From $${WHITE_LABEL_FEE}/mo plus per-seat, once billing is on`],
      ["Planned", "Your own plans and prices for your traders"],
    ],
    link: "Read about white-label",
  },
];

export function TenantProgram({ className }: { className?: string }) {
  return (
    <div className={cn("grid gap-6 lg:grid-cols-2", className)}>
      {SHEETS.map((s, i) => (
        <article key={s.id} className="flex flex-col gap-6 border border-border bg-card p-6 transition-colors duration-300 hover:border-foreground/40 sm:p-8" {...reveal(150 + i * 120)}>
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-site-accent-ink">{String(i + 1).padStart(2, "0")}</span>
            <span className="site-caption border border-foreground px-2 py-0.5">{TENANT_OFFER_BADGE[s.id]}</span>
          </div>
          <div className="grid gap-2">
            <h3 className="text-5xl leading-none">{s.title}</h3>
            <p className="max-w-[30rem] leading-relaxed text-muted-foreground">{s.summary}</p>
          </div>
          {s.id === "white_label" ? (
            <figure className="grid gap-2">
              <WhiteLabelPreview branding={EXAMPLE_BRANDING} className="transition-transform duration-700 hover:-rotate-1" />
              <figcaption className="font-mono text-[0.7rem] text-muted-foreground">Example brand, made up for this page: {EXAMPLE_BRANDING.name}, at {EXAMPLE_BRANDING.domain}</figcaption>
            </figure>
          ) : null}
          <dl className="border-t border-foreground">
            {s.terms.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-4 border-b border-border py-3 text-sm">
                <dt className="site-caption pt-0.5 text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <Link href={`/tenants#${TENANT_ANCHOR[s.id]}`} className="site-link mt-auto w-fit text-sm">
            {s.link}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </article>
      ))}
    </div>
  );
}
