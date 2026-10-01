"use client";

import { Plus } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface FaqItem {
  q: string;
  a: React.ReactNode;
}

/** Ruled FAQ list. Panels animate their height; the plus turns into a cross when open. The first item starts open. */
export function FaqList({ items, className, firstOpen = true }: { items: FaqItem[]; className?: string; firstOpen?: boolean }) {
  return (
    <div className={cn("border-t border-foreground", className)}>
      {items.map((item, i) => (
        <Collapsible key={item.q} defaultOpen={firstOpen && i === 0} className="group/faq border-b border-border">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-6 py-5 text-left text-[1.15rem] font-medium outline-none hover:text-site-accent-ink focus-visible:ring-3 focus-visible:ring-ring/50">
            <span>{item.q}</span>
            <Plus aria-hidden="true" className="size-5 shrink-0 transition-transform duration-300 group-data-[open]/faq:rotate-45" />
          </CollapsibleTrigger>
          <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-300 ease-out data-[ending-style]:h-0 data-[starting-style]:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
            <div className="max-w-[44rem] pb-6 leading-relaxed text-muted-foreground">{item.a}</div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
