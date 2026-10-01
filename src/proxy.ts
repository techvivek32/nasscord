import { NextResponse, type NextRequest } from "next/server";
import { CONSOLE_ROLES, TENANT_PORTAL_ROLES, TERMINAL_ROLES, homeForRole } from "@/lib/roles";
import { SESSION_COOKIE, parseSession } from "@/lib/session";
import { resolveHost } from "@/lib/tenant";
import type { Role } from "@/lib/types";

const PROTECTED: Array<{ prefix: string; roles: Role[] }> = [
  { prefix: "/app", roles: TERMINAL_ROLES },
  { prefix: "/admin", roles: CONSOLE_ROLES },
  { prefix: "/tenant", roles: TENANT_PORTAL_ROLES },
];

/**
 * Request proxy (Next.js 16 name for middleware).
 *  1. Resolve the host and forward it as x-workspace (subdomain) / x-tenant (white-label custom domain).
 *  2. Optimistic auth gate: no session cookie -> /login?next=…; wrong role -> that role's own home.
 * Real authorization still happens in server components and actions.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestHeaders = new Headers(request.headers);
  const host = resolveHost(request.headers.get("host"));
  for (const [name, value] of [["x-workspace", host.workspace], ["x-tenant", host.tenantId]] as const) {
    if (value) requestHeaders.set(name, value);
    else requestHeaders.delete(name);
  }

  const rule = PROTECTED.find((r) => pathname === r.prefix || pathname.startsWith(`${r.prefix}/`));
  if (rule) {
    const session = parseSession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      url.searchParams.set("next", pathname);
      return NextResponse.redirect(url);
    }
    if (!rule.roles.includes(session.role)) {
      const url = request.nextUrl.clone();
      url.pathname = homeForRole(session.role);
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
