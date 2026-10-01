"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { DemoFlag } from "@/components/page-header";
import { StatusDot } from "@/components/status-dot";
import { marketSession } from "@/lib/engine";
import { AccountSwitcher } from "@/components/terminal/account-switcher";
import { useMinuteClock } from "@/components/terminal/hooks";
import { PaperLiveBadge } from "@/components/terminal/paper-mode";

export type TerminalUser = ShellUser;

const SESSION_LABEL = {
  regular: { tone: "good" as const, label: "Regular session", detail: "closes 16:00 ET", pulse: true },
  pre: { tone: "warn" as const, label: "Pre-market", detail: "opens 09:30 ET", pulse: false },
  post: { tone: "warn" as const, label: "After hours", detail: "until 20:00 ET", pulse: false },
  closed: { tone: "neutral" as const, label: "Closed", detail: "opens 09:30 ET", pulse: false },
};

/** Market session pill from lib/engine. Client-only so the server render never guesses the time. */
export function SessionPill({ className }: { className?: string }) {
  const now = useMinuteClock();
  if (!now) return <Skeleton className="h-5 w-32" />;
  const s = SESSION_LABEL[marketSession(now)];
  return (
    <StatusDot
      tone={s.tone}
      pulse={s.pulse}
      className={className}
      label={
        <span className="text-xs">
          {s.label}
          <span className="hidden text-muted-foreground lg:inline"> · {s.detail}</span>
        </span>
      }
    />
  );
}

/** Right side of the shell header: scope, session, mode, demo flag, user. */
export function TerminalHeader({ user }: { user: TerminalUser }) {
  return (
    <div className="flex items-center gap-1.5 sm:gap-2.5">
      <AccountSwitcher className="hidden sm:inline-flex" />
      <SessionPill className="hidden md:inline-flex" />
      <PaperLiveBadge />
      <DemoFlag className="hidden xl:inline-flex" />
      <UserMenu user={user} settingsHref="/app/settings" />
    </div>
  );
}
