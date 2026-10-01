import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlansMatrixPage } from "@/components/partner/plans-matrix";

export const metadata: Metadata = { title: "Plans · Partners" };

export default function PartnerPlansPage() {
  return (
    <>
      <PageHeader title="Plans" description="The plans and prices your traders see. Publish when you are ready." />
      <PlansMatrixPage />
    </>
  );
}
