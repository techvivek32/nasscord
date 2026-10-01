import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { WhiteLabelPage } from "@/components/console/white-label-page";

export const metadata: Metadata = { title: "White-label · Console" };

/** The super admin's white-label switch. The console layout already limits this route to CONSOLE_ROLES (the super admin). */
export default function WhiteLabelAdminPage() {
  return (
    <>
      <PageHeader
        title="White-label"
        description="Turn white-label on for a tenant and set the name, colors and domain their traders see. Only the super admin can do this."
        actions={<DemoFlag />}
      />
      <WhiteLabelPage />
    </>
  );
}
