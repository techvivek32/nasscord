"use client";

import * as React from "react";
import Link from "next/link";
import { LogOutIcon, SettingsIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { signOut } from "@/lib/auth-actions";
import { initials } from "@/lib/format";

export interface ShellUser {
  name: string;
  email: string;
  /** Shown under the email, e.g. "Super admin". */
  roleLabel?: string;
}

/** Avatar menu used by every area: identity, the area's settings page, sign out (server action through a form). */
export function UserMenu({ user, settingsHref }: { user: ShellUser; settingsHref: string }) {
  const signOutForm = React.useRef<HTMLFormElement>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="rounded-full" aria-label={`Account menu for ${user.name}`} data-tour="user-menu" />}>
        <Avatar>
          <AvatarFallback className="bg-brand-soft text-xs font-semibold text-primary">{initials(user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {/* The label is a Base UI Menu.GroupLabel: it throws outside a group. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">{user.name}</span>
            <span className="truncate font-normal">{user.email}</span>
            {user.roleLabel ? <span className="font-normal">{user.roleLabel}</span> : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem render={<Link href={settingsHref} />}>
            <SettingsIcon />
            Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <form ref={signOutForm} action={signOut}>
          <DropdownMenuItem variant="destructive" onClick={() => signOutForm.current?.requestSubmit()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
