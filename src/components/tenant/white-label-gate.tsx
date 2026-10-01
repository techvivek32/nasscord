"use client";

import { toast } from "sonner";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/page-header";
import { fmtDate } from "@/lib/format";
import { useTenantStore } from "./store";

/**
 * Fallback for the white-label pages (Traders, Branding, Plans) when this tenant does not have it.
 * Only Nasscord's super admin can turn white-label on; the tenant can ask for it from here.
 */
export function WhiteLabelGate({ title, description }: { title: string; description: string }) {
  const requestedAt = useTenantStore((s) => s.whiteLabelRequestedAt);
  const requestWhiteLabel = useTenantStore((s) => s.requestWhiteLabel);

  return (
    <EmptyState
      title={title}
      description={`${description} White-label is turned on by Nasscord's super admin after a review.`}
      action={
        requestedAt ? (
          <Button variant="outline" disabled>
            <Check data-icon="inline-start" />
            Requested {fmtDate(requestedAt)}
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => {
              requestWhiteLabel();
              toast.success("White-label requested", { description: "Nasscord reviews the request and replies to your primary contact within two business days." });
            }}
          >
            Ask for white-label
          </Button>
        )
      }
    />
  );
}
