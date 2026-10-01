import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { RevenuePage } from "@/components/console/revenue-page";

export const metadata: Metadata = { title: "Revenue · Console" };

export default function RevenueAdminPage() {
  return (
    <>
      <PageHeader title="Revenue" description="Recurring revenue against infrastructure cost, and how it splits across plans." />
      <RevenuePage />
    </>
  );
}
