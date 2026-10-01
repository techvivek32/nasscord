import { NextResponse, type NextRequest } from "next/server";
import { CONSOLE_ROLES, PARTNER_PORTAL_ROLES } from "@/lib/roles";
import { resolveTenantSlug } from "@/lib/tenant";
import type { Session } from "@/lib/types";

const SESSION_COOKIE = "ns_session";
const PROTECTED: Array<{ prefix: string; roles?: Session["role"][] }> = [
  { prefix: "/app" },
  { prefix: "/admin", roles: CONSOLE_ROLES },
  { prefix: "/partner", roles: PARTNER_PORTAL_ROLES },
];

/**
 * Request proxy (Next.js 16 name for middleware).
 *  1. Resolve the tenant from the host and forward it as x-tenant.
 *  2. Optimistic auth gate: no session cookie -> /login?next=…; wrong role -> /app.
 * Real authorization still happens in server components and actions.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  const slug = resolveTenantSlug(request.headers.get("host"));
  if (slug) requestHeaders.set("x-tenant", slug);
  else requestHeaders.delete("x-tenant");

  const rule = PROTECTED.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
  if (rule) {
    const raw = request.cookies.get(SESSION_COOKIE)?.value;
    let session: Session | null = null;
    if (raw) {
      try {
        session = JSON.parse(raw) as Session;
      } catch {
        session = null;
      }
    }
    if (!session) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    if (rule.roles && !rule.roles.includes(session.role)) {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
