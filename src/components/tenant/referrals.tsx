import { EmptyState } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtNum } from "@/lib/format";
import type { Tenant } from "@/lib/types";
import { CopyField } from "./copy-field";

/** The tenant's code and link, and what is known about who used it: the workspaces created with it. */
export function ReferralsPage({ tenant, link, traders }: { tenant: Tenant; link: string | null; traders: number }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Code and link</CardTitle>
            <CardDescription>Share the link, or give traders the code to type at signup. Either one makes the new workspace yours.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {tenant.referralCode && link ? (
              <>
                <CopyField id="referral-code" label="Code" value={tenant.referralCode} />
                <CopyField id="referral-link" label="Link" value={link} />
                {tenant.status !== "active" ? (
                  <p className="text-sm text-warn-foreground">Your tenant is not active, so signup does not accept this code right now. Write to Nasscord&apos;s super admin.</p>
                ) : null}
              </>
            ) : (
              <EmptyState title="No referral code yet" description="Your tenant has no referral code. Write to Nasscord's super admin to have one added." />
            )}
          </CardContent>
        </Card>
        <StatCard label="Signed up with your code" value={fmtNum(traders)} hint={<span className="text-[11px] text-muted-foreground">workspaces</span>} className="self-start" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Funnel</CardTitle>
          <CardDescription>Clicks, signups, trials and paid conversions.</CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState title="Attribution is not tracked yet" description="Link clicks and trials are not recorded, so only the finished signups above are known." />
        </CardContent>
      </Card>
    </div>
  );
}
