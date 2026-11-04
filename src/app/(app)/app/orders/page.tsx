import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { OrdersTable } from "@/components/terminal/orders-table";

export const metadata: Metadata = { title: "Orders" };

export default function Page() {
  return (
    <>
      <PageHeader title="Orders" description="Working, filled and cancelled orders from your brokers' order books for the included accounts in view." />
      <OrdersTable />
    </>
  );
}
