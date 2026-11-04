import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ROLE_LABEL } from "@/lib/roles";
import type { Session, Tenant } from "@/lib/types";
import { fmtDay, KV, TenantStatusBadge, WhiteLabelBadge } from "./primitives";

/** The tenant's record as stored, read-only. Nasscord's super admin changes these from the console. */
export function TenantSettings({ tenant, session }: { tenant: Tenant; session: Session }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Tenant</CardTitle>
          <CardDescription>Write to Nasscord&apos;s super admin to change any of these.</CardDescription>
        </CardHeader>
        <CardContent>
          <KV
            items={[
              { label: "Name", value: tenant.name },
              { label: "Slug", value: <span className="font-mono text-xs">{tenant.slug}</span> },
              { label: "Status", value: <TenantStatusBadge status={tenant.status} /> },
              { label: "Commission", value: `${tenant.commissionPct}% of your traders' subscriptions` },
              { label: "Referral code", value: tenant.referralCode ? <span className="font-mono text-xs">{tenant.referralCode}</span> : <span className="text-muted-foreground">Not set</span> },
              { label: "White-label", value: <WhiteLabelBadge on={tenant.whiteLabel} /> },
              { label: "Owner", value: tenant.contact ?? <span className="text-muted-foreground">Not set</span> },
              { label: "Created", value: fmtDay(tenant.createdAt) },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
          <CardDescription>The login you use for this portal.</CardDescription>
        </CardHeader>
        <CardContent>
          <KV
            items={[
              { label: "Name", value: session.name },
              { label: "Email", value: <span className="font-mono text-xs">{session.email}</span> },
              { label: "Role", value: ROLE_LABEL[session.role] },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
