import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsPage } from "@/components/partner/settings";
import { isSettingsTab } from "@/components/partner/settings-tab";

export const metadata: Metadata = { title: "Settings · Partners" };

export default async function PartnerSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return (
    <>
      <PageHeader title="Settings" description="Contacts, notifications, API keys and your agreement." />
      <SettingsPage initialTab={isSettingsTab(tab) ? tab : "contacts"} />
    </>
  );
}
