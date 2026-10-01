import { AppShell } from "@/components/layout/app-shell";
import { TenantTheme } from "@/components/tenant-theme";
import { TerminalHeader } from "@/components/terminal/terminal-header";
import { TerminalSidebarFooter } from "@/components/terminal/sidebar-footer";
import { TickerStrip } from "@/components/terminal/ticker-strip";
import { requireSession } from "@/lib/auth";
import { PLAN_LABEL } from "@/lib/plans";
import { ROLE_LABEL, areasForRole } from "@/lib/roles";
import { brandingFor } from "@/lib/tenant";
import { getCurrentTenant } from "@/lib/tenant-server";

/**
 * Trader terminal shell. Tenant-scoped: white-label branding flows in through TenantTheme.
 * Header: account scope, market session, paper/live, user menu. Under it, the quote strip.
 * Sidebar footer: paper-mode switch and the workspace row.
 */
export default async function TerminalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession("/app");
  const tenant = await getCurrentTenant();
  const branding = brandingFor(tenant);
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };
  const host = tenant.whiteLabel && tenant.branding?.domain ? tenant.branding.domain : `${tenant.slug}.nasscord.com`;

  return (
    <TenantTheme branding={branding}>
      <AppShell
        nav="terminal"
        brandName={branding.name}
        brandSub="Terminal"
        brandHref="/app"
        areas={areasForRole(session.role)}
        header={<TerminalHeader user={user} />}
        sidebarFooter={<TerminalSidebarFooter user={user} workspace={{ name: tenant.name, planLabel: PLAN_LABEL[tenant.plan], host, paperDefault: tenant.features.paperDefault }} />}
      >
        <TickerStrip className="-mx-3 -mt-3 sm:-mx-4 sm:-mt-4 lg:-mx-6 lg:-mt-6" />
        {children}
      </AppShell>
    </TenantTheme>
  );
}
