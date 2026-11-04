import { NextResponse, type NextRequest } from "next/server";
import { isRole } from "@/lib/roles";
import { updateSession } from "@/lib/supabase/proxy";
import { resolveHost } from "@/lib/tenant";

/** Areas that need a signed-in user with a role. Which role may open which area: src/lib/roles.ts, enforced by each layout. */
const PROTECTED = ["/app", "/admin", "/tenant"];

/**
 * Request proxy (Next.js 16 name for middleware).
 *  1. Host -> x-workspace (subdomain slug) / x-tenant (a custom domain, looked up on the server).
 *     Incoming copies of those headers are always replaced, so a client cannot set them.
 *  2. Refreshes the Supabase session cookies on every request.
 *  3. Gates /app, /admin and /tenant from the verified JWT claims (role in app_metadata):
 *     signed out -> /login?next=…; signed in without a role (signup unfinished) -> /signup.
 *     A claim role that does not fit the area is NOT redirected here: the JWT can be up to an hour
 *     older than a role change (createTenant, a console edit), and redirecting on it while the layout
 *     redirects on the members row loops forever. The area layout (requireRole) reads the members row,
 *     which is authoritative, and sends the user to their own home.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const host = resolveHost(request.headers.get("host"));
  const decorate = (headers: Headers) => {
    for (const [name, value] of [["x-workspace", host.workspace], ["x-tenant", host.tenantDomain]] as const) {
      if (value) headers.set(name, value);
      else headers.delete(name);
    }
  };

  const { response, claims, carry } = await updateSession(request, decorate);

  if (!PROTECTED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return response;

  const redirectTo = (path: string, next?: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    if (next) url.searchParams.set("next", next);
    const res = carry(NextResponse.redirect(url));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  };

  if (!claims) return redirectTo("/login", `${pathname}${search}`);
  // No role yet: signup is unfinished, or app_metadata lags the members row. /signup handles both
  // (step 2, or it copies the role from the members row into app_metadata and refreshes the session).
  if (!isRole(claims.app_metadata?.role)) return redirectTo("/signup");
  // Wrong area for the claim role: let the layout decide from the members row (see above).
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
