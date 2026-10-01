import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TraderDetail } from "@/components/console/trader-detail";
import { fetchTenant, fetchWorkspace } from "@/lib/api";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const workspace = await fetchWorkspace(id);
  return { title: workspace ? `${workspace.name} · Traders · Console` : "Trader not found · Console" };
}

export default async function TraderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await fetchWorkspace(id);
  if (!workspace) notFound();
  const tenant = workspace.tenantId ? await fetchTenant(workspace.tenantId) : null;
  return <TraderDetail initial={workspace} initialTenant={tenant} />;
}
