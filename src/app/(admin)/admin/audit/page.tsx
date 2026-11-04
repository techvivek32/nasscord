import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { AuditTable } from "@/components/console/audit-table";
import { listAuditEvents } from "@/lib/server/console";

export const metadata: Metadata = { title: "Audit Log · Console" };

const LIMIT = 1000;

export default async function AuditPage() {
  const events = await listAuditEvents({ limit: LIMIT });
  return (
    <>
      <PageHeader title="Audit Log" description="Every recorded sign-in, broker connection step and console change, with actor, target and result. Newest first." />
      <AuditTable events={events} limit={LIMIT} />
    </>
  );
}
