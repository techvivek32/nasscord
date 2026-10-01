import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";

/** Minimal header for the sign-in and signup pages: wordmark, one cross-link, theme toggle. */
export function AuthHeader({ prompt, linkLabel, href }: { prompt: string; linkLabel: string; href: string }) {
  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-6 lg:px-10">
      <Logo />
      <div className="flex items-center gap-2 sm:gap-3">
        <p className="text-sm text-muted-foreground">
          <span className="hidden sm:inline">{prompt} </span>
          <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">
            {linkLabel}
          </Link>
        </p>
        <ThemeToggle />
      </div>
    </header>
  );
}
