import { z } from "zod";
import { RISK_OPTIONS } from "@/lib/signup";

/* Form schemas of the signup wizard. The account and workspace rules are shared with the server actions. */

export {
  PASSWORD_RULES,
  accountSchema,
  passwordScore,
  resetRequestSchema as resetSchema,
  workspaceSchema,
  type AccountValues,
  type WorkspaceValues,
} from "@/lib/signup";

export const preferencesSchema = z.object({
  riskPct: z.union([z.literal(RISK_OPTIONS[0]), z.literal(RISK_OPTIONS[1]), z.literal(RISK_OPTIONS[2])]),
  emailAlerts: z.boolean(),
  pushAlerts: z.boolean(),
  smsAlerts: z.boolean(),
  extendedHours: z.boolean(),
  paperMode: z.boolean(),
});
export type PreferencesValues = z.infer<typeof preferencesSchema>;
