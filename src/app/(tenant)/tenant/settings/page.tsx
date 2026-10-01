import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsPage } from "@/components/tenant/settings";
import { isSettingsTab } from "@/components/tenant/settings-tab";

export const metadata: Metadata = { title: "Settings · Tenant portal" };

export default async function TenantSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return (
    <>
      <PageHeader title="Settings" description="Contacts, notifications, API keys and your tenant agreement." />
      <SettingsPage initialTab={isSettingsTab(tab) ? tab : "contacts"} />
    </>
  );
}
