"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, UserPlus, X } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useUsers, useWorkspaces } from "@/hooks/queries";
import { maskEmail, timeAgo } from "@/lib/format";
import { ROLES } from "@/lib/roles";
import type { Role, User, Workspace } from "@/lib/types";
import { RoleBadge, TwoFactorBadge } from "./badges";
import { DEMO_NOW, ROLE_LABEL, shortId } from "./lib";
import { TableSkeleton } from "./primitives";
import { useConsoleStore, useConsoleTenants } from "./store";

/** `workspaceLabel`: where the user trades, or the tenant a tenant login runs. `tenantLabel`: the tenant a tenant user belongs to. */
type Row = User & { workspaceLabel: string; tenantLabel: string };
type RoleFilter = "all" | Role;

/** The super admin and tenant logins are not seats in a workspace, so they are managed elsewhere. */
const isLocked = (role: Role) => role === "superadmin" || role === "tenant";

/** Roles follow where a user belongs: a workspace that came through a tenant makes them a tenant user. */
const roleForWorkspace = (w: Workspace | undefined): Role => (w?.tenantId ? "tenant_user" : "trader");

const inviteSchema = z.object({
  email: z.email("Enter a valid email address."),
  workspaceId: z.string().min(1, "Choose a workspace."),
});
type InviteInput = z.input<typeof inviteSchema>;
type InviteValues = z.output<typeof inviteSchema>;

export function UsersTable() {
  const users = useUsers();
  const workspaces = useWorkspaces();
  const { query: tenantsQuery, byId: tenantById } = useConsoleTenants();
  const search = useSearchParams();
  const router = useRouter();
  const focus = search.get("q") ?? "";
  const invited = useConsoleStore((s) => s.invitedUsers);
  const removed = useConsoleStore((s) => s.removedUserIds);
  const reset2fa = useConsoleStore((s) => s.reset2fa);
  const removeUser = useConsoleStore((s) => s.removeUser);
  const markReset2fa = useConsoleStore((s) => s.markReset2fa);
  const [role, setRole] = React.useState<RoleFilter>("all");
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pendingRemove, setPendingRemove] = React.useState<Row | null>(null);

  const workspaceName = React.useMemo(() => new Map((workspaces.data ?? []).map((w) => [w.id, w.name] as const)), [workspaces.data]);

  const all = React.useMemo<Row[]>(
    () =>
      [...invited, ...(users.data ?? [])]
        .filter((u) => !removed.includes(u.id))
        .filter((u) => !focus || u.email.toLowerCase() === focus.toLowerCase() || u.name.toLowerCase().includes(focus.toLowerCase()))
        .map((u) => {
          const tenantName = u.tenantId ? (tenantById.get(u.tenantId)?.name ?? u.tenantId) : "";
          const workspaceLabel = u.workspaceId ? (workspaceName.get(u.workspaceId) ?? u.workspaceId) : tenantName;
          // Only a tenant user belongs to a tenant; the other roles get a plain word instead of a name.
          const tenantLabel = u.role === "tenant_user" ? tenantName : u.role === "trader" ? "Organic" : u.role === "tenant" ? "Own login" : "Platform owner";
          return { ...u, twoFactor: reset2fa.includes(u.id) ? false : u.twoFactor, workspaceLabel, tenantLabel };
        }),
    [users.data, invited, removed, reset2fa, workspaceName, tenantById, focus],
  );
  const rows = React.useMemo(() => (role === "all" ? all : all.filter((u) => u.role === role)), [all, role]);

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      {
        id: "user",
        accessorFn: (u) => `${u.name} ${u.email}`,
        header: "User",
        cell: ({ row }) => (
          <div className="grid gap-0.5">
            <span className="font-medium">{row.original.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{maskEmail(row.original.email)}</span>
          </div>
        ),
      },
      { accessorKey: "role", header: "Role", cell: ({ row }) => <RoleBadge role={row.original.role} /> },
      {
        accessorKey: "workspaceLabel",
        header: "Workspace",
        cell: ({ row }) =>
          row.original.role === "tenant" ? (
            <div className="grid gap-0.5">
              <span>{row.original.workspaceLabel}</span>
              <span className="text-xs text-muted-foreground">Tenant portal, no workspace</span>
            </div>
          ) : (
            <span>{row.original.workspaceLabel}</span>
          ),
      },
      {
        accessorKey: "tenantLabel",
        header: "Tenant",
        cell: ({ row }) => <span className={row.original.role === "tenant_user" ? undefined : "text-muted-foreground"}>{row.original.tenantLabel}</span>,
      },
      { accessorKey: "twoFactor", header: "2FA", cell: ({ row }) => <TwoFactorBadge enabled={row.original.twoFactor} /> },
      { accessorKey: "lastActiveAt", header: "Last active", cell: ({ row }) => <span className="text-muted-foreground">{timeAgo(row.original.lastActiveAt, DEMO_NOW)}</span> },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => {
          const u = row.original;
          const locked = isLocked(u.role);
          return (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`} />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {/* The label is a Base UI Menu.GroupLabel: it throws outside a group. */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <span className="block truncate">{u.name}</span>
                    {locked ? <span className="block text-[11px] font-normal">{u.role === "superadmin" ? "The super admin account" : "Tenant login, managed on Tenants"}</span> : null}
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={locked || !u.twoFactor}
                    onClick={() => {
                      markReset2fa(u.id);
                      toast.success(`2FA reset for ${u.name}`, { description: "They will enroll a new authenticator at next sign-in." });
                    }}
                  >
                    Reset 2FA
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={locked} onClick={() => setPendingRemove(u)}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [markReset2fa],
  );

  if (users.isLoading || workspaces.isLoading || tenantsQuery.isLoading) return <TableSkeleton rows={8} cols={7} />;
  if (users.isError) return <EmptyState title="Users could not be loaded" action={<Button variant="outline" size="sm" onClick={() => users.refetch()}>Retry</Button>} />;

  return (
    <>
      {all.length === 0 ? (
        <EmptyState title="No users" description="Invite the first trader to a workspace to get started." action={<Button size="sm" onClick={() => setInviteOpen(true)}>Invite user</Button>} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          searchPlaceholder="Search name, email, workspace, tenant…"
          pageSize={10}
          emptyMessage="No users with this role."
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
                  <Button variant="outline" size="sm" onClick={() => router.replace("/admin/users")}>
                    <X data-icon="inline-start" />
                    <span className="max-w-40 truncate font-mono text-xs">{maskEmail(focus)}</span>
                  </Button>
                ) : null}
                <span className="hidden text-xs text-muted-foreground tabular sm:inline">
                  {rows.length} {rows.length === 1 ? "user" : "users"}
                </span>
                <Button size="sm" onClick={() => setInviteOpen(true)}>
                  <UserPlus data-icon="inline-start" />
                  Invite user
                </Button>
              </div>
            </div>
          }
        />
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <Dialog open={!!pendingRemove} onOpenChange={(o) => !o && setPendingRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingRemove?.name}?</DialogTitle>
            <DialogDescription>Their seat in {pendingRemove?.workspaceLabel} frees up immediately. Trade history stays with the workspace.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingRemove) {
                  removeUser(pendingRemove.id);
                  toast.success(`${pendingRemove.name} removed from ${pendingRemove.workspaceLabel}`);
                }
                setPendingRemove(null);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const workspaces = useWorkspaces();
  const { byId: tenantById } = useConsoleTenants();
  const addUser = useConsoleStore((s) => s.addUser);
  const workspaceItems = React.useMemo(() => (workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name })), [workspaces.data]);
  const form = useForm<InviteInput, unknown, InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", workspaceId: "" } });
  const { errors, isSubmitting } = form.formState;
  const workspaceId = useWatch({ control: form.control, name: "workspaceId" });
  const workspace = workspaces.data?.find((w) => w.id === workspaceId);
  const tenant = workspace?.tenantId ? tenantById.get(workspace.tenantId) : undefined;
  const role = roleForWorkspace(workspace);

  async function onSubmit(v: InviteValues) {
    await new Promise((r) => setTimeout(r, 300));
    const ws = workspaces.data?.find((w) => w.id === v.workspaceId);
    const derived = roleForWorkspace(ws);
    const local = v.email.split("@")[0];
    addUser({
      id: shortId("u"),
      name: local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      email: v.email,
      role: derived,
      workspaceId: v.workspaceId,
      tenantId: ws?.tenantId,
      twoFactor: false,
      lastActiveAt: DEMO_NOW.toISOString(),
      createdAt: DEMO_NOW.toISOString(),
    });
    toast.success(`Invitation sent to ${v.email}`, { description: `${ROLE_LABEL[derived]} in ${ws?.name ?? v.workspaceId}. Expires in 7 days.` });
    form.reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogDescription>They receive a one-time link and enroll 2FA on first sign-in.</DialogDescription>
        </DialogHeader>
        <form id="invite-user-form" onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" autoComplete="off" placeholder="name@company.com" aria-invalid={!!errors.email} {...form.register("email")} />
            {errors.email ? <p className="text-xs text-destructive" role="alert">{errors.email.message}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-workspace">Workspace</Label>
            <Controller
              control={form.control}
              name="workspaceId"
              render={({ field }) => (
                <Select items={workspaceItems} value={field.value || null} onValueChange={(v) => field.onChange(v ?? "")}>
                  <SelectTrigger id="invite-workspace" className="w-full" aria-invalid={!!errors.workspaceId} onBlur={field.onBlur}>
                    <SelectValue placeholder="Choose a workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaceItems.map((w) => (
                      <SelectItem key={w.value} value={w.value}>
                        {w.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.workspaceId ? <p className="text-xs text-destructive" role="alert">{errors.workspaceId.message}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium" id="invite-role-label">
              Role
            </span>
            <div className="flex flex-wrap items-center gap-2" aria-labelledby="invite-role-label">
              {workspace ? <RoleBadge role={role} /> : <span className="text-sm text-muted-foreground">Set by the workspace</span>}
            </div>
            <p className="text-xs text-muted-foreground">
              {workspace
                ? workspace.tenantId
                  ? `${workspace.name} came through ${tenant?.name ?? workspace.tenantId}, so they join as a tenant user${tenant?.whiteLabel ? ` and see ${tenant.branding?.name ?? tenant.name}'s brand` : ""}.`
                  : `${workspace.name} signed up directly, so they join as a trader.`
                : "Roles follow where a user belongs: a workspace that came through a tenant makes them a tenant user, otherwise a trader."}
            </p>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="invite-user-form" disabled={isSubmitting}>
            {isSubmitting ? "Sending" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
