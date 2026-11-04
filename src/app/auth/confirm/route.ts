import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { isSupabaseConfigured, safeNextPath } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const OTP_TYPES: ReadonlySet<string> = new Set(["signup", "email", "recovery", "invite", "magiclink", "email_change"]);

/**
 * Where each kind of link may land. An email link signs in whoever opens it as the account that owns
 * the token, so `next` is never free: someone could otherwise send a link for their own account
 * that drops the reader on a page acting for that account (an IBKR login, an API route). A recovery
 * link always goes to /login/reset; everything else goes to /signup (which forwards a set-up user to
 * their home) unless `next` is one of these pages exactly.
 */
const LANDINGS: ReadonlySet<string> = new Set(["/signup", "/login/reset", "/app", "/app/settings", "/admin", "/tenant", "/"]);

function landingFor(type: string | null, next: string | null): string {
  if (type === "recovery") return "/login/reset";
  const path = next?.split(/[?#]/)[0] ?? null;
  if (path && LANDINGS.has(path) && path !== "/login/reset") return path;
  // A PKCE `code` link carries no type: the reset flow sends next=/login/reset.
  if (!type && path === "/login/reset") return path;
  return "/signup";
}

/**
 * Landing route for the links in Supabase's emails (docs/real-backend.md section 3):
 *   /auth/confirm?token_hash=…&type=email&next=/signup        (confirm signup)
 *   /auth/confirm?token_hash=…&type=recovery&next=/login/reset (reset password)
 * verifyOtp signs the user in (cookies are written here), then the user goes to the landing for the
 * link's type (see LANDINGS). A `code` from the default PKCE templates is accepted too.
 * A used or expired link goes to /login with a message.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");
  const next = landingFor(tokenHash ? type : null, safeNextPath(params.get("next")));
  if (!isSupabaseConfigured()) redirect("/login?error=config");

  const supabase = await createClient();

  let ok = false;
  if (tokenHash && type && OTP_TYPES.has(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType });
    ok = !error;
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  }

  if (!ok) redirect(type === "recovery" || next === "/login/reset" ? "/login?error=reset-link" : "/login?error=link");
  redirect(next);
}
