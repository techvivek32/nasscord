import { Badge } from "@/components/ui/badge";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";

export type PortalUser = ShellUser;

/** Right side of the shell header: which tenant this portal is about, and the account menu. */
export function TenantHeader({ user, tenant }: { user: PortalUser; tenant: { name: string; kind: string } | null }) {
  return (
    <>
      {tenant ? (
        <Badge variant="outline" className="hidden gap-1.5 sm:inline-flex">
          <span className="font-medium">{tenant.name}</span>
          <span className="text-muted-foreground">{tenant.kind}</span>
        </Badge>
      ) : null}
      <UserMenu user={user} settingsHref="/tenant/settings" />
    </>
  );
}
