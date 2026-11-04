"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { APP_DOMAIN } from "@/lib/branding";
import { getPlan } from "@/lib/plans";
import { ROLE_LABEL } from "@/lib/roles";
import { useSignupStore } from "@/components/onboarding/store";

/** Live summary in the rail: updates as the trader fills the steps. */
export function SummaryCard() {
  const workspace = useSignupStore((s) => s.workspace);
  const prefs = useSignupStore((s) => s.prefs);
  const tenant = useSignupStore((s) => s.tenant);
  const tenantCode = useSignupStore((s) => s.account.tenantCode);
  const created = useSignupStore((s) => s.created);
  const plan = getPlan(workspace.plan);
  const joinedTenant = tenant && tenant.code === tenantCode.trim().toUpperCase() ? tenant : null;

  const joiningAs = created
    ? created.role === "tenant_user" && joinedTenant
      ? `${ROLE_LABEL.tenant_user} through ${joinedTenant.name}`
      : ROLE_LABEL[created.role]
    : joinedTenant
      ? `${ROLE_LABEL.tenant_user} through ${joinedTenant.name}`
      : ROLE_LABEL.trader;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Summary</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          <Row label="Workspace">
            {workspace.slug ? (
              <span className="font-mono text-xs break-all">
                {workspace.slug}.{APP_DOMAIN}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set yet</span>
            )}
          </Row>
          <Row label="Joining as">{joiningAs}</Row>
          <Row label="Plan">{joinedTenant?.branding ? `${plan.name} · ${joinedTenant.name} pricing` : plan.name}</Row>
          <Row label="Brokers">
            <span className="text-muted-foreground">Connected in step 3</span>
          </Row>
          <Row label="Risk per trade">
            <span className="tabular">{prefs.riskPct}%</span>
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium">{children}</dd>
    </div>
  );
}
