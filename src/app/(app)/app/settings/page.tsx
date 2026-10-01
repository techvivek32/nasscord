import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "@/components/terminal/settings-tabs";
import { requireSession } from "@/lib/auth";
import { getCurrentTenant } from "@/lib/tenant-server";

export const metadata: Metadata = { title: "Settings" };

export default async function Page() {
  const session = await requireSession("/app/settings");
  const tenant = await getCurrentTenant();
  return (
    <>
      <PageHeader title="Settings" description="Profile, notifications, risk defaults, security and billing for this workspace." />
      <SettingsTabs
        user={{ name: session.name, email: session.email }}
        tenant={{ name: tenant.name, plan: tenant.plan, timezone: tenant.timezone, features: { options: tenant.features.options, extendedHours: tenant.features.extendedHours, paperDefault: tenant.features.paperDefault } }}
      />
    </>
  );
}
