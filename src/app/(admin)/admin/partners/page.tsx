import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PartnersPage } from "@/components/console/partners-page";

export const metadata: Metadata = { title: "Partners · Console" };

export default function PartnersAdminPage() {
  return (
    <>
      <PageHeader title="Partners" description="White-label, referral and embedded partners, their applications and monthly payouts." />
      <PartnersPage />
    </>
  );
}
