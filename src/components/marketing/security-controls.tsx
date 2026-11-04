import type { LucideIcon } from "lucide-react";
import { Ban, FileClock, Gauge, KeyRound, Lock, ServerCog, ShieldCheck, Unplug } from "lucide-react";
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

/**
 * The control list is shared by the home #security section and the /security page. Statements only, no
 * certifications, and only controls that exist in this release (docs/real-backend.md sections 5 to 8).
 */
export const SECURITY_CONTROLS: SecurityControl[] = [
  {
    id: "passwords",
    icon: KeyRound,
    title: "No broker passwords stored",
    body: "You log in to IBKR on IBKR's own page and approve E*TRADE on E*TRADE's page. Nasscord stores no broker password.",
    detail:
      "For Interactive Brokers, the login page comes from IBKR's Client Portal gateway that runs for your connection, and the session lives in that process; nothing secret about it is written to the database. For E*TRADE, you approve Nasscord on E*TRADE's site and paste back a verification code; Nasscord keeps the resulting access token, not your password.",
  },
  {
    id: "encryption",
    icon: Lock,
    title: "Tokens encrypted at rest",
    body: "Your E*TRADE key and tokens are encrypted with AES-256-GCM by the broker service. The web app never holds them.",
    detail:
      "Each secret is encrypted with a random 12-byte IV and the connection id as additional data, under a key that exists only on the broker service, a separate server from the web app. The web app holds no broker secrets at all.",
  },
  {
    id: "gateway",
    icon: ServerCog,
    title: "Dedicated IBKR gateway per connection",
    body: "Every IBKR connection runs its own gateway process on its own port. Broker sessions are never shared.",
    detail:
      "The gateway listens on the broker service's own machine only (127.0.0.1). Its slot is released when you disconnect, when the process exits, or 30 minutes after the session expires.",
  },
  {
    id: "workspace",
    icon: ShieldCheck,
    title: "Workspace checked on every call",
    body: "Every call from the app to the broker service carries a signed token, valid for 60 seconds, that names your workspace.",
    detail:
      "The broker service checks every connection id against that workspace before it uses it, so one workspace can never read another's connection. An IBKR login link from the app is seconds old and opens only for someone signed in to the same workspace.",
  },
  {
    id: "read-only",
    icon: Ban,
    title: "Read-only in this release",
    body: "Order entry is switched off. Nothing Nasscord does in this release can place, change or cancel an order.",
    detail:
      "The order ticket still works out a size from your stop, then shows why it cannot place the order. Accounts, balances, positions, orders and executions are read from the broker; nothing is sent back.",
  },
  {
    id: "rate-limits",
    icon: Gauge,
    title: "Rate limits per broker",
    body: "Calls are limited per IBKR username and per E*TRADE connection, and a short cache lets many open tabs share one broker call.",
    detail: "The limits are 8 requests a second per IBKR username and 2 a second per E*TRADE module, with a 5-second cache per connection. An E*TRADE rate-limit reply makes the service back off instead of retrying.",
  },
  {
    id: "audit",
    icon: FileClock,
    title: "Audit log",
    body: "Connecting, renewing and disconnecting a broker, every IBKR login link and every console action are recorded with who and when.",
    detail: "The log is append-only from the application's point of view and is reviewed by the Nasscord super admin in the console. Tenant applications are recorded the same way.",
  },
  {
    id: "disconnect",
    icon: Unplug,
    title: "Disconnect ends access",
    body: "Disconnecting revokes the E*TRADE token and stops the IBKR gateway for that connection.",
    detail:
      "E*TRADE also ends every session at midnight Eastern on its own, and IBKR sessions last about a day. After either, the connection shows as expired until you reconnect.",
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
