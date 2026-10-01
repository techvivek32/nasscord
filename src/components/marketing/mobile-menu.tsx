"use client";

import * as React from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** Mobile navigation for the public site. Closes itself after a link is chosen. */
export function MobileMenu({ items }: { items: Array<{ title: string; href: string }> }) {
  const [open, setOpen] = React.useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu" />}>
        <Menu />
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-sm">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription>Nasscord public site</SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile" className="flex flex-col gap-1 px-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={close}
              className="rounded-lg px-3 py-2.5 text-base font-medium text-foreground hover:bg-muted hover:no-underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              {item.title}
            </Link>
          ))}
        </nav>
        <div className="mt-auto grid gap-2 border-t border-border p-4">
          <Button variant="outline" size="lg" render={<Link href="/login" onClick={close} />}>
            Sign in
          </Button>
          <Button size="lg" render={<Link href="/signup" onClick={close} />}>
            Start free
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
