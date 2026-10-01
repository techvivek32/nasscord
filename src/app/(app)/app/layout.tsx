import { AppShell } from "@/components/layout/app-shell";
import { TenantTheme } from "@/components/tenant-theme";
import { TerminalHeader } from "@/components/terminal/terminal-header";
import { TerminalSidebarFooter } from "@/components/terminal/sidebar-footer";
import { TickerStrip } from "@/components/terminal/ticker-strip";
import { requireRole } from "@/lib/auth";
import { PLAN_LABEL } from "@/lib/plans";
import { ROLE_LABEL, TERMINAL_ROLES, areasForRole } from "@/lib/roles";
import { workspaceHost } from "@/lib/tenant";
import { getCurrentBranding, getCurrentWorkspace } from "@/lib/tenant-server";

/**
 * Trader terminal shell, for traders, tenant users and the super admin's own desk.
 * Workspace-scoped: a tenant user's workspace wears its tenant's white-label brand through TenantTheme.
 * Header: account scope, market session, paper/live, user menu. Under it, the quote strip.
 * Sidebar footer: paper-mode switch and the workspace row.
 */
export default async function TerminalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(TERMINAL_ROLES, "/app");
  const workspace = await getCurrentWorkspace();
  const branding = await getCurrentBranding(workspace);
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };

  return (
    <TenantTheme branding={branding}>
      <AppShell
        nav="terminal"
        brandName={branding.name}
        brandSub="Terminal"
        brandHref="/app"
        areas={areasForRole(session.role)}
        header={<TerminalHeader user={user} />}
        sidebarFooter={<TerminalSidebarFooter user={user} workspace={{ name: workspace.name, planLabel: PLAN_LABEL[workspace.plan], host: workspaceHost(workspace), paperDefault: workspace.features.paperDefault }} />}
      >
        <TickerStrip className="-mx-3 -mt-3 sm:-mx-4 sm:-mt-4 lg:-mx-6 lg:-mt-6" />
        {children}
      </AppShell>
    </TenantTheme>
  );
}
