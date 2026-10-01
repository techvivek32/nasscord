"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Sticky paper header with a hairline; it gains a soft shadow once the page has scrolled. */
export function HeaderShell({ children }: { children: React.ReactNode }) {
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      data-scrolled={scrolled ? "" : undefined}
      className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm transition-shadow duration-300 data-scrolled:shadow-[0_10px_30px_-24px_color-mix(in_oklab,var(--foreground)_45%,transparent)]"
    >
      {children}
    </header>
  );
}

/** Primary nav: plain links; an accent rule slides in under the hovered and the current one. */
export function NavLinks({ items, className }: { items: Array<{ title: string; href: string }>; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className={cn("items-center gap-7", className)}>
      {items.map((item) => {
        const active = !item.href.includes("#") && (pathname === item.href || pathname.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className="group/nav relative py-1 text-[0.95rem] text-foreground hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {item.title}
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-x-0 -bottom-0.5 h-[2px] origin-left scale-x-0 bg-site-accent transition-transform duration-300 group-hover/nav:scale-x-100",
                active && "scale-x-100",
              )}
            />
          </Link>
        );
      })}
    </nav>
  );
}
