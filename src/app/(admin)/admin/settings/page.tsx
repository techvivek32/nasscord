import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SettingsPage } from "@/components/console/settings-page";

export const metadata: Metadata = { title: "Settings · Console" };

export default function SettingsAdminPage() {
  return (
    <>
      <PageHeader title="Settings" description="Platform identity, branding defaults, console security, API keys and email." />
      <SettingsPage />
    </>
  );
}
