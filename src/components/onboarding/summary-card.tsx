"use client";

import { BrokerMark } from "@/components/brokers/broker-mark";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPlan } from "@/lib/plans";
import { fmtMoney } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/roles";
import { isTenantCode, riskDollars, selectDefaultAccount, useSignupStore } from "@/components/onboarding/store";

/** Live summary in the rail: updates as the trader fills the steps. `whiteLabel`: the tenant sets its traders' pricing. */
export function SummaryCard({ tenantName, whiteLabel = false }: { tenantName?: string; whiteLabel?: boolean }) {
  const workspace = useSignupStore((s) => s.workspace);
  const connections = useSignupStore((s) => s.connections);
  const prefs = useSignupStore((s) => s.prefs);
  const tenantCode = useSignupStore((s) => s.account.tenantCode);
  const plan = getPlan(workspace.plan);
  const defaultAccount = selectDefaultAccount({ connections, prefs });
  const tenant = isTenantCode(tenantCode) ? tenantName : undefined;

  const price = plan.monthly === 0 ? "$0" : `$${plan.monthly}/mo`;
  const planLine = tenant && whiteLabel
    ? `${plan.name} · ${tenant} pricing`
    : plan.id === "pro"
      ? `${plan.name} · 14-day trial, then ${price}`
      : `${plan.name} · ${price}`;
  const accountCount = connections.reduce((n, c) => n + c.accounts.length, 0);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Summary</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          <Row label="Workspace">
            {workspace.slug ? (
              <span className="font-mono text-xs break-all">{workspace.slug}.nasscord.com</span>
            ) : (
              <span className="text-muted-foreground">Not set yet</span>
            )}
          </Row>
          <Row label="Joining as">{tenant ? `${ROLE_LABEL.tenant_user} through ${tenant}` : ROLE_LABEL.trader}</Row>
          <Row label="Plan">{planLine}</Row>
          <Row label="Brokers">
            {connections.length ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                {connections.map((c) => (
                  <BrokerMark key={c.brokerId} id={c.brokerId} size="sm" />
                ))}
                <span className="ml-1 text-xs text-muted-foreground tabular">
                  {accountCount} {accountCount === 1 ? "account" : "accounts"}
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">None connected</span>
            )}
          </Row>
          <Row label="Risk per trade">
            <span className="tabular">
              {prefs.riskPct}%
              {defaultAccount ? <span className="text-muted-foreground"> · {fmtMoney(riskDollars(defaultAccount.netLiq, prefs.riskPct))}</span> : null}
            </span>
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
