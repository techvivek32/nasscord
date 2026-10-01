import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Page not found" };

/** Themed 404 for every route group; replaces the unstyled framework default. */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <Logo />
      <div className="grid gap-2">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">404</p>
        <h1 className="font-heading text-2xl font-semibold sm:text-3xl">This page does not exist.</h1>
        <p className="mx-auto max-w-md text-sm text-muted-foreground">The link may be out of date, or the record was removed. Your accounts and orders are not affected.</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button render={<Link href="/" />}>Back to home</Button>
        <Button variant="outline" render={<Link href="/app" />}>
          Open the terminal
        </Button>
      </div>
    </main>
  );
}
