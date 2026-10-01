"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { initials } from "@/lib/format";
import { useCurrentPartner } from "./current";
import { MODEL_LABEL } from "./primitives";
import type { PortalUser } from "./partner-header";

/** Sidebar footer: the partner organisation this portal is scoped to, with the signed-in user under it. */
export function PartnerSidebarFooter({ user }: { user: PortalUser }) {
  const { partner, isLoading } = useCurrentPartner();
  const name = partner?.name ?? user.name;
  const sub = partner ? `${MODEL_LABEL[partner.model]} partner` : "Partner";

  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 group-data-[collapsible=icon]:justify-center">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft font-heading text-xs font-semibold text-primary">
        {isLoading ? "" : initials(name)}
      </span>
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        {isLoading ? (
          <div className="grid gap-1.5 py-0.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-36" />
          </div>
        ) : (
          <>
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {sub} · {user.email}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
