import { AppShell } from "@/components/layout/app-shell";
import { PartnerHeader } from "@/components/partner/partner-header";
import { PartnerSidebarFooter } from "@/components/partner/sidebar-footer";
import { requireRole } from "@/lib/auth";
import { PARTNER_PORTAL_ROLES, ROLE_LABEL, areasForRole } from "@/lib/roles";

/** Partner portal for white-label, referral and embedded partners. Staff may enter to support a partner. */
export default async function PartnerLayout({ children }: { children: React.ReactNode }) {
  const session = await requireRole(PARTNER_PORTAL_ROLES, "/partner", "/app");
  const user = { name: session.name, email: session.email, roleLabel: ROLE_LABEL[session.role] };

  return (
    <AppShell nav="partner" brandSub="Partners" brandHref="/partner" areas={areasForRole(session.role)} header={<PartnerHeader user={user} />} sidebarFooter={<PartnerSidebarFooter user={user} />}>
      {children}
    </AppShell>
  );
}
