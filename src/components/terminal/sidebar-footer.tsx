"use client";

import * as React from "react";
import { SidebarSeparator } from "@/components/ui/sidebar";
import { AccountSwitcher } from "@/components/terminal/account-switcher";
import { PaperModeSwitch } from "@/components/terminal/paper-mode";
import { hydrateTerminalStore } from "@/components/terminal/store";
import { UserMenu } from "@/components/layout/user-menu";
import type { TerminalUser } from "@/components/terminal/terminal-header";

export interface TerminalWorkspace {
  name: string;
  planLabel: string;
  host: string;
  paperDefault: boolean;
}

/**
 * Sidebar footer: workspace row, paper-mode switch, user row.
 * Also hydrates the persisted terminal store once on mount (it is always rendered inside the terminal layout).
 */
export function TerminalSidebarFooter({ workspace, user }: { workspace: TerminalWorkspace; user: TerminalUser }) {
  React.useEffect(() => {
    void hydrateTerminalStore(workspace.paperDefault);
  }, [workspace.paperDefault]);

  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pb-1 sm:hidden">
        <AccountSwitcher className="w-full justify-start" />
      </div>
      <PaperModeSwitch />
      <SidebarSeparator className="mx-0" />
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
