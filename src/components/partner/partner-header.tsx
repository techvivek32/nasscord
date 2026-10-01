"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { DemoFlag } from "@/components/page-header";
import { useCurrentPartner } from "./current";
import { MODEL_LABEL } from "./primitives";

export type PortalUser = ShellUser;

/** Right side of the shell header: partner identity badge, demo flag, user menu. */
export function PartnerHeader({ user }: { user: PortalUser }) {
  const { partner, isLoading } = useCurrentPartner();
  return (
    <>
      {isLoading ? (
        <Skeleton className="hidden h-5 w-44 sm:block" />
      ) : partner ? (
        <Badge variant="outline" className="hidden gap-1.5 sm:inline-flex">
          <span className="font-medium">{partner.name}</span>
          <span className="text-muted-foreground">{MODEL_LABEL[partner.model]}</span>
        </Badge>
      ) : null}
      <DemoFlag className="hidden md:inline-flex" />
      <UserMenu user={user} settingsHref="/partner/settings" />
    </>
  );
}
