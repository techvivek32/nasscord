import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { Scanner } from "@/components/terminal/scanner";
import { ENGINE_DEFAULTS } from "@/lib/engine";

export const metadata: Metadata = { title: "Scanner" };

export default function Page() {
  return (
    <>
      <PageHeader
        title="Scanner"
        description={`Run the TradeScope filters yourself over the ${ENGINE_DEFAULTS.universeSize}-symbol universe on ${ENGINE_DEFAULTS.timeframe} bars. Open alerts show their live indicator values.`}
        actions={<DemoFlag />}
      />
      <Scanner />
    </>
  );
}
