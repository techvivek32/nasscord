import { AppShell } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/page-header";
import { TenantTheme } from "@/components/tenant-theme";
import { OrderEntryProvider } from "@/components/terminal/order-entry";
import { TerminalHeader } from "@/components/terminal/terminal-header";
import { TerminalSidebarFooter } from "@/components/terminal/sidebar-footer";
import { WorkspaceScopeProvider } from "@/components/workspace-scope";
import { requireRole } from "@/lib/auth";
import { ROLE_LABEL, TERMINAL_ROLES, areasForRole, terminalHomeForRole } from "@/lib/roles";
import { getCurrentBranding, getCurrentWorkspace, getMySettings, workspaceHost } from "@/lib/server/workspace";

/** Every request reads the session cookies: never prerender this area at build time. */
export const dynamic = "force-dynamic";

/**
 * Trader terminal shell, for traders, tenant users and the super admin's own desk.
 * Workspace-scoped: WorkspaceScopeProvider puts the session's workspace id into every client query key,
 * and a tenant user's workspace wears its tenant's white-label brand through TenantTheme.
 * Header: account scope with its totals, market session, order entry badge, user menu.
 * OrderEntryProvider (inside TenantTheme) gives the header, the pages, the ticket sheet and the confirm
 * dialog one view of order entry; it reads the switch from a polled route, never from this layout.
 * Sidebar footer: the workspace row. There is no quote strip: Nasscord has no market data feed yet.
 */
export default async function TerminalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(TERMINAL_ROLES, "/app");
  const workspace = await getCurrentWorkspace();
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };

  if (!workspace) {
    return (
      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-4 py-16">
        <EmptyState title="Your workspace is missing" description="This account has no trading workspace any more. Ask the platform owner to restore it, or sign out and create a new account." />
      </main>
    );
  }

  const [branding, host, settings] = await Promise.all([getCurrentBranding(workspace), workspaceHost(workspace), getMySettings()]);

  return (
    <WorkspaceScopeProvider value={{ workspaceId: workspace.id, userId: session.uid, role: session.role }}>
      <TenantTheme branding={branding}>
        <OrderEntryProvider riskPct={settings.riskPct} paperFirst={settings.paperMode}>
          <AppShell
            nav="terminal"
            role={session.role}
            brandName={branding.name}
            brandSub="Terminal"
            brandHref={terminalHomeForRole(session.role)}
            areas={areasForRole(session.role)}
            header={<TerminalHeader user={user} />}
            sidebarFooter={<TerminalSidebarFooter user={user} workspace={{ name: workspace.name, host }} />}
          >
            {children}
          </AppShell>
        </OrderEntryProvider>
      </TenantTheme>
    </WorkspaceScopeProvider>
  );
}
