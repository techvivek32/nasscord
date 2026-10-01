import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { StatusDot } from "@/components/status-dot";
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
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/security#legal" },
      { label: "Privacy", href: "/security#legal" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-card/40">
      <Container className="grid gap-10 py-12 sm:py-16">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.title} className="grid content-start gap-3">
              <h2 className="font-sans text-xs font-semibold tracking-wide text-muted-foreground uppercase">{col.title}</h2>
              <ul className="grid gap-2 text-sm">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link href={l.href} className="text-foreground/80 hover:text-foreground hover:no-underline">
                      {l.label}
                    </Link>
                  </li>
                ))}
                {col.title === "Company" ? (
                  <li>
                    <StatusDot tone="good" label="All systems normal" className="text-sm font-normal text-foreground/80" />
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-4 border-t border-border pt-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <Logo size={22} />
          <p className="max-w-xl">Trading involves risk. Nasscord is not a broker-dealer or investment adviser.</p>
          <p className="shrink-0">© 2026 Nasscord</p>
        </div>
      </Container>
    </footer>
  );
}
