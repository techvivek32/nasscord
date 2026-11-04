import { initials } from "@/lib/format";
import type { PortalUser } from "./tenant-header";

/** Sidebar footer: the tenant this portal is scoped to, with the signed-in user under it. */
export function TenantSidebarFooter({ user, tenant }: { user: PortalUser; tenant: { name: string; kind: string } | null }) {
  const name = tenant?.name ?? user.name;
  return (
    <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 group-data-[collapsible=icon]:justify-center">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-soft font-heading text-xs font-semibold text-primary">
        {initials(name)}
      </span>
      <div className="min-w-0 group-data-[collapsible=icon]:hidden">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {tenant?.kind ?? user.roleLabel} · {user.email}
        </p>
      </div>
    </div>
  );
}
