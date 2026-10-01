import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { AuditTable } from "@/components/console/audit-table";

export const metadata: Metadata = { title: "Audit Log · Console" };

export default function AuditPage() {
  return (
    <>
      <PageHeader title="Audit Log" description="Every operator, owner and system action with actor, target and result. Retained for 7 years." />
      <AuditTable />
    </>
  );
}
