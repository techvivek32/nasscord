import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlansMatrixPage } from "@/components/tenant/plans-matrix";

export const metadata: Metadata = { title: "Plans · Tenant portal" };

export default function TenantPlansPage() {
  return (
    <>
      <PageHeader title="Plans" description="The plans and prices your traders see. Publish when you are ready." />
      <PlansMatrixPage />
    </>
  );
}
