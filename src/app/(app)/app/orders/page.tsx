import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { OrdersTable } from "@/components/terminal/orders-table";

export const metadata: Metadata = { title: "Orders" };

export default function Page() {
  return (
    <>
      <PageHeader title="Orders" description="Working, filled and cancelled orders from every broker in scope. Verified means the order was read back from the broker's own order book." actions={<DemoFlag />} />
      <OrdersTable />
    </>
  );
}
