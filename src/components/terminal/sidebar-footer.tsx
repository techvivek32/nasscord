"use client";

import { SidebarSeparator } from "@/components/ui/sidebar";
import { AccountSwitcher } from "@/components/terminal/account-switcher";
import { UserMenu } from "@/components/layout/user-menu";
import type { TerminalUser } from "@/components/terminal/terminal-header";

export interface TerminalWorkspace {
  name: string;
  planLabel: string;
  host: string;
}

/**
 * Sidebar footer: the account scope on phones, and the workspace row with the user menu.
 * The persisted terminal preferences are hydrated by the header, not here: on phones the sidebar
 * is a sheet whose content only mounts while it is open.
 */
export function TerminalSidebarFooter({ workspace, user }: { workspace: TerminalWorkspace; user: TerminalUser }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pb-1 sm:hidden">
        <AccountSwitcher className="w-full justify-start" />
      </div>
      <SidebarSeparator className="mx-0 sm:hidden" />
      <div className="flex items-center gap-2 rounded-lg px-1 py-1 group-data-[collapsible=icon]:justify-center">
        <UserMenu user={user} settingsHref="/app/settings" />
        <div className="min-w-0 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-sm font-medium">{workspace.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {workspace.planLabel} · {workspace.host}
          </p>
        </div>
      </div>
    </div>
  );
}
