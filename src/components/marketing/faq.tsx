"use client";

import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export interface FaqItem {
  q: string;
  a: React.ReactNode;
}

/** Accordion-style FAQ built from Collapsible items. The first item starts open. */
export function FaqList({ items, className, firstOpen = true }: { items: FaqItem[]; className?: string; firstOpen?: boolean }) {
  return (
    <div className={cn("divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10", className)}>
      {items.map((item, i) => (
        <Collapsible key={item.q} defaultOpen={firstOpen && i === 0} className="first:rounded-t-xl last:rounded-b-xl">
          <CollapsibleTrigger className="group/faq flex w-full items-center justify-between gap-4 px-5 py-4 text-left font-heading text-base font-medium outline-none first:rounded-t-xl hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset">
            <span>{item.q}</span>
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/faq:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="px-5 pb-5 text-sm leading-relaxed text-muted-foreground">{item.a}</CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}
