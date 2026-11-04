import Link from "next/link";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/types";

/** Shown when the signed-in user has no tenant to show: the super admin who is not a tenant's login, or a tenant row that is gone. */
export function NoTenant({ session }: { session: Session }) {
  if (session.role === "superadmin") {
    return (
      <EmptyState
        title="Choose a tenant to view"
        description="This portal shows one tenant's own records. On the console's Tenants page, press View portal next to the tenant you are supporting."
        action={
          <Button size="sm" variant="outline" render={<Link href="/admin/tenants" />}>
            Open Tenants in the console
          </Button>
        }
      />
    );
  }
  return <EmptyState title="Your tenant was not found" description="Your login is not linked to a tenant any more. Write to Nasscord's super admin to have it linked again." />;
}
