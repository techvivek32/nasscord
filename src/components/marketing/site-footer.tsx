import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { Container } from "@/components/marketing/container";

const COLUMNS: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
  {
    title: "Product",
    links: [
      { label: "Terminal", href: "/app" },
      { label: "Pricing", href: "/pricing" },
      { label: "Brokers", href: "/brokers" },
      { label: "Sign up", href: "/signup" },
    ],
  },
  {
    title: "Tenants",
    links: [
      { label: "Commission", href: "/tenants#commission" },
      { label: "White-label", href: "/tenants#white-label" },
      { label: "Tenant portal", href: "/tenant" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Security", href: "/security" },
      { label: "FAQ", href: "/#faq" },
      { label: "Terms", href: "/security#legal" },
      { label: "Privacy", href: "/security#legal" },
    ],
  },
];

/**
 * Footer on ink: the mark, a serif line, link columns under mono headings, the disclaimer, and an oversized serif
 * wordmark running off the bottom edge. Paper on ink in light mode; a raised dark panel in dark mode.
 */
export function SiteFooter() {
  return (
    <footer className="relative overflow-hidden border-t border-border bg-site-ink text-site-paper dark:bg-site-raised dark:text-foreground">
      <Container className="grid gap-14 pt-20">
        <div className="grid gap-12 lg:grid-cols-[1.1fr_1.4fr]">
          <div className="grid content-start gap-5">
            <LogoMark size={40} className="rounded-[10px]" />
            <p className="max-w-md font-serif text-3xl leading-tight">
              One terminal for every broker you hold, then <em className="italic">trade it well</em>.
            </p>
            <p className="site-caption opacity-60">OAuth per broker · Orders verified · Custody stays at your broker</p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {COLUMNS.map((col) => (
              <div key={col.title} className="grid content-start gap-4">
                <h2 className="site-caption border-b border-current/20 pb-3 font-mono opacity-60">{col.title}</h2>
                <ul className="grid gap-2.5">
                  {col.links.map((l) => (
                    <li key={l.label}>
                      <Link href={l.href} className="group/fl relative text-current/85 transition-colors hover:text-current hover:no-underline">
                        {l.label}
                        <span aria-hidden="true" className="absolute -bottom-0.5 left-0 h-px w-full origin-left scale-x-0 bg-site-accent transition-transform duration-300 group-hover/fl:scale-x-100" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4 border-t border-current/20 pt-6 sm:flex-row sm:items-start sm:justify-between">
          <p className="max-w-2xl text-xs leading-relaxed opacity-60">
            Trading involves risk, including the loss of principal. Nasscord is software, not a broker-dealer or investment adviser. Alerts are information, not
            recommendations. Alerts, quotes, positions and account figures shown on this site are demo data.
          </p>
          <p className="shrink-0 font-mono text-[0.7rem] opacity-60">© 2026 Nasscord. Built to be traded on.</p>
        </div>
      </Container>
      <p aria-hidden="true" className="mt-10 -mb-[0.06em] text-center font-serif text-[23vw] leading-[0.82] tracking-[-0.02em] select-none">
        Nass<em className="italic">cord</em>
      </p>
    </footer>
  );
}
