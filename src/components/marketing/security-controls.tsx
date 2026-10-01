import type { LucideIcon } from "lucide-react";
import { CalendarClock, ClipboardCheck, FileClock, KeyRound, Lock, ScanSearch, ServerCog, XCircle } from "lucide-react";
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
    body: "Refresh tokens and session cookies are encrypted with per-tenant keys and decrypted only inside the broker gateway.",
    detail:
      "Broker tokens are written encrypted with a key that belongs to your tenant. The web tier never holds a decrypted token; only the gateway process that talks to the broker does, in memory, for the life of the request.",
  },
  {
    id: "gateway",
    icon: ServerCog,
    title: "Dedicated broker gateway per tenant",
    body: "Each tenant gets its own gateway processes. Broker sessions are never shared across customers.",
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
    detail: "The log is append-only from the application's point of view and is available to tenant owners in the terminal and to operators in the console.",
  },
  {
    id: "2fa",
    icon: ClipboardCheck,
    title: "2FA on sign-in",
    body: "Time-based one-time codes on every account. Owners can require it for every seat on a Desk plan.",
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

/** Compact two-column list for the home page. */
export function SecurityControlList({ className }: { className?: string }) {
  return (
    <ul className={cn("grid gap-x-8 gap-y-6 sm:grid-cols-2", className)}>
      {SECURITY_CONTROLS.map((c) => (
        <li key={c.id} className="flex gap-3">
          <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
            <c.icon className="size-4" />
          </span>
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold">{c.title}</h3>
            <p className="text-sm leading-relaxed text-muted-foreground">{c.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Long-form list for /security. Each control gets its own anchor. */
export function SecurityControlDetails({ className }: { className?: string }) {
  return (
    <div className={cn("divide-y divide-border", className)}>
      {SECURITY_CONTROLS.map((c) => (
        <article key={c.id} id={`control-${c.id}`} className="grid gap-3 py-6 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,14rem)_1fr] sm:gap-8">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft text-primary">
              <c.icon className="size-4" />
            </span>
            <h3 className="pt-1.5 text-base font-semibold">{c.title}</h3>
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium">{c.body}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{c.detail}</p>
          </div>
        </article>
      ))}
    </div>
  );
}
