import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Session } from "@/lib/types";

/**
 * Demo authentication. A JSON cookie stands in for Supabase GoTrue.
 * Server-only helpers live here; the mutating server actions live in auth-actions.ts.
 * Replace the internals with the real provider; the rest of the app only depends on `Session`.
 */
export const SESSION_COOKIE = "ns_session";

export const DEMO_IDENTITIES: Record<"superadmin" | "trader" | "operator" | "partner", Session> = {
  // The platform owner. One login for everything: console, partner portal and his own desk in the terminal.
  superadmin: { uid: "u_vivek", name: "Vivek Desai", email: "vivek@nasscord.com", role: "superadmin", tenant: "vivek" },
  // The same desk as a plain workspace owner: what a customer sees, with no console access.
  trader: { uid: "u_vivek", name: "Vivek Desai", email: "vivek@nasscord.com", role: "owner", tenant: "vivek" },
  operator: { uid: "u_ops", name: "Platform Operator", email: "ops@nasscord.com", role: "operator", tenant: "vivek" },
  partner: { uid: "u_acme", name: "Acme Partnerships", email: "partners@acmecap.com", role: "partner", tenant: "acme" },
};

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.uid || !parsed.role) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

/** Redirects to /login when there is no session. Use in layouts of protected route groups. */
export async function requireSession(next = "/app"): Promise<Session> {
  const s = await getSession();
  if (!s) redirect(`/login?next=${encodeURIComponent(next)}`);
  return s;
}

export async function requireRole(roles: Session["role"][], next = "/app", fallback = "/app"): Promise<Session> {
  const s = await requireSession(next);
  if (!roles.includes(s.role)) redirect(fallback);
  return s;
}

export { homeForRole } from "@/lib/roles";
