import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { BrokersManager } from "@/components/terminal/brokers-manager";

export const metadata: Metadata = { title: "Brokers" };

export default function Page() {
  return (
    <>
      <PageHeader title="Brokers" description="Connections, sessions and which accounts count toward totals and sizing. Excluding an account hides it everywhere without disconnecting the broker." actions={<DemoFlag />} />
      <BrokersManager />
    </>
  );
}
