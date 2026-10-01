import type { TenantBranding, TenantOfferId } from "@/lib/types";
import { LogoMark } from "@/components/brand/logo";
import { TenantTheme } from "@/components/tenant-theme";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Section anchors on /tenants. Shared so the home blocks and the footer link to the same ids. */
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
      <div className={cn("overflow-hidden border border-border bg-background", className)} aria-label={`${branding.name} preview`}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <LogoMark size={20} />
          <span className="text-sm font-semibold">{branding.name}</span>
          <span className="ml-auto hidden font-mono text-[10px] text-muted-foreground sm:inline">{branding.domain}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-primary">Score 100</span>
          <span className="font-mono text-xs font-semibold">AVGO</span>
          <span className="truncate text-[11px] text-muted-foreground">Strong uptrend (ADX 31)</span>
          <Button size="xs" className="pointer-events-none ml-auto" tabIndex={-1} aria-hidden="true">
            Buy
          </Button>
        </div>
      </div>
    </TenantTheme>
  );
}
