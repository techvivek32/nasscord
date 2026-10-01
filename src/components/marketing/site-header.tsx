import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/marketing/container";
import { HeaderShell, NavLinks } from "@/components/marketing/header-shell";
import { MobileMenu } from "@/components/marketing/mobile-menu";
import { SiteLogo } from "@/components/marketing/site-logo";
import { MARKETING_NAV } from "@/lib/nav";

/** Public-site header: paper bar with a hairline, serif wordmark, plain links and square buttons. */
export function SiteHeader() {
  return (
    <HeaderShell>
      <Container className="flex h-16 items-center gap-4 lg:gap-8">
        <SiteLogo />
        <NavLinks items={MARKETING_NAV} className="mx-auto hidden md:flex" />
        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <ThemeToggle />
          <Button variant="outline" className="hidden h-10 rounded-[2px] border-foreground bg-transparent px-4 text-[0.95rem] hover:bg-foreground hover:text-background md:inline-flex" render={<Link href="/login" />}>
            Sign in
          </Button>
          <Button className="group/cta hidden h-10 rounded-[2px] px-4 text-[0.95rem] sm:inline-flex" render={<Link href="/signup" />}>
            Start free
            <ArrowRight data-icon="inline-end" className="transition-transform group-hover/cta:translate-x-0.5" />
          </Button>
          <MobileMenu items={MARKETING_NAV} />
        </div>
      </Container>
    </HeaderShell>
  );
}
