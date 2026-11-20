import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TraderDetail } from "@/components/console/trader-detail";
import { getTenant, getWorkspace, getWorkspaceOrderEntry, listAuditEvents, listBrokerConnectionsAll, listMembers, listWorkspaceOrderRequests } from "@/lib/server/console";

const loadWorkspace = cache((id: string) => getWorkspace(id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const workspace = await loadWorkspace(id);
  return { title: workspace ? `${workspace.name} · Traders · Console` : "Trader not found · Console" };
}

export default async function TraderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await loadWorkspace(id);
  if (!workspace) notFound();
  const [tenant, members, connections, events, orderEntry, orderRows] = await Promise.all([
    workspace.tenantId ? getTenant(workspace.tenantId) : Promise.resolve(null),
    listMembers({ workspaceId: workspace.id }),
    listBrokerConnectionsAll({ workspaceId: workspace.id }),
    listAuditEvents({ workspaceId: workspace.id, limit: 50 }),
    getWorkspaceOrderEntry(workspace.id),
    listWorkspaceOrderRequests(workspace.id),
  ]);
  return (
    <TraderDetail
      workspace={workspace}
      tenant={tenant}
      members={members}
      connections={connections}
      events={events}
      orderEntry={orderEntry}
      orderRows={orderRows}
    />
  );
}
