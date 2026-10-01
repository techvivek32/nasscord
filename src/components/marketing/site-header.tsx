import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/marketing/container";
import { MobileMenu } from "@/components/marketing/mobile-menu";
import { MARKETING_NAV } from "@/lib/nav";

/** Sticky public-site header. Server component; only the mobile menu is client-side. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <Container className="flex h-16 items-center gap-4 lg:gap-6">
        <Logo />
        <nav aria-label="Primary" className="ml-auto hidden items-center gap-1 md:flex">
          {MARKETING_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {item.title}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2 md:ml-2">
          <ThemeToggle />
          <Button variant="ghost" className="hidden md:inline-flex" render={<Link href="/login" />}>
            Sign in
          </Button>
          <Button className="hidden sm:inline-flex" render={<Link href="/signup" />}>
            Start free
          </Button>
          <MobileMenu items={MARKETING_NAV} />
        </div>
      </Container>
    </header>
  );
}
