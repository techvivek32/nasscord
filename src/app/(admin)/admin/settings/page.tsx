import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsPage, type PlatformConfig } from "@/components/console/settings-page";
import { requireRole } from "@/lib/auth";
import { APP_DOMAIN, DEFAULT_BRANDING } from "@/lib/branding";
import { CONSOLE_ROLES, ROLE_LABEL } from "@/lib/roles";

export const metadata: Metadata = { title: "Settings · Console" };

function hostOf(url: string | undefined) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Origin and path only: never credentials or a query string that could carry one. */
function safeUrl(url: string | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

export default async function SettingsAdminPage() {
  const session = await requireRole(CONSOLE_ROLES, "/admin");
  const config: PlatformConfig = {
    platformName: DEFAULT_BRANDING.name,
    appDomain: APP_DOMAIN,
    siteUrl: safeUrl(process.env.NEXT_PUBLIC_SITE_URL),
    accent: DEFAULT_BRANDING.accent,
    accentDark: DEFAULT_BRANDING.accentDark,
    supabaseHost: hostOf(process.env.NEXT_PUBLIC_SUPABASE_URL),
    serviceRoleKeySet: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    brokerServiceUrl: safeUrl(process.env.BROKER_SERVICE_URL),
    brokerServiceSecretSet: Boolean(process.env.BROKER_SERVICE_SECRET),
    superadminEmails: (process.env.NASSCORD_SUPERADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    account: { name: session.name, email: session.email, role: ROLE_LABEL[session.role] },
  };
  return (
    <>
      <PageHeader title="Settings" description="The platform's configuration as this server sees it. These come from environment variables: change them in the hosting project and redeploy." />
      <SettingsPage config={config} />
    </>
  );
}
