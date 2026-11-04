import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { UsersTable, type UserRow } from "@/components/console/users-table";
import { listMembers, listTenants } from "@/lib/server/console";
import { listWorkspaceRefs } from "@/lib/server/console-extra";

export const metadata: Metadata = { title: "Users · Console" };

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, members, workspaces, tenants] = await Promise.all([searchParams, listMembers(), listWorkspaceRefs(), listTenants()]);
  const workspaceName = new Map(workspaces.map((w) => [w.id, w.name]));
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]));
  const rows: UserRow[] = members.map((u) => ({
    ...u,
    workspaceName: u.workspaceId ? (workspaceName.get(u.workspaceId) ?? null) : null,
    tenantName: u.tenantId ? (tenantName.get(u.tenantId) ?? null) : null,
  }));
  return (
    <>
      <PageHeader title="Users" description="Everyone who can sign in: the super admin, tenants, traders and tenant users. Roles follow where a user belongs." />
      <UsersTable rows={rows} focus={typeof q === "string" ? q.slice(0, 200) : ""} />
    </>
  );
}
