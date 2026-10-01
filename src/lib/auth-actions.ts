"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_IDENTITIES, SESSION_COOKIE, homeForRole } from "@/lib/auth";
import type { Role, Session } from "@/lib/types";

async function setSession(session: Session) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, JSON.stringify(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

function roleFromEmail(email: string): Role {
  const e = email.toLowerCase();
  if (e.startsWith("ops@") || e.startsWith("admin@")) return "operator";
  if (e.startsWith("partner")) return "partner";
  return "owner";
}

function safeNext(next: unknown): string | null {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

/** Email + password sign-in. The demo accepts any password of 6+ characters. */
export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));
  if (!email.includes("@") || password.length < 6) {
    redirect(`/login?error=invalid${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }
  // The platform owner's address signs in as the super admin, whichever way he signs in.
  const owner = DEMO_IDENTITIES.superadmin;
  if (email.toLowerCase() === owner.email) {
    await setSession(owner);
    redirect(next ?? homeForRole(owner.role));
  }
  const role = roleFromEmail(email);
  const name = email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  await setSession({ uid: `u_${email.toLowerCase()}`, name, email, role, tenant: role === "partner" ? "acme" : "vivek" });
  redirect(next ?? homeForRole(role));
}

/** One-click demo identities (super admin / trader / operator / partner). */
export async function signInAs(kind: keyof typeof DEMO_IDENTITIES, next?: string) {
  const s = DEMO_IDENTITIES[kind];
  await setSession(s);
  redirect(safeNext(next) ?? homeForRole(s.role));
}

/** Called by the signup wizard once the workspace exists. Does not redirect; the wizard decides. */
export async function completeSignup(input: { name: string; email: string; tenantSlug: string }) {
  await setSession({ uid: `u_${input.email.toLowerCase()}`, name: input.name, email: input.email, role: "owner", tenant: input.tenantSlug });
  return { ok: true as const };
}

/**
 * Password reset request. Always answers the same way so the response never reveals
 * whether an address has an account. The demo sends nothing.
 */
export async function requestPasswordReset(input: { email: string }) {
  const email = input.email.trim();
  if (!email.includes("@")) return { ok: false as const, error: "Enter the email you signed up with." };
  return { ok: true as const };
}

/** Teammate invite from the signup wizard. The demo records nothing; the real version emails a join link. */
export async function inviteTeammate(input: { email: string; tenantSlug: string; invitedBy: string }) {
  const email = input.email.trim();
  if (!email.includes("@")) return { ok: false as const, error: "Enter a valid email address." };
  if (!input.tenantSlug) return { ok: false as const, error: "Create the workspace first." };
  return { ok: true as const, email };
}

export async function signOut() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/");
}
