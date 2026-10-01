"use client";

import Link from "next/link";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SHELL_AREAS, type ShellNavId } from "@/lib/nav";

/**
 * Sidebar control for people whose role opens more than one area (the super admin):
 * shows the area they are in and jumps to the others. Renders nothing for a single-area role.
 */
export function AreaSwitcher({ current, areas }: { current: ShellNavId; areas: ShellNavId[] }) {
  if (areas.length < 2) return null;
  const here = SHELL_AREAS[current];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            data-tour="area-switcher"
            aria-label={`Area: ${here.title}. Switch area`}
            className="h-9 w-full justify-start gap-2 px-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
          />
        }
      >
        <here.icon className="text-primary" />
        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium group-data-[collapsible=icon]:hidden">{here.title}</span>
        <ChevronsUpDownIcon className="text-muted-foreground group-data-[collapsible=icon]:hidden" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Switch area</DropdownMenuLabel>
          {areas.map((id) => {
            const area = SHELL_AREAS[id];
            return (
              <DropdownMenuItem key={id} className="items-start gap-2.5 py-1.5" render={<Link href={area.href} aria-current={id === current ? "page" : undefined} />}>
                <area.icon className="mt-0.5 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{area.title}</span>
                  <span className="text-xs text-muted-foreground">{area.description}</span>
                </span>
                {id === current ? <CheckIcon className="mt-0.5 text-primary" aria-hidden="true" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
