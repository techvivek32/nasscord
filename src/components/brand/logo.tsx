import Link from "next/link";
import { cn } from "@/lib/utils";

export function LogoMark({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-grid shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground", className)}
      style={{ width: size, height: size }}
    >
      <svg width={Math.round(size * 0.57)} height={Math.round(size * 0.57)} viewBox="0 0 16 16" fill="none">
        <path d="M2 12V4l6 8V4l6 8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/**
 * Wordmark. `name` defaults to Nasscord; white-label tenants pass their brand name.
 * `sub` renders a small uppercase product suffix (Terminal, Console, Tenants).
 */
export function Logo({
  name = "Nasscord",
  sub,
  href = "/",
  className,
  size = 28,
}: {
  name?: string;
  sub?: string;
  href?: string;
  className?: string;
  size?: number;
}) {
  return (
    <Link
      href={href}
      aria-label={`${name} home`}
      className={cn("inline-flex items-center gap-2.5 whitespace-nowrap font-heading text-[1.125rem] font-bold tracking-tight text-foreground hover:no-underline", className)}
    >
      <LogoMark size={size} />
      <span>{name}</span>
      {sub ? (
        <span className="ml-0.5 border-l border-input pl-2.5 font-sans text-[0.7rem] font-medium uppercase tracking-[0.08em] text-muted-foreground">
          {sub}
        </span>
      ) : null}
    </Link>
  );
}
