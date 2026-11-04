"use server";

import { getSession } from "@/lib/auth";
import { TERMINAL_ROLES } from "@/lib/roles";
import type { ActionResult } from "@/lib/signup";
import { audit } from "@/lib/server/audit";
import { rateLimit } from "@/lib/server/rate-limit";
import { emailLinkBase } from "@/lib/server/request";
import { isSupabaseConfigured, SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/types";

/*
 * Server actions for the terminal: the broker connect flow outside the terminal layout, and the
 * signed-in password reset. Only async functions are exported (every export is a callable
 * endpoint), and each one checks the session itself.
 */

/**
 * The signed-in member's workspace scope for client queries (WorkspaceScopeProvider), or null when
 * the member has no trading workspace. Onboarding step 3 runs outside the terminal layout, which
 * normally provides it from the session.
 */
export async function getBrokerScope(): Promise<{ workspaceId: string; userId: string; role: Role } | null> {
  const session = await getSession();
  if (!session?.workspaceId || !TERMINAL_ROLES.includes(session.role)) return null;
  return { workspaceId: session.workspaceId, userId: session.uid, role: session.role };
}

/**
 * Sends a password reset link to the signed-in user's own address (Settings, Security). Unlike the
 * signed-out requestPasswordReset in src/lib/auth-actions.ts, which answers the same way whatever
 * happens so it never reveals whether an address has an account, this one reports Supabase's
 * error: the address is the caller's own, so there is nothing to hide, and the page must not say
 * an email went out when it did not.
 */
export async function sendMyPasswordReset(): Promise<ActionResult<{ email: string }>> {
  if (!isSupabaseConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const session = await getSession();
  if (!session) return { ok: false, error: "Your session ended. Sign in again to continue." };
  if (!TERMINAL_ROLES.includes(session.role)) return { ok: false, error: "Password resets from the terminal are for terminal accounts." };
  if (!session.email) return { ok: false, error: "This account has no email address to send the link to." };
  if (!rateLimit(`reset-signed-in:${session.uid}`, 3, 15 * 60_000)) return { ok: false, error: "Too many reset emails. Wait a few minutes and try again." };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(session.email, { redirectTo: `${await emailLinkBase()}/auth/confirm?next=/login/reset` });
  if (error) {
    const limited = error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit";
    await audit({ actorUserId: session.uid, actorEmail: session.email, workspaceId: session.workspaceId ?? null, action: "auth.password.reset_request", result: "error", meta: { code: error.code ?? null } });
    return {
      ok: false,
      error: limited ? "Too many reset emails. Wait a few minutes and try again." : "The reset email could not be sent. Try again in a few minutes, and if it keeps failing, tell your workspace owner.",
    };
  }
  await audit({ actorUserId: session.uid, actorEmail: session.email, workspaceId: session.workspaceId ?? null, action: "auth.password.reset_request" });
  return { ok: true, email: session.email };
}
