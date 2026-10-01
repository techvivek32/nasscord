import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "@/components/terminal/settings-tabs";
import { requireRole } from "@/lib/auth";
import { TERMINAL_ROLES } from "@/lib/roles";
import { getCurrentWorkspace } from "@/lib/tenant-server";

export const metadata: Metadata = { title: "Settings" };

export default async function Page() {
  const session = await requireRole(TERMINAL_ROLES, "/app/settings");
  const workspace = await getCurrentWorkspace();
  return (
    <>
      <PageHeader title="Settings" description="Profile, notifications, risk defaults, security and billing for this workspace." />
      <SettingsTabs
        user={{ name: session.name, email: session.email }}
        workspace={{ name: workspace.name, plan: workspace.plan, timezone: workspace.timezone, features: { options: workspace.features.options, extendedHours: workspace.features.extendedHours, paperDefault: workspace.features.paperDefault } }}
      />
    </>
  );
}
