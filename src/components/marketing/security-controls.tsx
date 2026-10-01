import type { LucideIcon } from "lucide-react";
import { CalendarClock, ClipboardCheck, FileClock, KeyRound, Lock, ScanSearch, ServerCog, XCircle } from "lucide-react";
import { reveal } from "@/components/marketing/motion";
import { cn } from "@/lib/utils";

export interface SecurityControl {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  /** Longer explanation for /security. */
  detail: string;
}

/** The control list is shared by the home #security section and the /security page. Statements only, no certifications. */
export const SECURITY_CONTROLS: SecurityControl[] = [
  {
    id: "oauth",
    icon: KeyRound,
    title: "OAuth per broker",
    body: "You sign in on the broker's own page. Nasscord receives a scoped token, never your password.",
    detail:
      "Each connection is a separate OAuth grant with the broker. Nasscord asks for read, trade and options scopes explicitly and shows the grant before redirecting. Revoking access at the broker ends the connection immediately.",
  },
  {
    id: "encryption",
    icon: Lock,
    title: "Tokens encrypted at rest",
    body: "Refresh tokens and session cookies are encrypted with per-workspace keys and decrypted only inside the broker gateway.",
    detail:
      "Broker tokens are written encrypted with a key that belongs to your workspace. The web tier never holds a decrypted token; only the gateway process that talks to the broker does, in memory, for the life of the request.",
  },
  {
    id: "gateway",
    icon: ServerCog,
    title: "Dedicated broker gateway per workspace",
    body: "Each workspace gets its own gateway processes. Broker sessions are never shared across customers.",
    detail:
      "For Interactive Brokers, each login runs its own Client Portal gateway process. A reverse proxy in front of it strips forwarding headers so the browser and the keepalive worker present as one client and share one session instead of fighting over it.",
  },
  {
    id: "verify",
    icon: ScanSearch,
    title: "Order verification before confirmation",
    body: "An order is reported as placed only after Nasscord finds it in the broker's order book.",
    detail:
      "After submitting, the engine answers the broker's confirmation prompts, then polls the live order list for the returned id and matches symbol, side, quantity and price. If the order is not found within the verification window, you see a failure, not a guess.",
  },
  {
    id: "cancel",
    icon: XCircle,
    title: "Working orders cancelled before closing",
    body: "Closing a position first cancels its brackets and any other working orders on that symbol.",
    detail:
      "This prevents the classic double exposure where a stop or target fills after the position was already closed manually. Cancels are verified in the order book the same way placements are.",
  },
  {
    id: "audit",
    icon: FileClock,
    title: "Audit log",
    body: "Every order, cancel, connection change and settings change is recorded with actor, time and result.",
    detail: "The log is append-only from the application's point of view and is reviewed by the Nasscord super admin in the console. Your own orders, cancels and fills are always in the terminal, under Orders and History.",
  },
  {
    id: "2fa",
    icon: ClipboardCheck,
    title: "2FA on sign-in",
    body: "Time-based one-time codes on every account. A Desk workspace can require it for every seat.",
    detail: "Sessions expire after 12 hours of inactivity and are revoked when a password changes. New device sign-ins are announced by email.",
  },
  {
    id: "maintenance",
    icon: CalendarClock,
    title: "Maintenance gate",
    body: "No planned changes are deployed between 09:30 and 16:00 ET on weekdays.",
    detail:
      "Planned releases and migrations run outside regular trading hours. Emergency fixes during the session are limited to the affected component and announced on the status page.",
  },
];

export const SOFTWARE_DISCLAIMER = "Nasscord is software, not a broker or an adviser. Your assets stay in your brokerage account.";

/** Ruled two-column list for the home page: mono index, icon, title and one line. */
export function SecurityControlList({ className }: { className?: string }) {
  return (
    <ul className={cn("grid border-t border-foreground md:grid-cols-2 md:gap-x-12", className)}>
      {SECURITY_CONTROLS.map((c, i) => (
        <li key={c.id} className="group/sec grid grid-cols-[3rem_1fr] gap-x-3 gap-y-1 border-b border-border py-5" {...reveal((i % 2) * 80)}>
          <span className="row-span-2 pt-1 font-mono text-xs text-site-accent-ink tabular">S/{String(i + 1).padStart(2, "0")}</span>
          <h3 className="flex items-center gap-2.5 font-sans text-[1.05rem] font-medium">
            <c.icon aria-hidden="true" className="size-4.5 transition-transform duration-500 group-hover/sec:-rotate-12" />
            {c.title}
          </h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{c.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** Long-form list for /security. Each control gets its own anchor. */
export function SecurityControlDetails({ className }: { className?: string }) {
  return (
    <div className={cn("border-t border-foreground", className)}>
      {SECURITY_CONTROLS.map((c, i) => (
        <article key={c.id} id={`control-${c.id}`} className="group/sec grid scroll-mt-24 gap-4 border-b border-border py-8 sm:grid-cols-[4rem_minmax(0,18rem)_1fr] sm:gap-8" {...reveal()}>
          <span className="font-mono text-sm text-site-accent-ink tabular">S/{String(i + 1).padStart(2, "0")}</span>
          <h3 className="flex items-start gap-3 text-3xl leading-tight">
            <c.icon aria-hidden="true" className="mt-1.5 size-5 shrink-0 transition-transform duration-500 group-hover/sec:-rotate-12" />
            {c.title}
          </h3>
          <div className="grid gap-2">
            <p className="font-medium">{c.body}</p>
            <p className="leading-relaxed text-muted-foreground">{c.detail}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
