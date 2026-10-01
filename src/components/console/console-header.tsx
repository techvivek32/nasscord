"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, Search, User as UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { DemoFlag } from "@/components/page-header";
import { BrokerMarks } from "@/components/brokers/broker-mark";
import { useUsers, useWorkspaces } from "@/hooks/queries";
import { maskEmail } from "@/lib/format";
import { PLAN_LABEL } from "@/lib/plans";
import { useConsoleStore, useConsoleTenants } from "./store";
import { MAINTENANCE_WINDOW_INLINE, ROLE_LABEL } from "./lib";
import { WorkspaceStatusBadge } from "./badges";

/** Console header: global search (⌘K), environment badge, maintenance banner, demo flag, account menu. */
export function ConsoleHeader({ user }: { user: ShellUser }) {
  const maintenanceOn = useConsoleStore((s) => s.maintenanceOn);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={() => setOpen(true)} aria-label="Search traders and users" aria-keyshortcuts="Meta+K Control+K" data-tour="console-search">
        <Search />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded border border-input bg-muted px-1 font-mono text-[10px] text-muted-foreground md:inline">⌘K</kbd>
      </Button>
      {maintenanceOn ? (
        <Badge variant="secondary" className="hidden bg-warn-soft text-warn-foreground lg:inline-flex">
          Maintenance · {MAINTENANCE_WINDOW_INLINE}
        </Badge>
      ) : null}
      <Badge variant="outline" className="hidden sm:inline-flex">
        Production
      </Badge>
      <DemoFlag className="hidden md:inline-flex" />
      <UserMenu user={user} settingsHref="/admin/settings" />
      <GlobalSearch open={open} onOpenChange={setOpen} />
    </>
  );
}

function GlobalSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const workspaces = useWorkspaces();
  const users = useUsers();
  const { byId: tenantById } = useConsoleTenants();
  const workspaceName = React.useMemo(() => new Map((workspaces.data ?? []).map((w) => [w.id, w.name] as const)), [workspaces.data]);
  /** Where a user belongs, for the right-hand column: their workspace, or the tenant a tenant login runs. */
  const placeOf = (u: { workspaceId?: string; tenantId?: string }) =>
    (u.workspaceId ? (workspaceName.get(u.workspaceId) ?? u.workspaceId) : undefined) ?? (u.tenantId ? (tenantById.get(u.tenantId)?.name ?? u.tenantId) : "");

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search the console" description="Find a trader or a user and jump to it." className="sm:max-w-lg">
      <Command>
        <CommandInput placeholder="Search traders, owners, users…" autoFocus />
        <CommandList>
          <CommandEmpty>{workspaces.isLoading || users.isLoading ? "Loading…" : "No trader or user matches."}</CommandEmpty>
          <CommandGroup heading="Traders">
            {(workspaces.data ?? []).map((w) => {
              const tenantName = w.tenantId ? (tenantById.get(w.tenantId)?.name ?? w.tenantId) : "Organic";
              return (
                <CommandItem key={w.id} value={`${w.name} ${w.slug} ${w.owner.name} ${w.owner.email} ${PLAN_LABEL[w.plan]} ${tenantName}`} onSelect={() => go(`/admin/traders/${w.id}`)}>
                  <Building2 className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{w.name}</span>
                    <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{w.slug}</span>
                  </span>
                  <BrokerMarks ids={w.brokers} max={3} className="hidden sm:inline-flex" />
                  <WorkspaceStatusBadge status={w.status} />
                </CommandItem>
              );
            })}
          </CommandGroup>
          <CommandGroup heading="Users">
            {(users.data ?? []).map((u) => (
              <CommandItem key={u.id} value={`${u.name} ${u.email} ${placeOf(u)} ${ROLE_LABEL[u.role]}`} onSelect={() => go(`/admin/users?q=${encodeURIComponent(u.email)}`)}>
                <UserIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate">{u.name}</span>
                  <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{maskEmail(u.email)}</span>
                </span>
                <span className="text-xs text-muted-foreground">{placeOf(u)}</span>
                <Badge variant="outline">{ROLE_LABEL[u.role]}</Badge>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
