"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, Search, User as UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { UserMenu, type ShellUser } from "@/components/layout/user-menu";
import { searchConsole, type MemberHit, type WorkspaceHit } from "@/lib/server/console-extra";
import { ROLE_LABEL } from "./lib";
import { PlanBadge, WorkspaceStatusBadge } from "./badges";

/** Console header: global search (Ctrl K), the deployment this is, account menu. */
export function ConsoleHeader({ user, environment }: { user: ShellUser; environment: string }) {
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
        <kbd className="hidden rounded border border-input bg-muted px-1 font-mono text-[10px] text-muted-foreground md:inline">Ctrl K</kbd>
      </Button>
      <Badge variant="outline" className="hidden sm:inline-flex">
        {environment}
      </Badge>
      <UserMenu user={user} settingsHref="/admin/settings" />
      {open ? <GlobalSearch onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type SearchState =
  | { phase: "idle" }
  | { phase: "loading"; query: string }
  | { phase: "done"; query: string; workspaces: WorkspaceHit[]; members: MemberHit[] }
  | { phase: "error"; query: string; error: string };

/** Mounted only while open, so every open starts empty. Results come from the database through a server function. */
function GlobalSearch({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [state, setState] = React.useState<SearchState>({ phase: "idle" });
  const timer = React.useRef<number | undefined>(undefined);
  const seq = React.useRef(0);

  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  function onQuery(value: string) {
    setQuery(value);
    window.clearTimeout(timer.current);
    const q = value.trim();
    const id = ++seq.current;
    if (q.length < 2) {
      setState({ phase: "idle" });
      return;
    }
    setState({ phase: "loading", query: q });
    timer.current = window.setTimeout(async () => {
      try {
        const r = await searchConsole(q);
        if (id !== seq.current) return;
        setState(r.ok ? { phase: "done", query: q, workspaces: r.workspaces, members: r.members } : { phase: "error", query: q, error: r.error });
      } catch {
        if (id === seq.current) setState({ phase: "error", query: q, error: "Search did not answer. Check your connection and try again." });
      }
    }, 250);
  }

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const workspaces = state.phase === "done" ? state.workspaces : [];
  const members = state.phase === "done" ? state.members : [];
  const message =
    state.phase === "idle"
      ? "Type at least 2 characters of a name, slug or email."
      : state.phase === "loading"
        ? "Searching…"
        : state.phase === "error"
          ? state.error
          : `Nothing matches “${state.query}”.`;

  return (
    <CommandDialog open onOpenChange={(o) => !o && onClose()} title="Search the console" description="Find a trader workspace or a user and jump to it." className="sm:max-w-lg">
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search traders, owners, users…" value={query} onValueChange={onQuery} autoFocus />
        <CommandList>
          <CommandEmpty>{message}</CommandEmpty>
          {workspaces.length ? (
            <CommandGroup heading="Traders">
              {workspaces.map((w) => (
                <CommandItem key={w.id} value={`ws-${w.id}`} onSelect={() => go(`/admin/traders/${w.id}`)}>
                  <Building2 className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{w.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {w.slug}
                      {w.ownerEmail ? ` · ${w.ownerEmail}` : ""}
                    </span>
                  </span>
                  <PlanBadge plan={w.plan} className="hidden sm:inline-flex" />
                  <WorkspaceStatusBadge status={w.status} />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {members.length ? (
            <CommandGroup heading="Users">
              {members.map((u) => (
                <CommandItem key={u.id} value={`user-${u.id}`} onSelect={() => go(`/admin/users?q=${encodeURIComponent(u.email)}`)}>
                  <UserIcon className="text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{u.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">{u.email}</span>
                  </span>
                  {u.place ? <span className="hidden max-w-32 truncate text-xs text-muted-foreground sm:inline">{u.place}</span> : null}
                  <Badge variant="outline">{ROLE_LABEL[u.role]}</Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
