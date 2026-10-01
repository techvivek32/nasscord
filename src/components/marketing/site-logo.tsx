import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

/** Website wordmark: the cobalt mark plus "Nasscord" in the display serif, with "cord" set in italic. */
export function SiteLogo({ className, size = 30, href = "/" }: { className?: string; size?: number; href?: string }) {
  return (
    <Link href={href} aria-label="Nasscord home" className={cn("group/logo inline-flex items-center gap-2.5 text-foreground hover:no-underline", className)}>
      <LogoMark size={size} className="rounded-[8px] transition-transform duration-500 group-hover/logo:-rotate-6" />
      <span className="font-serif text-[1.7rem] leading-none tracking-[-0.01em]">
        Nass<em className="italic">cord</em>
      </span>
    </Link>
  );
}
