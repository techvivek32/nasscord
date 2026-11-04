import { z } from "zod";
import type { PlanId } from "@/lib/types";

/* ------------------------------------------------------------------
   Account, workspace and settings rules shared by the signup wizard,
   the login page and the server actions in src/lib/auth-actions.ts.
   Pure: safe to import from client and server code.
   ------------------------------------------------------------------ */

/* Password rules shown as hints and used by the 4-segment strength meter. */
export const PASSWORD_RULES = [
  { id: "length", label: "At least 8 characters", test: (p: string) => p.length >= 8 },
  { id: "case", label: "Upper and lower case letters", test: (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { id: "number", label: "A number", test: (p: string) => /\d/.test(p) },
  { id: "symbol", label: "A symbol", test: (p: string) => /[^A-Za-z0-9]/.test(p) },
] as const;

export function passwordScore(p: string) {
  return PASSWORD_RULES.reduce((n, r) => n + (r.test(p) ? 1 : 0), 0);
}

export const newPasswordSchema = z
  .string()
  .min(8, "Use at least 8 characters")
  .max(72, "Use at most 72 characters")
  .refine((p) => passwordScore(p) >= 3, "Meet at least three of the four password rules");

export const emailSchema = z.email("Enter a valid email address");

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password"),
});

/** Optional tenant code: empty, or 3 to 24 letters, numbers and hyphens (tenants.referral_code). */
export const tenantCodeSchema = z
  .string()
  .trim()
  .max(24, "Codes are at most 24 characters")
  .refine((v) => v === "" || /^[A-Za-z0-9-]{3,24}$/.test(v), "Codes are 3 to 24 letters, numbers or hyphens");

export const accountSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name").max(80, "Keep it under 80 characters"),
  email: emailSchema,
  password: newPasswordSchema,
  tenantCode: tenantCodeSchema,
});
export type AccountValues = z.infer<typeof accountSchema>;

export const resetRequestSchema = z.object({ email: z.email("Enter the email you signed up with") });

export const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "Europe/London", label: "London" },
  { value: "Asia/Kolkata", label: "India (Kolkata)" },
] as const;
export type TimezoneId = (typeof TIMEZONES)[number]["value"];
export const TIMEZONE_IDS = TIMEZONES.map((t) => t.value) as [TimezoneId, ...TimezoneId[]];
export const DEFAULT_TIMEZONE: TimezoneId = "America/New_York";

/** Plans offered during self-serve signup. Enterprise goes through the tenant program (white-label). */
export const SIGNUP_PLAN_IDS = ["starter", "pro", "desk"] as const satisfies ReadonlyArray<PlanId>;
export type SignupPlanId = (typeof SIGNUP_PLAN_IDS)[number];

/** Subdomains the platform keeps for itself. "partner" and "partners" stay reserved: they were route names before the tenant rename. */
export const RESERVED_SLUGS = new Set([
  "www", "app", "api", "admin", "auth", "tenant", "tenants", "traders", "partner", "partners", "login", "signup",
  "status", "help", "docs", "mail", "broker", "brokers", "ibkr-login", "nasscord", "support", "billing",
]);

/** Workspace subdomain: 3 to 32 characters, lowercase letters, numbers and inner hyphens (fits workspaces.slug). */
export const slugSchema = z
  .string()
  .min(3, "Use at least 3 characters")
  .max(32, "Use at most 32 characters")
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and hyphens only");

export const workspaceSchema = z.object({
  name: z.string().trim().min(2, "Give your workspace a name").max(48, "Keep it under 48 characters"),
  slug: slugSchema,
  timezone: z.enum(TIMEZONE_IDS),
  plan: z.enum(SIGNUP_PLAN_IDS),
});
export type WorkspaceValues = z.infer<typeof workspaceSchema>;

export const createWorkspaceSchema = workspaceSchema.extend({ tenantCode: tenantCodeSchema.optional() });
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const RISK_OPTIONS = [0.5, 1, 2] as const;
export type RiskPct = (typeof RISK_OPTIONS)[number];

/** user_settings columns the app writes. risk_pct is numeric(4,2) with 0 < x <= 5. */
export const settingsSchema = z.object({
  riskPct: z.number().gt(0, "Risk must be above 0%").max(5, "Risk is at most 5% per trade"),
  paperMode: z.boolean(),
  extendedHours: z.boolean(),
  emailAlerts: z.boolean(),
  pushAlerts: z.boolean(),
  smsAlerts: z.boolean(),
  defaultAccountId: z.uuid().nullable().optional(),
});
export type SettingsValues = z.infer<typeof settingsSchema>;

/** Result of the auth and setup server actions. `field` names the input an error belongs to. */
export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; field?: string };
