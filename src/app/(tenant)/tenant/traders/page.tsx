import type { Metadata } from "next";
import { DemoFlag, PageHeader } from "@/components/page-header";
import { TradersPage } from "@/components/tenant/traders";
import { APP_DOMAIN } from "@/lib/tenant";

export const metadata: Metadata = { title: "Traders · Tenant portal" };

export default function TenantTradersPage() {
  return (
    <>
      <PageHeader title="Traders" description="Workspaces you run for your traders. They sign in under your brand." actions={<DemoFlag />} />
      <TradersPage appDomain={APP_DOMAIN} />
    </>
  );
}
