"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { DemoFlag } from "@/components/page-header";
import { tenantKindLabel, useCurrentTenant } from "./current";

export type PortalUser = ShellUser;

/** Right side of the shell header: tenant identity badge, demo flag, user menu. */
export function TenantHeader({ user }: { user: PortalUser }) {
  const { tenant, isLoading } = useCurrentTenant();
  return (
    <>
      {isLoading ? (
        <Skeleton className="hidden h-5 w-44 sm:block" />
      ) : tenant ? (
        <Badge variant="outline" className="hidden gap-1.5 sm:inline-flex">
          <span className="font-medium">{tenant.name}</span>
          <span className="text-muted-foreground">{tenantKindLabel(tenant)}</span>
        </Badge>
      ) : null}
      <DemoFlag className="hidden md:inline-flex" />
      <UserMenu user={user} settingsHref="/tenant/settings" />
    </>
  );
}
