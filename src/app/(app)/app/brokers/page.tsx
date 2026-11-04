import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { BrokersManager } from "@/components/terminal/brokers-manager";

export const metadata: Metadata = { title: "Brokers" };

export default function Page() {
  return (
    <>
      <PageHeader title="Brokers" description="Your broker connections, their sessions, and which accounts count toward totals. Excluding an account hides it everywhere without disconnecting the broker." />
      <BrokersManager />
    </>
  );
}
