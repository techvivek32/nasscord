import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { homeForRole } from "@/lib/roles";
import { SESSION_COOKIE, parseSession } from "@/lib/session";
import type { Session } from "@/lib/types";

/**
 * Demo authentication. A JSON cookie stands in for Supabase GoTrue.
 * Server-only helpers live here; the mutating server actions live in auth-actions.ts.
 * Replace the internals with the real provider; the rest of the app only depends on `Session`.
 */
export { SESSION_COOKIE };

/** One demo login per role. The login page shows a button for each. */
export const DEMO_IDENTITIES: Record<Session["role"], Session> = {
  // The platform owner. One login for everything: console, tenant portal and his own desk in the terminal.
  superadmin: { uid: "u_vivek", name: "Vivek Desai", email: "vivek@nasscord.com", role: "superadmin", workspace: "vivek" },
  // A distributor with white-label switched on: their portal, no terminal.
  tenant: { uid: "u_dana", name: "Dana Whitfield", email: "dana@acmecap.com", role: "tenant", tenantId: "t_acme" },
  // An organic trader who signed up on nasscord.com.
  trader: { uid: "u_jordan", name: "Jordan Martin", email: "jordan.martin@gmail.com", role: "trader", workspace: "jmartin" },
  // A trader who came through Acme Capital, so the terminal wears Acme's brand.
  tenant_user: { uid: "u_raj", name: "Raj Menon", email: "raj@acmecap.com", role: "tenant_user", workspace: "acme", tenantId: "t_acme" },
};

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return parseSession(jar.get(SESSION_COOKIE)?.value);
}

/** Redirects to /login when there is no session. Use in layouts of protected route groups. */
export async function requireSession(next = "/app"): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(`/login?next=${encodeURIComponent(next)}`);
  return s;
}

/** Signed in with one of `roles`, or sent to their own home (never to an area they cannot open). */
export async function requireRole(roles: Session["role"][], next = "/app"): Promise<Session> {
  const s = await requireSession(next);
  if (!roles.includes(s.role)) redirect(homeForRole(s.role));
  return s;
}

export { homeForRole } from "@/lib/roles";
