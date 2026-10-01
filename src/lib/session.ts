import { isRole } from "@/lib/roles";
import type { Session } from "@/lib/types";

/* Session cookie shape. Pure: shared by proxy.ts and the server auth helpers. */

export const SESSION_COOKIE = "ns_session";

/** Parses the session cookie. Anything that is not a current-shape session (including a role that no longer exists) is no session. */
export function parseSession(raw: string | undefined): Session | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (!parsed.uid || !isRole(parsed.role)) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}
