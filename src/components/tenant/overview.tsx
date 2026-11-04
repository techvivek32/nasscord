import Link from "next/link";
import { EmptyState } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { BrokerMarks } from "@/components/brokers/broker-mark";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtNum } from "@/lib/format";
import type { Tenant, User, Workspace } from "@/lib/types";
import { CopyField } from "./copy-field";
import { fmtDay, PlanBadge } from "./primitives";

/** The tenant's own numbers: traders that came through its code, tenant users, commission rate, the referral link. */
export function TenantOverview({ tenant, workspaces, members, link }: { tenant: Tenant; workspaces: Workspace[]; members: User[]; link: string | null }) {
  const tenantUsers = members.filter((m) => m.role === "tenant_user").length;
  const recent = workspaces.slice(0, 5);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Traders" value={fmtNum(workspaces.length)} hint={<span className="text-[11px] text-muted-foreground">workspaces</span>} />
        <StatCard label="Tenant users" value={fmtNum(tenantUsers)} hint={<span className="text-[11px] text-muted-foreground">can sign in</span>} />
        <StatCard label="Commission" value={`${tenant.commissionPct}%`} hint={<span className="text-[11px] text-muted-foreground">of subscriptions</span>} />
        <StatCard label="White-label" value={tenant.whiteLabel ? "On" : "Off"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Your referral link</CardTitle>
            <CardDescription>While your tenant is active, a trader who signs up with your code joins your tenant and counts as yours.</CardDescription>
            <CardAction>
              <Button variant="ghost" size="sm" render={<Link href="/tenant/referrals" />}>
                Referrals
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="grid gap-4">
            {tenant.referralCode && link ? (
              <>
                <CopyField id="overview-code" label="Code" value={tenant.referralCode} />
                <CopyField id="overview-link" label="Link" value={link} />
                {tenant.status !== "active" ? (
                  <p className="text-sm text-warn-foreground">Your tenant is not active, so signup does not accept this code right now. Write to Nasscord&apos;s super admin.</p>
                ) : null}
              </>
            ) : (
              <EmptyState title="No referral code yet" description="Your tenant has no referral code. Write to Nasscord's super admin to have one added." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payouts</CardTitle>
            <CardDescription>Commission on your traders&apos; subscriptions.</CardDescription>
          </CardHeader>
          <CardContent>
            <EmptyState title="Payouts are not connected yet" description="Billing is not connected, so no commission has been earned or paid." />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Newest traders</CardTitle>
          <CardDescription>The last workspaces created with your code.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" render={<Link href="/tenant/traders" />}>
              All traders
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <EmptyState title="No traders yet" description="Share your referral link. Traders appear here once they finish signup with your code." />
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((w) => (
                <li key={w.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{w.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {w.owner.name || w.owner.email} · {fmtDay(w.createdAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <BrokerMarks ids={w.brokers} max={3} />
                    <PlanBadge plan={w.plan} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
