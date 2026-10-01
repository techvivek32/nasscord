import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { BrokersPage } from "@/components/console/brokers-page";

export const metadata: Metadata = { title: "Brokers · Console" };

export default function BrokersAdminPage() {
  return (
    <>
      <PageHeader title="Brokers" description="Integration status, OAuth clients, rate limits and gateway pools for the 12 brokers in the registry." />
      <BrokersPage />
    </>
  );
}
