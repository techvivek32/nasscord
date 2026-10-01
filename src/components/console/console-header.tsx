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
import { useTenants, useUsers } from "@/hooks/queries";
import { maskEmail } from "@/lib/format";
import { PLAN_LABEL } from "@/lib/plans";
import { useConsoleStore } from "./store";
import { MAINTENANCE_WINDOW_INLINE, ROLE_LABEL } from "./lib";
import { TenantStatusBadge } from "./badges";

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
      <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={() => setOpen(true)} aria-label="Search tenants and users" aria-keyshortcuts="Meta+K Control+K" data-tour="console-search">
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
  const tenants = useTenants();
  const users = useUsers();
  const tenantName = React.useMemo(() => new Map((tenants.data ?? []).map((t) => [t.id, t.name] as const)), [tenants.data]);

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search the console" description="Find a tenant or a user and jump to it." className="sm:max-w-lg">
      <Command>
        <CommandInput placeholder="Search tenants, owners, users…" autoFocus />
        <CommandList>
          <CommandEmpty>{tenants.isLoading || users.isLoading ? "Loading…" : "No tenant or user matches."}</CommandEmpty>
          <CommandGroup heading="Tenants">
            {(tenants.data ?? []).map((t) => (
              <CommandItem key={t.id} value={`${t.name} ${t.slug} ${t.owner.name} ${t.owner.email} ${PLAN_LABEL[t.plan]}`} onSelect={() => go(`/admin/tenants/${t.id}`)}>
                <Building2 className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate">{t.name}</span>
                  <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{t.slug}</span>
                </span>
                <BrokerMarks ids={t.brokers} max={3} className="hidden sm:inline-flex" />
                <TenantStatusBadge status={t.status} />
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Users">
            {(users.data ?? []).map((u) => (
              <CommandItem key={u.id} value={`${u.name} ${u.email} ${tenantName.get(u.tenantId) ?? ""} ${ROLE_LABEL[u.role]}`} onSelect={() => go(`/admin/users?q=${encodeURIComponent(u.email)}`)}>
                <UserIcon className="text-muted-foreground" />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate">{u.name}</span>
                  <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{maskEmail(u.email)}</span>
                </span>
                <span className="text-xs text-muted-foreground">{tenantName.get(u.tenantId) ?? u.tenantId}</span>
                <Badge variant="outline">{ROLE_LABEL[u.role]}</Badge>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
