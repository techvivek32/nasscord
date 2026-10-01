import { z } from "zod";
import { RISK_OPTIONS, SIGNUP_PLAN_IDS, TIMEZONE_IDS } from "@/components/onboarding/data";

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

export const accountSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name"),
  email: z.email("Enter a valid work email"),
  password: z
    .string()
    .min(8, "Use at least 8 characters")
    .refine((p) => passwordScore(p) >= 3, "Meet at least three of the four password rules"),
  tenantCode: z.string().trim().max(32, "Codes are at most 32 characters"),
});
export type AccountValues = z.infer<typeof accountSchema>;

export const workspaceSchema = z.object({
  name: z.string().trim().min(2, "Give your workspace a name").max(48, "Keep it under 48 characters"),
  slug: z
    .string()
    .min(3, "Use at least 3 characters")
    .max(32, "Use at most 32 characters")
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, numbers and hyphens only"),
  timezone: z.enum(TIMEZONE_IDS),
  plan: z.enum(SIGNUP_PLAN_IDS),
});
export type WorkspaceValues = z.infer<typeof workspaceSchema>;

export const preferencesSchema = z.object({
  defaultAccountId: z.string(),
  riskPct: z.union([z.literal(RISK_OPTIONS[0]), z.literal(RISK_OPTIONS[1]), z.literal(RISK_OPTIONS[2])]),
  emailAlerts: z.boolean(),
  push: z.boolean(),
  sms: z.boolean(),
  extendedHours: z.boolean(),
  paperMode: z.boolean(),
});
export type PreferencesValues = z.infer<typeof preferencesSchema>;

export const inviteSchema = z.object({
  email: z.email("Enter a valid email address"),
});
export type InviteValues = z.infer<typeof inviteSchema>;

export const resetSchema = z.object({
  email: z.email("Enter the email you signed up with"),
});
export type ResetValues = z.infer<typeof resetSchema>;
