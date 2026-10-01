"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Logo } from "@/components/brand/logo";
import { AreaSwitcher } from "@/components/layout/area-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tour, TourButton } from "@/components/tour/tour";
import { SHELL_NAVS, type ShellNavId } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * Generic application shell used by the terminal, the console and the partner portal.
 * Sidebar nav is picked by id from SHELL_NAVS (the config holds icon components, so server layouts
 * pass the id, not the config); header slot for page-specific controls.
 * Active item = exact match for the group's root href, prefix match for everything else.
 * `areas` lists the areas the signed-in role may open (lib/roles); more than one shows the switcher.
 * The shell also hosts the area's intro tour and the button that replays it.
 */
export function AppShell({
  nav: navId,
  brandName = "Nasscord",
  brandSub,
  brandHref = "/",
  areas,
  sidebarFooter,
  header,
  headerTitle,
  children,
  defaultOpen = true,
}: {
  nav: ShellNavId;
  brandName?: string;
  brandSub?: string;
  brandHref?: string;
  areas?: ShellNavId[];
  sidebarFooter?: React.ReactNode;
  header?: React.ReactNode;
  headerTitle?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const pathname = usePathname();
  const nav = SHELL_NAVS[navId];
  const rootHref = nav[0]?.items[0]?.href;

  const isActive = (href: string) => {
    if (href === rootHref) return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const currentTitle = React.useMemo(() => {
    for (const g of nav) for (const it of g.items) if (isActive(it.href)) return it.title;
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, nav]);

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="icon">
        <SidebarHeader className="px-3 pt-3">
          <Logo name={brandName} sub={brandSub} href={brandHref} className="group-data-[collapsible=icon]:[&>span:not(:first-child)]:hidden" />
          {areas ? <AreaSwitcher current={navId} areas={areas} /> : null}
        </SidebarHeader>
        <SidebarContent>
          {nav.map((group, gi) => (
            <SidebarGroup key={group.label ?? gi} data-tour={`nav-group-${gi}`}>
              {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton isActive={isActive(item.href)} tooltip={item.title} render={<Link href={item.href} />}>
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        {sidebarFooter ? <SidebarFooter>{sidebarFooter}</SidebarFooter> : null}
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur-md sm:px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <div className="min-w-0 truncate font-heading text-sm font-semibold sm:text-base">{headerTitle ?? currentTitle}</div>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            {header}
            <TourButton id={navId} />
            <ThemeToggle />
          </div>
        </header>
        <div className={cn("flex flex-1 flex-col gap-5 p-3 sm:p-4 lg:p-6")}>{children}</div>
      </SidebarInset>
      <Tour id={navId} />
    </SidebarProvider>
  );
}
