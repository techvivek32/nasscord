import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { TenantSettings } from "@/components/tenant/settings";
import { NoTenant } from "@/components/tenant/no-tenant";
import { loadPortal } from "@/components/tenant/scope";

export const metadata: Metadata = { title: "Settings · Tenant portal" };

export default async function TenantSettingsPage() {
  const { session, tenant } = await loadPortal();
  return (
    <>
      <PageHeader title="Settings" description="Your tenant's record and the account you sign in with." />
      {tenant ? <TenantSettings tenant={tenant} session={session} /> : <NoTenant session={session} />}
    </>
  );
}
