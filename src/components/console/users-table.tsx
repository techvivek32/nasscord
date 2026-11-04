"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { X } from "lucide-react";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ROLES } from "@/lib/roles";
import type { Role, User } from "@/lib/types";
import { RoleBadge } from "./badges";
import { fmtDay, lastSignInLabel, ROLE_LABEL } from "./lib";

/** A member with the names of the workspace and tenant they belong to, resolved on the server. */
export type UserRow = User & { workspaceName: string | null; tenantName: string | null };
type RoleFilter = "all" | Role;

const COLUMNS: ColumnDef<UserRow>[] = [
  {
    id: "user",
    accessorFn: (u) => `${u.name} ${u.email}`,
    header: "User",
    cell: ({ row }) => (
      <div className="grid gap-0.5">
        <span className="font-medium">{row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.email}</span>
      </div>
    ),
  },
  { accessorKey: "role", header: "Role", cell: ({ row }) => <RoleBadge role={row.original.role} /> },
  {
    id: "workspace",
    accessorFn: (u) => u.workspaceName ?? "",
    header: "Workspace",
    cell: ({ row }) => {
      const u = row.original;
      if (u.workspaceId)
        return (
          <Link href={`/admin/traders/${u.workspaceId}`} className="underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
            {u.workspaceName ?? <span className="font-mono text-xs">{u.workspaceId}</span>}
          </Link>
        );
      return <span className="text-muted-foreground">{u.role === "tenant" ? "Tenant portal only" : "None"}</span>;
    },
  },
  {
    id: "tenant",
    accessorFn: (u) => u.tenantName ?? "",
    header: "Tenant",
    cell: ({ row }) => {
      const u = row.original;
      if (u.tenantId) return <span>{u.tenantName ?? <span className="font-mono text-xs">{u.tenantId}</span>}</span>;
      return <span className="text-muted-foreground">{u.role === "superadmin" ? "Platform owner" : "Organic"}</span>;
    },
  },
  {
    id: "lastActiveAt",
    accessorFn: (u) => u.lastActiveAt ?? "",
    header: "Last sign-in",
    cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{lastSignInLabel(row.original)}</span>,
  },
  { accessorKey: "createdAt", header: "Joined", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{fmtDay(row.original.createdAt)}</span> },
];

export function UsersTable({ rows, focus }: { rows: UserRow[]; focus: string }) {
  const router = useRouter();
  const [role, setRole] = React.useState<RoleFilter>("all");

  const focused = React.useMemo(() => {
    const f = focus.trim().toLowerCase();
    return f ? rows.filter((u) => u.email.toLowerCase() === f || u.name.toLowerCase().includes(f)) : rows;
  }, [rows, focus]);
  const shown = React.useMemo(() => (role === "all" ? focused : focused.filter((u) => u.role === role)), [focused, role]);

  if (rows.length === 0) return <EmptyState title="No users yet" description="Members appear here once someone finishes signup." />;

  return (
    <DataTable
      columns={COLUMNS}
      data={shown}
      searchPlaceholder="Search name, email, workspace, tenant…"
      pageSize={15}
      emptyMessage={focus ? "No user matches that search." : "No users with this role."}
      toolbar={
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <ToggleGroup
            variant="outline"
            spacing={0}
            value={[role]}
            onValueChange={(next) => {
              const v = next[0] as RoleFilter | undefined;
              if (v) setRole(v);
            }}
            aria-label="Filter by role"
            className="overflow-x-auto"
          >
            <ToggleGroupItem value="all" size="sm" className="px-3 data-pressed:bg-muted aria-pressed:bg-muted">
              All
            </ToggleGroupItem>
            {ROLES.map((r) => (
              <ToggleGroupItem key={r} value={r} size="sm" className="px-3 whitespace-nowrap data-pressed:bg-muted aria-pressed:bg-muted">
                {ROLE_LABEL[r]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="ml-auto flex items-center gap-2">
            {focus ? (
              <Button variant="outline" size="sm" onClick={() => router.replace("/admin/users")} aria-label="Show every user">
                <X data-icon="inline-start" />
                <span className="max-w-40 truncate font-mono text-xs">{focus}</span>
              </Button>
            ) : null}
            <span className="text-xs text-muted-foreground tabular">
              {shown.length} {shown.length === 1 ? "user" : "users"}
            </span>
          </div>
        </div>
      }
    />
  );
}
