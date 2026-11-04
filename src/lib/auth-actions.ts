"use server";

import { redirect } from "next/navigation";
import type { AuthError, User } from "@supabase/supabase-js";
import { getAuthUser } from "@/lib/auth";
import { homeForRole, isRole } from "@/lib/roles";
import {
  accountSchema,
  createWorkspaceSchema,
  emailSchema,
  newPasswordSchema,
  RESERVED_SLUGS,
  settingsSchema,
  signInSchema,
  slugSchema,
  type ActionResult,
  type CreateWorkspaceInput,
  type SettingsValues,
} from "@/lib/signup";
import { audit } from "@/lib/server/audit";
import { rateLimit } from "@/lib/server/rate-limit";
import { emailLinkBase, requestIp } from "@/lib/server/request";
import { isAdminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseConfigured, safeNextPath, SUPABASE_NOT_CONFIGURED } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { getTenantByReferralCode, normalizeTenantCode } from "@/lib/tenant-server";
import type { Role, TenantBranding } from "@/lib/types";

/*
 * Auth and setup server actions on Supabase. Every action re-checks the caller itself: the proxy and
 * the layouts are not a security boundary for a POST. Writes to app tables use the service role after
 * that check (the schema has no insert/update policies). Errors are sentences a user can read; no
 * secret or token is ever logged or returned.
 */

const TOO_MANY = "Too many attempts. Wait a few minutes and try again.";
const SESSION_ENDED = "Your session ended. Sign in again to continue.";

function authMessage(error: AuthError | null | undefined, fallback: string): string {
  switch (error?.code) {
    case "invalid_credentials":
      return "That email and password did not match.";
    case "email_not_confirmed":
      return "Confirm your email first. Use the link we sent when you signed up, or send it again.";
    case "user_already_exists":
    case "email_exists":
      return "An account with this email already exists. Sign in instead.";
    case "weak_password":
      return "Choose a stronger password: at least 8 characters with upper and lower case letters, a number or a symbol.";
    case "same_password":
      return "Choose a password you have not used for this account before.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return TOO_MANY;
    case "signup_disabled":
    case "email_provider_disabled":
      return "New signups are switched off right now.";
    case "email_address_invalid":
    case "email_address_not_authorized":
      return "That email address cannot receive mail from us. Use another one.";
    case "session_not_found":
    case "session_expired":
      return SESSION_ENDED;
    default:
      return fallback;
  }
}

async function limited(kind: string, key: string, limit: number, windowMs: number): Promise<boolean> {
  const ip = (await requestIp()) ?? "unknown";
  return !rateLimit(`${kind}:${ip}:${key}`, limit, windowMs);
}

function superadminEmails(): Set<string> {
  return new Set(
    (process.env.NASSCORD_SUPERADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/* ---------------------------------------------------------------- sign in / out */

export interface SignInState {
  error?: string;
  /** The email still needs confirming: the form offers to send the link again. */
  unconfirmedEmail?: string;
  email?: string;
}

/** Email + password sign-in for useActionState. Redirects on success: to `next`, else the role's home, else /signup. */
export async function signIn(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNextPath(formData.get("next"));
  if (!isSupabaseConfigured()) return { error: SUPABASE_NOT_CONFIGURED, email };

  const parsed = signInSchema.safeParse({ email, password });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter your email and password.", email };
  if (await limited("signin", email.toLowerCase(), 10, 10 * 60_000)) return { error: TOO_MANY, email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error || !data.user) {
    if (error?.code === "invalid_credentials") {
      // Nobody is signed in: the typed address is the target, not the actor (anyone can type any address).
      await audit({ actorEmail: null, action: "auth.login", target: parsed.data.email.toLowerCase(), result: "denied" });
    }
    return {
      error: authMessage(error, "Sign-in failed. Try again in a moment."),
      email,
      ...(error?.code === "email_not_confirmed" ? { unconfirmedEmail: parsed.data.email } : {}),
    };
  }

  const role = data.user.app_metadata?.role;
  // The workspace from the members row (app_metadata can name one that was deleted since, which the
  // audit row's foreign key would refuse).
  const member = isAdminConfigured() ? await createAdminClient().from("members").select("workspace_id").eq("user_id", data.user.id).maybeSingle() : null;
  const workspaceId = typeof member?.data?.workspace_id === "string" ? member.data.workspace_id : null;
  await audit({ actorUserId: data.user.id, actorEmail: data.user.email, workspaceId, action: "auth.login" });
  redirect(isRole(role) ? (next ?? homeForRole(role)) : "/signup");
}

export async function signOut(): Promise<void> {
  if (isSupabaseConfigured()) {
    const user = await getAuthUser();
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" });
    if (user) await audit({ actorUserId: user.id, actorEmail: user.email, action: "auth.logout" });
  }
  redirect("/");
}

/* ---------------------------------------------------------------- signup, confirmation, reset */

/** Step 1 of signup. Supabase emails a confirmation link to /auth/confirm, which returns the user to /signup. */
export async function signUpAccount(input: { fullName: string; email: string; password: string; tenantCode?: string }): Promise<ActionResult<{ needsConfirmation: boolean; email: string }>> {
  if (!isSupabaseConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const parsed = accountSchema.safeParse({ ...input, tenantCode: input.tenantCode ?? "" });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form and try again.", field: issue?.path[0]?.toString() };
  }
  const { fullName, email, password } = parsed.data;
  if (await limited("signup", "", 5, 10 * 60_000)) return { ok: false, error: TOO_MANY };

  const code = normalizeTenantCode(parsed.data.tenantCode);
  if (parsed.data.tenantCode && !code) return { ok: false, field: "tenantCode", error: "Codes are 3 to 24 letters, numbers or hyphens." };
  if (code && !(await getTenantByReferralCode(code))) return { ok: false, field: "tenantCode", error: "That code does not match an active tenant. Check it or leave it empty." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${await emailLinkBase()}/auth/confirm?next=/signup`,
      data: { full_name: fullName, ...(code ? { tenant_code: code } : {}) },
    },
  });
  if (error) return { ok: false, error: authMessage(error, "We could not create the account. Try again in a moment."), field: error.code === "weak_password" ? "password" : undefined };
  // An address that already has an account gets a stand-in user with a random id and no identities
  // (Supabase hides which addresses exist). That id is in no table, so it is not written as the actor.
  if (data.user) {
    const real = (data.user.identities?.length ?? 0) > 0;
    const meta = { ...(code ? { tenant_code: code } : {}), ...(real ? {} : { existing_address: true }) };
    await audit({
      actorUserId: real ? data.user.id : null,
      actorEmail: real ? email.toLowerCase() : null,
      action: "auth.signup",
      target: real ? null : email.toLowerCase(),
      meta: Object.keys(meta).length ? meta : null,
    });
  }
  // With confirmation on, there is no session until the link is opened. An existing address gets the same answer.
  return { ok: true, needsConfirmation: !data.session, email };
}

export async function resendConfirmation(input: { email: string }): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const parsed = emailSchema.safeParse(input.email?.trim());
  if (!parsed.success) return { ok: false, field: "email", error: "Enter a valid email address." };
  if (await limited("resend", parsed.data.toLowerCase(), 3, 10 * 60_000)) return { ok: false, error: TOO_MANY };
  const supabase = await createClient();
  const { error } = await supabase.auth.resend({ type: "signup", email: parsed.data, options: { emailRedirectTo: `${await emailLinkBase()}/auth/confirm?next=/signup` } });
  if (error && (error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit")) return { ok: false, error: TOO_MANY };
  // Any other outcome reads the same, so the answer never tells whether the address has an account.
  return { ok: true };
}

/** Always answers the same way so the response never reveals whether an address has an account. */
export async function requestPasswordReset(input: { email: string }): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const parsed = emailSchema.safeParse(input.email?.trim());
  if (!parsed.success) return { ok: false, field: "email", error: "Enter the email you signed up with." };
  if (await limited("reset", parsed.data.toLowerCase(), 3, 15 * 60_000)) return { ok: false, error: TOO_MANY };
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data, { redirectTo: `${await emailLinkBase()}/auth/confirm?next=/login/reset` });
  if (error && (error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit")) return { ok: false, error: TOO_MANY };
  return { ok: true };
}

/** Sign-in methods in the session's `amr` claim that come from an email link (a reset link is "recovery"). */
const EMAIL_LINK_METHODS: ReadonlySet<string> = new Set(["recovery", "otp", "magiclink"]);
/** How long after opening the reset link a new password may be set. */
const RESET_WINDOW_S = 60 * 60;

/**
 * True when the session was signed in by an email link within the last hour, false when it was not,
 * null when the token carries no `amr` claim at all (then the check is skipped: Supabase always
 * sends it, so a stolen token has it too).
 */
async function openedResetLinkRecently(supabase: Awaited<ReturnType<typeof createClient>>): Promise<boolean | null> {
  try {
    const { data } = await supabase.auth.getClaims();
    const amr: unknown = data?.claims?.amr;
    if (!Array.isArray(amr)) return null;
    const now = Math.floor(Date.now() / 1000);
    return amr.some((e: unknown) => {
      const entry = e && typeof e === "object" ? (e as { method?: unknown; timestamp?: unknown }) : null;
      return !!entry && typeof entry.method === "string" && EMAIL_LINK_METHODS.has(entry.method) && typeof entry.timestamp === "number" && now - entry.timestamp <= RESET_WINDOW_S;
    });
  } catch {
    return null;
  }
}

/**
 * Sets a new password for the signed-in user, only right after a reset link signed them in: a
 * session from a password sign-in (a stolen cookie, an unlocked laptop) cannot change it.
 */
export async function updatePassword(input: { password: string }): Promise<ActionResult<{ next: string }>> {
  if (!isSupabaseConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const parsed = newPasswordSchema.safeParse(input.password);
  if (!parsed.success) return { ok: false, field: "password", error: parsed.error.issues[0]?.message ?? "Choose a stronger password." };
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return { ok: false, error: "This reset link has expired. Request a new one from the sign-in page." };
  if (await limited("password", user.id, 5, 15 * 60_000)) return { ok: false, error: TOO_MANY };
  if ((await openedResetLinkRecently(supabase)) === false) {
    await audit({ actorUserId: user.id, actorEmail: user.email, action: "auth.password.update", result: "denied" });
    return { ok: false, error: "To change your password, open a fresh reset link: request one from the sign-in page, then set the new password within an hour." };
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) return { ok: false, field: "password", error: authMessage(error, "We could not change the password. Try again in a moment.") };
  await audit({ actorUserId: user.id, actorEmail: user.email, action: "auth.password.update" });
  const role = user.app_metadata?.role;
  return { ok: true, next: isRole(role) ? homeForRole(role) : "/signup" };
}

/* ---------------------------------------------------------------- tenant code and slug lookups */

/** What a signup code resolves to: the tenant's name, and its brand when it has white-label. */
export async function lookupTenantCode(code: string): Promise<ActionResult<{ tenant: { name: string; branding: TenantBranding | null } | null }>> {
  const clean = normalizeTenantCode(code);
  if (!clean) return { ok: true, tenant: null };
  if (await limited("tenant-code", "", 40, 10 * 60_000)) return { ok: false, error: TOO_MANY };
  const tenant = await getTenantByReferralCode(clean);
  if (!tenant) return { ok: true, tenant: null };
  return { ok: true, tenant: { name: tenant.name, branding: tenant.whiteLabel && tenant.branding ? tenant.branding : null } };
}

/** Whether a workspace subdomain is free. Needs a signed-in user (signup step 2). */
export async function checkSlugAvailable(slug: string): Promise<ActionResult<{ available: boolean; reason?: string }>> {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return { ok: true, available: false, reason: parsed.error.issues[0]?.message };
  if (RESERVED_SLUGS.has(parsed.data)) return { ok: true, available: false, reason: "That subdomain is reserved. Try another." };
  if (!isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const user = await getAuthUser();
  if (!user) return { ok: false, error: SESSION_ENDED };
  if (await limited("slug", user.id, 60, 5 * 60_000)) return { ok: false, error: TOO_MANY };
  const { data, error } = await createAdminClient().from("workspaces").select("id").eq("slug", parsed.data).maybeSingle();
  if (error) return { ok: false, error: "We could not check that subdomain. Try again in a moment." };
  return data ? { ok: true, available: false, reason: "That subdomain is taken. Try another." } : { ok: true, available: true };
}

/* ---------------------------------------------------------------- workspace creation */

type ServerClient = Awaited<ReturnType<typeof createClient>>;
type AdminClient = ReturnType<typeof createAdminClient>;
/** The access fields of a members row, which is the source of truth for the role. */
type MemberAccess = { role: Role; workspace_id: string | null; tenant_id: string | null; slug: string };

const ACCESS_NOT_SAVED = "Your workspace is set up, but we could not update your sign-in. Try again in a moment.";

/** The caller's members row (service role), null when there is none, or "error" when the read failed. */
async function readMemberAccess(admin: AdminClient, userId: string): Promise<MemberAccess | null | "error"> {
  const { data, error } = await admin.from("members").select("role, workspace_id, tenant_id, workspaces(slug)").eq("user_id", userId).maybeSingle();
  if (error) return "error";
  if (!data || !isRole(data.role)) return null;
  const ws = (data as { workspaces?: { slug?: string } | { slug?: string }[] | null }).workspaces;
  const slug = Array.isArray(ws) ? (ws[0]?.slug ?? "") : (ws?.slug ?? "");
  return { role: data.role, workspace_id: (data.workspace_id as string | null) ?? null, tenant_id: (data.tenant_id as string | null) ?? null, slug };
}

/**
 * Makes app_metadata and the session JWT agree with the members row: rewrites app_metadata when it
 * differs (a failed earlier write, or a role changed by the console), then refreshes the session when
 * the JWT in the cookies is stale, so the proxy reads the right role on the next request. Returns a
 * sentence for the user when either step fails, else null. Safe to call repeatedly.
 */
async function alignAccess(supabase: ServerClient, admin: AdminClient, user: User, member: MemberAccess): Promise<string | null> {
  const want = { role: member.role, workspace_id: member.workspace_id, tenant_id: member.tenant_id };
  const have = (user.app_metadata ?? {}) as Record<string, unknown>;
  const metaStale = have.role !== want.role || (have.workspace_id ?? null) !== want.workspace_id || (have.tenant_id ?? null) !== want.tenant_id;
  if (metaStale) {
    const meta = await admin.auth.admin.updateUserById(user.id, { app_metadata: want });
    if (meta.error) {
      console.error(`[signup] app_metadata update failed: ${meta.error.code ?? "unknown error"}`);
      return ACCESS_NOT_SAVED;
    }
  }

  let claimRole: unknown;
  try {
    const { data } = await supabase.auth.getClaims();
    claimRole = data?.claims?.app_metadata?.role;
  } catch {
    claimRole = undefined;
  }
  if (metaStale || claimRole !== want.role) {
    // A new JWT carries the current app_metadata; @supabase/ssr writes it to the cookies of this response.
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data.session) {
      console.error(`[signup] session refresh failed: ${error?.code ?? "no session"}`);
      return ACCESS_NOT_SAVED;
    }
  }
  return null;
}

/**
 * Step 2 of signup: creates the workspace and the member row, writes the role into app_metadata and
 * refreshes the session so the next request carries it. A valid tenant code makes the user a
 * tenant user of that tenant; an email in NASSCORD_SUPERADMIN_EMAILS with a confirmed address becomes
 * the super admin. Calling it again after success returns the existing setup, and first repairs
 * app_metadata and the session from the members row if an earlier call could not write them.
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<ActionResult<{ role: Role; slug: string; home: string }>> {
  if (!isSupabaseConfigured() || !isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const parsed = createWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form and try again.", field: issue?.path[0]?.toString() };
  }
  const values = parsed.data;

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user?.email) return { ok: false, error: SESSION_ENDED };
  const email = user.email.toLowerCase();
  const admin = createAdminClient();

  // Already set up (a retry, or a second tab): repair the sign-in if needed, then return what exists.
  const existing = await readMemberAccess(admin, user.id);
  if (existing === "error") return { ok: false, error: "We could not read your account. Try again in a moment." };
  if (existing) {
    const failed = await alignAccess(supabase, admin, user, existing);
    if (failed) return { ok: false, error: failed };
    return { ok: true, role: existing.role, slug: existing.slug, home: homeForRole(existing.role) };
  }

  if (await limited("workspace", user.id, 10, 10 * 60_000)) return { ok: false, error: TOO_MANY };
  if (RESERVED_SLUGS.has(values.slug)) return { ok: false, field: "slug", error: "That subdomain is reserved. Try another." };

  // Listed, and confirmed through a link Supabase emailed (confirmation_sent_at is set only when one
  // was sent). With "Confirm email" off, Supabase marks every address confirmed at once, so a listed
  // address nobody has claimed yet could otherwise be taken by whoever registers it first.
  const confirmedByEmail = Boolean(user.email_confirmed_at) && Boolean(user.confirmation_sent_at);
  const isSuperadmin = superadminEmails().has(email) && confirmedByEmail;
  if (superadminEmails().has(email) && !confirmedByEmail) {
    console.error("[signup] a NASSCORD_SUPERADMIN_EMAILS address signed up without an emailed confirmation; turn Confirm email on (docs/SETUP.md step 3). Not promoted.");
  }
  const code = isSuperadmin ? null : normalizeTenantCode(values.tenantCode);
  const tenant = code ? await getTenantByReferralCode(code) : null;
  if (code && !tenant) return { ok: false, field: "tenantCode", error: "That code does not match an active tenant. Check it or leave it empty." };
  const role: Role = isSuperadmin ? "superadmin" : tenant ? "tenant_user" : "trader";

  const taken = await admin.from("workspaces").select("id").eq("slug", values.slug).maybeSingle();
  if (taken.error) return { ok: false, error: "We could not check that subdomain. Try again in a moment." };
  if (taken.data) return { ok: false, field: "slug", error: "That subdomain is taken. Try another." };

  const created = await admin
    .from("workspaces")
    .insert({
      slug: values.slug,
      name: values.name,
      plan: values.plan,
      status: values.plan === "starter" ? "active" : "trial",
      tenant_id: tenant?.id ?? null,
      timezone: values.timezone,
      owner_id: user.id,
    })
    .select("id")
    .single();
  if (created.error || !created.data) {
    if (created.error?.code === "23505") return { ok: false, field: "slug", error: "That subdomain is taken. Try another." };
    console.error(`[signup] workspace insert failed: ${created.error?.code ?? "unknown error"}`);
    return { ok: false, error: "We could not create the workspace. Try again in a moment." };
  }
  const workspaceId = created.data.id as string;
  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim().slice(0, 80) : "";

  const member = await admin.from("members").insert({
    user_id: user.id,
    role,
    workspace_id: workspaceId,
    tenant_id: role === "tenant_user" ? (tenant?.id ?? null) : null,
    full_name: fullName,
    email,
  });
  if (member.error) {
    await admin.from("workspaces").delete().eq("id", workspaceId);
    console.error(`[signup] member insert failed: ${member.error.code ?? "unknown error"}`);
    return { ok: false, error: "We could not finish setting up your account. Try again in a moment." };
  }

  const settings = await admin.from("user_settings").upsert({ user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true });
  if (settings.error) console.error(`[signup] settings insert failed: ${settings.error.code ?? "unknown error"}`);

  await audit({
    actorUserId: user.id,
    actorEmail: email,
    workspaceId,
    action: "workspace.create",
    target: values.slug,
    meta: { plan: values.plan, role, ...(tenant ? { tenant_id: tenant.id } : {}) },
  });

  // Role into app_metadata, then a new JWT in the cookies, so the proxy lets the user into their area.
  // On failure the rows stay: a retry (or /signup on the next visit, via syncAccess) repairs it from them.
  const failed = await alignAccess(supabase, admin, user, {
    role,
    workspace_id: workspaceId,
    tenant_id: role === "tenant_user" ? (tenant?.id ?? null) : null,
    slug: values.slug,
  });
  if (failed) return { ok: false, error: failed };
  return { ok: true, role, slug: values.slug, home: homeForRole(role) };
}

/**
 * For a signed-in user who has a members row but whose session lacks that role (app_metadata was never
 * written, or a console change is not in the JWT yet). Copies the role from the members row into
 * app_metadata and refreshes the session, so the proxy stops sending them back to /signup. The signup
 * page calls it before it forwards a set-up user to their home.
 */
export async function syncAccess(): Promise<ActionResult<{ home: string }>> {
  if (!isSupabaseConfigured() || !isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return { ok: false, error: SESSION_ENDED };
  if (await limited("sync-access", user.id, 20, 10 * 60_000)) return { ok: false, error: TOO_MANY };
  const admin = createAdminClient();
  const member = await readMemberAccess(admin, user.id);
  if (member === "error") return { ok: false, error: "We could not read your account. Try again in a moment." };
  if (!member) return { ok: false, error: "Finish creating your workspace first." };
  const failed = await alignAccess(supabase, admin, user, member);
  if (failed) return { ok: false, error: failed };
  return { ok: true, home: homeForRole(member.role) };
}

/* ---------------------------------------------------------------- settings */

/** Saves the signed-in user's trading defaults (signup step 4 and the terminal's Settings page). */
export async function saveUserSettings(input: SettingsValues): Promise<ActionResult> {
  if (!isSupabaseConfigured() || !isAdminConfigured()) return { ok: false, error: SUPABASE_NOT_CONFIGURED };
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the settings and try again.", field: issue?.path[0]?.toString() };
  }
  const user = await getAuthUser();
  if (!user) return { ok: false, error: SESSION_ENDED };
  const admin = createAdminClient();

  const member = await admin.from("members").select("workspace_id").eq("user_id", user.id).maybeSingle();
  if (!member.data) return { ok: false, error: "Finish creating your workspace first." };

  const s = parsed.data;
  if (s.defaultAccountId) {
    const account = await admin.from("broker_accounts").select("id").eq("id", s.defaultAccountId).eq("workspace_id", member.data.workspace_id ?? "").maybeSingle();
    if (!account.data) return { ok: false, field: "defaultAccountId", error: "That account is not in your workspace." };
  }

  const { error } = await admin.from("user_settings").upsert(
    {
      user_id: user.id,
      risk_pct: s.riskPct,
      paper_mode: s.paperMode,
      extended_hours: s.extendedHours,
      email_alerts: s.emailAlerts,
      push_alerts: s.pushAlerts,
      sms_alerts: s.smsAlerts,
      ...(s.defaultAccountId !== undefined ? { default_account_id: s.defaultAccountId } : {}),
    },
    { onConflict: "user_id" },
  );
  if (error) return { ok: false, error: "We could not save your settings. Try again in a moment." };
  await audit({ actorUserId: user.id, actorEmail: user.email, workspaceId: member.data.workspace_id, action: "settings.update", target: "trading defaults" });
  return { ok: true };
}
