import type { BrokerAccount, BrokerId, PlanId } from "@/lib/types";

/* ------------------------------------------------------------------
   Static data for the signup wizard: step list, timezones, the partner
   code, risk presets and the accounts each broker returns in the demo
   connect flow. Balances match src/lib/mock/trading.ts for the three
   brokers the demo trader already has connected.
   ------------------------------------------------------------------ */

export const SIGNUP_DRAFT_KEY = "nasscord-signup-draft";
export const PARTNER_CODE = "NOVA-PARTNER";
export const PARTNER_TENANT_SLUG = "acme";

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export const STEPS: ReadonlyArray<{ id: WizardStep; title: string; description: string }> = [
  { id: 1, title: "Account", description: "Who you are" },
  { id: 2, title: "Workspace", description: "Name, URL and plan" },
  { id: 3, title: "Brokers", description: "Connect your accounts" },
  { id: 4, title: "Preferences", description: "Risk and alerts" },
  { id: 5, title: "Ready", description: "Open the terminal" },
];

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

/** Plans offered during self-serve signup. Enterprise goes through the partner flow. */
export const SIGNUP_PLAN_IDS = ["starter", "pro", "desk"] as const satisfies ReadonlyArray<PlanId>;
export type SignupPlanId = (typeof SIGNUP_PLAN_IDS)[number];

/** Subdomains the platform keeps for itself. */
export const RESERVED_SLUGS = new Set(["www", "app", "api", "admin", "partner", "partners", "login", "signup", "status", "help", "docs", "mail"]);

export const RISK_OPTIONS = [0.5, 1, 2] as const;
export type RiskPct = (typeof RISK_OPTIONS)[number];

/** Accounts returned by the simulated broker connect. Derived from the domain BrokerAccount shape. */
export type DemoAccount = Pick<BrokerAccount, "id" | "brokerId" | "label" | "masked" | "type" | "netLiq">;

export const DEMO_ACCOUNTS: Record<BrokerId, DemoAccount[]> = {
  schwab: [
    { id: "acc_schwab_1", brokerId: "schwab", label: "Individual", masked: "••••8821", type: "individual", netLiq: 84_210.55 },
    { id: "acc_schwab_2", brokerId: "schwab", label: "Roth IRA", masked: "••••1190", type: "roth", netLiq: 31_006.12 },
  ],
  ibkr: [{ id: "acc_ibkr_1", brokerId: "ibkr", label: "Individual", masked: "U12•••45", type: "margin", netLiq: 58_930.4 }],
  alpaca: [{ id: "acc_alpaca_1", brokerId: "alpaca", label: "Paper", masked: "PA3•••7K", type: "paper", netLiq: 9_500 }],
  etrade: [{ id: "acc_etrade_1", brokerId: "etrade", label: "Individual", masked: "••••4417", type: "individual", netLiq: 27_340.18 }],
  tastytrade: [{ id: "acc_tasty_1", brokerId: "tastytrade", label: "Margin", masked: "5WT•••92", type: "margin", netLiq: 18_205.6 }],
  tradier: [{ id: "acc_tradier_1", brokerId: "tradier", label: "Individual", masked: "6YA•••03", type: "individual", netLiq: 12_880 }],
  tradestation: [{ id: "acc_ts_1", brokerId: "tradestation", label: "Margin", masked: "1147•••8", type: "margin", netLiq: 45_120.75 }],
  webull: [{ id: "acc_webull_1", brokerId: "webull", label: "Individual", masked: "••••3306", type: "individual", netLiq: 6_410.22 }],
  fidelity: [{ id: "acc_fidelity_1", brokerId: "fidelity", label: "Individual", masked: "Z••••512", type: "individual", netLiq: 142_880.3 }],
  robinhood: [{ id: "acc_rh_1", brokerId: "robinhood", label: "Individual", masked: "••••7728", type: "individual", netLiq: 4_915.44 }],
  moomoo: [],
  public: [],
};

export const ACCOUNT_TYPE_LABEL: Record<DemoAccount["type"], string> = {
  individual: "Individual",
  ira: "IRA",
  roth: "Roth IRA",
  margin: "Margin",
  paper: "Paper",
};

/** Stages of the simulated OAuth hand-off, ~700 ms each. */
export const CONNECT_STAGES = ["Redirecting to the broker", "Authorizing Nasscord", "Fetching accounts"] as const;
export const CONNECT_STAGE_MS = 700;

/** Identities filled in by the simulated SSO buttons. */
export const SSO_IDENTITIES = {
  google: { fullName: "Jordan Ellis", email: "jordan.ellis@gmail.com" },
  apple: { fullName: "Jordan Ellis", email: "jordan.ellis@icloud.com" },
} as const;
export type SsoProvider = keyof typeof SSO_IDENTITIES;

export function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

export function defaultWorkspaceName(fullName: string) {
  const first = firstName(fullName);
  return first ? `${first}'s Desk` : "My Desk";
}

/** Shown on the Ready step when the draft has no usable timing (for example after a restored draft). */
export const FALLBACK_SETUP_MS = 108_000;
/** Longer than this and the trader clearly walked away; fall back to the typical time. */
export const MAX_REPORTED_SETUP_MS = 30 * 60_000;

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}
