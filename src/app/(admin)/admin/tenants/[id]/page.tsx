import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TenantDetail } from "@/components/console/tenant-detail";
import { fetchTenant } from "@/lib/api";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const tenant = await fetchTenant(id);
  return { title: tenant ? `${tenant.name} · Tenants · Console` : "Tenant not found · Console" };
}

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await fetchTenant(id);
  if (!tenant) notFound();
  return <TenantDetail initial={tenant} />;
}
