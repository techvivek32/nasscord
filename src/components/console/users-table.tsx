"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, UserPlus, X } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTenants, useUsers } from "@/hooks/queries";
import { maskEmail, timeAgo } from "@/lib/format";
import { isStaff } from "@/lib/roles";
import type { Role, User } from "@/lib/types";
import { RoleBadge, TwoFactorBadge } from "./badges";
import { DEMO_NOW, ROLE_LABEL, shortId } from "./lib";
import { TableSkeleton } from "./primitives";
import { useConsoleStore } from "./store";

type Row = User & { tenantName: string };

const TENANT_ROLES: Role[] = ["owner", "trader", "viewer"];
const ROLE_ITEMS = TENANT_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));

const inviteSchema = z.object({
  email: z.email("Enter a valid email address."),
  tenantId: z.string().min(1, "Choose a tenant."),
  role: z.enum(["owner", "trader", "viewer"], { error: "Choose a role." }),
});
type InviteInput = z.input<typeof inviteSchema>;
type InviteValues = z.output<typeof inviteSchema>;

export function UsersTable() {
  const users = useUsers();
  const tenants = useTenants();
  const search = useSearchParams();
  const router = useRouter();
  const focus = search.get("q") ?? "";
  const invited = useConsoleStore((s) => s.invitedUsers);
  const removed = useConsoleStore((s) => s.removedUserIds);
  const roles = useConsoleStore((s) => s.userRoles);
  const reset2fa = useConsoleStore((s) => s.reset2fa);
  const setUserRole = useConsoleStore((s) => s.setUserRole);
  const removeUser = useConsoleStore((s) => s.removeUser);
  const markReset2fa = useConsoleStore((s) => s.markReset2fa);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pendingRemove, setPendingRemove] = React.useState<Row | null>(null);

  const tenantName = React.useMemo(() => new Map((tenants.data ?? []).map((t) => [t.id, t.name] as const)), [tenants.data]);

  const rows = React.useMemo<Row[]>(
    () =>
      [...invited, ...(users.data ?? [])]
        .filter((u) => !removed.includes(u.id))
        .filter((u) => !focus || u.email.toLowerCase() === focus.toLowerCase() || u.name.toLowerCase().includes(focus.toLowerCase()))
        .map((u) => ({ ...u, role: roles[u.id] ?? u.role, twoFactor: reset2fa.includes(u.id) ? false : u.twoFactor, tenantName: tenantName.get(u.tenantId) ?? u.tenantId })),
    [users.data, invited, removed, roles, reset2fa, tenantName, focus],
  );

  const columns = React.useMemo<ColumnDef<Row>[]>(
    () => [
      { accessorKey: "name", header: "Name", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      { accessorKey: "email", header: "Email", cell: ({ row }) => <span className="font-mono text-xs">{maskEmail(row.original.email)}</span> },
      { accessorKey: "tenantName", header: "Tenant" },
      { accessorKey: "role", header: "Role", cell: ({ row }) => <RoleBadge role={row.original.role} /> },
      { accessorKey: "twoFactor", header: "2FA", cell: ({ row }) => <TwoFactorBadge enabled={row.original.twoFactor} /> },
      { accessorKey: "lastActiveAt", header: "Last active", cell: ({ row }) => <span className="text-muted-foreground">{timeAgo(row.original.lastActiveAt, DEMO_NOW)}</span> },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) => {
          const u = row.original;
          // Platform staff (operators and the super admin) are managed outside the tenant roles.
          const isOperator = isStaff(u.role);
          return (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`} />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {/* The label is a Base UI Menu.GroupLabel: it throws outside a group. */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{u.name}</DropdownMenuLabel>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={isOperator}>Change role</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {TENANT_ROLES.map((r) => (
                        <DropdownMenuItem
                          key={r}
                          disabled={r === u.role}
                          onClick={() => {
                            setUserRole(u.id, r);
                            toast.success(`${u.name} is now ${ROLE_LABEL[r].toLowerCase()} in ${u.tenantName}`);
                          }}
                        >
                          {ROLE_LABEL[r]}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem
                    disabled={!u.twoFactor}
                    onClick={() => {
                      markReset2fa(u.id);
                      toast.success(`2FA reset for ${u.name}`, { description: "They will enroll a new authenticator at next sign-in." });
                    }}
                  >
                    Reset 2FA
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={isOperator} onClick={() => setPendingRemove(u)}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [setUserRole, markReset2fa],
  );

  if (users.isLoading || tenants.isLoading) return <TableSkeleton rows={8} cols={7} />;
  if (users.isError) return <EmptyState title="Users could not be loaded" action={<Button variant="outline" size="sm" onClick={() => users.refetch()}>Retry</Button>} />;

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="No users" description="Invite the first user to a tenant to get started." action={<Button size="sm" onClick={() => setInviteOpen(true)}>Invite user</Button>} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          searchPlaceholder="Search name, email, tenant…"
          pageSize={10}
          toolbar={
            <div className="ml-auto flex items-center gap-2">
              {focus ? (
                <Button variant="outline" size="sm" onClick={() => router.replace("/admin/users")}>
                  <X data-icon="inline-start" />
                  <span className="max-w-40 truncate font-mono text-xs">{maskEmail(focus)}</span>
                </Button>
              ) : null}
              <span className="hidden text-xs text-muted-foreground tabular sm:inline">{rows.length} users</span>
              <Button size="sm" onClick={() => setInviteOpen(true)}>
                <UserPlus data-icon="inline-start" />
                Invite user
              </Button>
            </div>
          }
        />
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <Dialog open={!!pendingRemove} onOpenChange={(o) => !o && setPendingRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingRemove?.name}?</DialogTitle>
            <DialogDescription>Their seat in {pendingRemove?.tenantName} frees up immediately. Trade history stays with the workspace.</DialogDescription>
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
                  toast.success(`${pendingRemove.name} removed from ${pendingRemove.tenantName}`);
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
  const tenants = useTenants();
  const addUser = useConsoleStore((s) => s.addUser);
  const tenantItems = React.useMemo(() => (tenants.data ?? []).map((t) => ({ value: t.id, label: t.name })), [tenants.data]);
  const form = useForm<InviteInput, unknown, InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", tenantId: "", role: "trader" } });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(v: InviteValues) {
    await new Promise((r) => setTimeout(r, 300));
    const tenant = tenants.data?.find((t) => t.id === v.tenantId);
    const local = v.email.split("@")[0];
    addUser({
      id: shortId("u"),
      name: local.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      email: v.email,
      role: v.role,
      tenantId: v.tenantId,
      twoFactor: false,
      lastActiveAt: DEMO_NOW.toISOString(),
      createdAt: DEMO_NOW.toISOString(),
    });
    toast.success(`Invitation sent to ${v.email}`, { description: `${ROLE_LABEL[v.role]} in ${tenant?.name ?? v.tenantId}. Expires in 7 days.` });
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
            <Label htmlFor="invite-tenant">Tenant</Label>
            <Controller
              control={form.control}
              name="tenantId"
              render={({ field }) => (
                <Select items={tenantItems} value={field.value || null} onValueChange={(v) => field.onChange(v ?? "")}>
                  <SelectTrigger id="invite-tenant" className="w-full" aria-invalid={!!errors.tenantId} onBlur={field.onBlur}>
                    <SelectValue placeholder="Choose a workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenantItems.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.tenantId ? <p className="text-xs text-destructive" role="alert">{errors.tenantId.message}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Select items={ROLE_ITEMS} value={field.value ?? null} onValueChange={(v) => field.onChange(v ?? undefined)}>
                  <SelectTrigger id="invite-role" className="w-full" aria-invalid={!!errors.role} onBlur={field.onBlur}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_ITEMS.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">Owners manage billing and seats. Traders place orders. Viewers see positions only.</p>
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
