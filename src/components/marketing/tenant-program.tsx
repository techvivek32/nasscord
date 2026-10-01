import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { COMMISSION_PCT, WHITE_LABEL_FEE } from "@/lib/plans";
import type { TenantBranding } from "@/lib/types";
import { TENANT_ANCHOR, TENANT_OFFER_BADGE, WhiteLabelPreview } from "@/components/marketing/tenant-offers";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

/*
 * The tenant program on the home page: the two offers as term sheets, commission for every tenant and white-label as
 * the add-on. Server component. The funnel bars wait for the reveal.
 */

/* Bars in the referral funnel grow in once the card is on screen. */
const BAR_CSS = "@keyframes tp-bar{from{transform:scaleX(0)}to{transform:none}}";

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
    summary: "Every tenant earns it, from the first trader they bring.",
    terms: [
      ["Share", `${COMMISSION_PCT}% of subscription revenue`],
      ["For how long", "As long as the trader stays"],
      ["Payouts", "Monthly by ACH, $100 minimum"],
      ["Attribution", "First visit to paid plan, 90 days"],
      ["Tracking", "Clicks, trials and conversions in your tenant portal"],
    ],
    link: "Read about commission",
  },
  {
    id: "white_label",
    title: <em className="italic">White-label</em>,
    summary: "Your brand on the terminal your traders use. Nasscord runs the engine and the broker connections.",
    terms: [
      ["Platform fee", `From $${WHITE_LABEL_FEE}/mo plus per-seat`],
      ["Your brand", "Name, domain, accent color and emails"],
      ["Pricing", "You set the plans your traders see"],
      ["Infrastructure", "A dedicated broker gateway pool"],
      ["Approval", "Turned on by Nasscord after review"],
    ],
    link: "Read about white-label",
  },
];

export interface Funnel {
  clicks: number;
  signups: number;
  trials: number;
  paid: number;
}

/** A tenant's referral funnel as ruled rows with bars that grow in, and the step-to-step conversion. */
function FunnelMini({ funnel, tenantName }: { funnel: Funnel; tenantName?: string }) {
  const rows: Array<[string, number]> = [
    ["Clicks", funnel.clicks],
    ["Sign-ups", funnel.signups],
    ["Trials", funnel.trials],
    ["Paid", funnel.paid],
  ];
  // Square-root scale so a 1,284 to 46 funnel still shows every step.
  const width = (n: number) => `${Math.max(4, Math.sqrt(n / funnel.clicks) * 100)}%`;
  return (
    <figure className="grid gap-2">
      <div className="grid gap-2 border border-border bg-background p-4">
        {rows.map(([k, v], i) => (
          <div key={k} className="grid grid-cols-[4.5rem_1fr_3.5rem] items-center gap-3 text-sm">
            <span className="text-muted-foreground">{k}</span>
            <span aria-hidden="true" className="h-2 overflow-hidden rounded-[2px] bg-site-band">
              <span data-play className="block h-full origin-left bg-primary" style={{ width: width(v), opacity: 1 - i * 0.18, animation: `tp-bar .9s cubic-bezier(.2,.7,.2,1) ${0.3 + i * 0.15}s both` }} />
            </span>
            <span className="text-right font-mono tabular">{v.toLocaleString("en-US")}</span>
          </div>
        ))}
      </div>
      <figcaption className="font-mono text-[0.7rem] text-muted-foreground">
        Example tenant portal{tenantName ? `: ${tenantName}` : ""}, all time. {Math.round((funnel.paid / funnel.clicks) * 1000) / 10}% of clicks became paying traders.
      </figcaption>
    </figure>
  );
}

export function TenantProgram({ preview, funnel, tenantName, className }: { preview?: TenantBranding | null; funnel?: Funnel; tenantName?: string; className?: string }) {
  return (
    <div className={cn("grid gap-6", className)}>
      <style>{BAR_CSS}</style>
      <div className="grid gap-6 lg:grid-cols-2">
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
            {s.id === "commission" && funnel ? <FunnelMini funnel={funnel} tenantName={tenantName} /> : null}
            {s.id === "white_label" && preview ? (
              <figure className="grid gap-2">
                <WhiteLabelPreview branding={preview} className="transition-transform duration-700 hover:-rotate-1" />
                <figcaption className="font-mono text-[0.7rem] text-muted-foreground">Example tenant: {preview.name}, at {preview.domain}</figcaption>
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
    </div>
  );
}
