"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { SITE_FONT_CLASSES } from "@/components/marketing/site-fonts";
import { cn } from "@/lib/utils";

/** Mobile navigation for the public site. The sheet renders in a portal, so it carries the site theme itself. */
export function MobileMenu({ items }: { items: Array<{ title: string; href: string }> }) {
  const [open, setOpen] = React.useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" />}>
        <Menu />
      </SheetTrigger>
      <SheetContent side="right" className={cn("site-theme w-full bg-background sm:max-w-sm", SITE_FONT_CLASSES)}>
        <SheetHeader className="border-b border-border">
          <SheetTitle className="site-label">Menu</SheetTitle>
          <SheetDescription className="site-caption">Nasscord public site</SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile" className="flex flex-col px-4">
          {items.map((item, i) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              style={{ "--d": `${80 + i * 60}ms` } as React.CSSProperties}
              className="group/m flex animate-site-rise items-baseline justify-between border-b border-border py-4 font-serif text-4xl text-foreground hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span>{item.title}</span>
              <span className="site-caption text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-2 border-t border-border p-4">
          <Button variant="outline" size="lg" className="h-12 rounded-[2px] border-foreground bg-transparent" render={<Link href="/login" onClick={close} />}>
            Sign in
          </Button>
          <Button size="lg" className="h-12 rounded-[2px]" render={<Link href="/signup" onClick={close} />}>
            Start free
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
