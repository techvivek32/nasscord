import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { OptionsDesk } from "@/components/terminal/options-desk";

export const metadata: Metadata = { title: "Options" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Options"
        description="Call ideas built from the top open alerts, sized by a fixed capital-risk preset: 0.10, 0.15 or 0.20 percent of net liquidation per idea, with the stop at half the premium."
        actions={<DemoFlag />}
      />
      <OptionsDesk />
    </>
  );
}
