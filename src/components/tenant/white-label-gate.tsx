import { EmptyState } from "@/components/page-header";

/** Shown on Branding when the tenant does not have white-label. Only Nasscord's super admin turns it on. */
export function WhiteLabelGate({ title, description }: { title: string; description: string }) {
  return <EmptyState title={title} description={`${description} White-label is turned on by Nasscord's super admin; write to them to ask for it.`} />;
}
