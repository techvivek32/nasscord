import { AppShell } from "@/components/layout/app-shell";
import { UserMenu } from "@/components/layout/user-menu";
import { ConsoleHeader } from "@/components/console/console-header";
import { MaintenanceRow } from "@/components/console/maintenance-gate";
import { requireRole } from "@/lib/auth";
import { CONSOLE_ROLES, ROLE_LABEL, areasForRole } from "@/lib/roles";

/** Platform console. The super admin only; the proxy redirects everyone else optimistically, this enforces it. */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(CONSOLE_ROLES, "/admin");
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };

  return (
    <AppShell
      nav="console"
      brandSub="Console"
      brandHref="/admin"
      areas={areasForRole(session.role)}
      header={<ConsoleHeader user={user} />}
      sidebarFooter={
        <div className="grid gap-1">
          <MaintenanceRow className="border-b border-sidebar-border pb-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:border-0" />
          <div className="flex items-center gap-2 rounded-lg px-1 py-1 group-data-[collapsible=icon]:justify-center">
            <UserMenu user={user} settingsHref="/admin/settings" />
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-medium">{session.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.roleLabel} · {session.email}
              </p>
            </div>
          </div>
        </div>
      }
    >
      {children}
    </AppShell>
  );
}
