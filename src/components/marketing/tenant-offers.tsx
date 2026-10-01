import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { TENANT_OFFERS } from "@/lib/plans";
import type { TenantBranding, TenantOfferId } from "@/lib/types";
import { LogoMark } from "@/components/brand/logo";
import { TenantTheme } from "@/components/tenant-theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Section anchors on /tenants. Shared so the home cards and the footer link to the same ids. */
export const TENANT_ANCHOR: Record<TenantOfferId, string> = {
  commission: "commission",
  white_label: "white-label",
};

/** Short label for who gets each offer: commission comes with every tenant, white-label is granted on top. */
export const TENANT_OFFER_BADGE: Record<TenantOfferId, string> = {
  commission: "Every tenant",
  white_label: "Add-on",
};

/**
 * Miniature re-skinned terminal header. Wrapped in TenantTheme, every token-driven part (logo tile,
 * primary button, brand-soft chip) takes the tenant accent without any component knowing about tenants.
 */
export function WhiteLabelPreview({ branding, className }: { branding: TenantBranding; className?: string }) {
  return (
    <TenantTheme branding={branding}>
      <div className={cn("overflow-hidden rounded-lg border border-border bg-background", className)} aria-label={`${branding.name} preview`}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <LogoMark size={20} />
          <span className="font-heading text-sm font-bold tracking-tight">{branding.name}</span>
          <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground sm:inline">{branding.domain}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-primary">Score 100</span>
          <span className="font-mono text-xs font-semibold">AVGO</span>
          <span className="truncate text-[11px] text-muted-foreground">Strong uptrend (ADX 31)</span>
          <Button size="xs" className="ml-auto pointer-events-none" tabIndex={-1} aria-hidden="true">
            Buy
          </Button>
        </div>
      </div>
    </TenantTheme>
  );
}

/** What a tenant gets, as cards: commission for every tenant, white-label as the add-on. The white-label card embeds the re-skinned preview when branding is supplied. */
export function TenantOfferCards({ preview, className }: { preview?: TenantBranding | null; className?: string }) {
  return (
    <div className={cn("grid gap-4 lg:grid-cols-2", className)}>
      {TENANT_OFFERS.map((m) => (
        <Card key={m.id} className="h-full gap-5">
          <CardHeader className="gap-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-lg font-semibold">{m.name}</CardTitle>
              <Badge variant="secondary">{TENANT_OFFER_BADGE[m.id]}</Badge>
            </div>
            <CardDescription className="leading-relaxed">{m.summary}</CardDescription>
          </CardHeader>
          <CardContent className="grid flex-1 content-start gap-4">
            <p className="text-sm font-medium">{m.pricing}</p>
            {m.id === "white_label" && preview ? <WhiteLabelPreview branding={preview} /> : null}
            <ul className="grid gap-2 text-sm text-muted-foreground">
              {m.bullets.map((b) => (
                <li key={b} className="flex gap-2">
                  <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <Link
              href={`/tenants#${TENANT_ANCHOR[m.id]}`}
              className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              Read about {m.name.toLowerCase()}
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
