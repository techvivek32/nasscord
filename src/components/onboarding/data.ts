/* ------------------------------------------------------------------
   Static data for the signup wizard: the step list and small helpers.
   Field rules, timezones, plans and reserved subdomains live in
   src/lib/signup.ts so the server actions validate with the same rules.
   ------------------------------------------------------------------ */

export {
  DEFAULT_TIMEZONE,
  RESERVED_SLUGS,
  RISK_OPTIONS,
  SIGNUP_PLAN_IDS,
  TIMEZONE_IDS,
  TIMEZONES,
  type RiskPct,
  type SignupPlanId,
  type TimezoneId,
} from "@/lib/signup";

/** localStorage key of the wizard draft (never holds the password). */
export const SIGNUP_DRAFT_KEY = "nasscord-signup-draft";

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export const STEPS: ReadonlyArray<{ id: WizardStep; title: string; description: string }> = [
  { id: 1, title: "Account", description: "Who you are" },
  { id: 2, title: "Workspace", description: "Name, URL and plan" },
  { id: 3, title: "Brokers", description: "Connect IBKR or E*TRADE" },
  { id: 4, title: "Preferences", description: "Risk and alerts" },
  { id: 5, title: "Ready", description: "Open the terminal" },
];

export function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

export function defaultWorkspaceName(fullName: string) {
  const first = firstName(fullName);
  return first ? `${first}'s Desk` : "My Desk";
}

/** Longer than this and the trader clearly walked away (or waited on the email); the time is not shown. */
export const MAX_REPORTED_SETUP_MS = 30 * 60_000;

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}
