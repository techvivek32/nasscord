import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/page-header";
import { SettingsTabs } from "@/components/terminal/settings-tabs";
import { requireRole } from "@/lib/auth";
import { PLAN_LABEL } from "@/lib/plans";
import { TERMINAL_ROLES } from "@/lib/roles";
import { getCurrentWorkspace, getMySettings } from "@/lib/server/workspace";

export const metadata: Metadata = { title: "Settings" };

export default async function Page() {
  const session = await requireRole(TERMINAL_ROLES, "/app/settings");
  const [workspace, settings] = await Promise.all([getCurrentWorkspace(), getMySettings()]);
  return (
    <>
      <PageHeader title="Settings" description="Your profile, notifications, risk per trade, password and billing." />
      {workspace ? (
        <SettingsTabs
          user={{ name: session.name, email: session.email }}
          workspace={{ name: workspace.name, planLabel: PLAN_LABEL[workspace.plan], timezone: workspace.timezone }}
          settings={{
            riskPct: settings.riskPct,
            paperMode: settings.paperMode,
            extendedHours: settings.extendedHours,
            emailAlerts: settings.emailAlerts,
            pushAlerts: settings.pushAlerts,
            smsAlerts: settings.smsAlerts,
          }}
        />
      ) : (
        <EmptyState title="No workspace" description="This account has no trading workspace, so there is nothing to configure here." />
      )}
    </>
  );
}
