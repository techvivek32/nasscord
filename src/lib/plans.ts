import type { Plan, PlanId, TenantOffer } from "@/lib/types";

export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    tagline: "See every account in one place.",
    monthly: 0,
    yearly: 0,
    cta: "Start free",
    features: [
      "1 broker connection",
      "Live positions and P&L",
      "Alerts delayed 15 minutes",
      "1 seat",
      "Email support",
    ],
    limits: { brokers: 1, seats: 1, alertDelayMin: 15 },
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For traders who act on alerts.",
    monthly: 49,
    yearly: 39,
    featured: true,
    cta: "Start 14-day trial",
    features: [
      "Unlimited broker connections",
      "Real-time TradeScope alerts",
      "Verified order engine with brackets",
      "Risk sizing and options desk",
      "Mobile app, email and push",
      "Trade archive beyond the broker window",
    ],
    limits: { brokers: "unlimited", seats: 1, alertDelayMin: 0 },
  },
  {
    id: "desk",
    name: "Desk",
    tagline: "A small team on one book.",
    monthly: 149,
    yearly: 119,
    cta: "Start 14-day trial",
    features: [
      "Everything in Pro",
      "Up to 5 seats",
      "Shared watchlists and alerts",
      "Team audit log",
      "Separate login and 2FA for each trader",
      "Priority support",
    ],
    limits: { brokers: "unlimited", seats: 5, alertDelayMin: 0 },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Your brand, our engine.",
    monthly: null,
    yearly: null,
    cta: "Talk to us",
    features: [
      "White-label brand and domain",
      "Your pricing, your customers",
      "SSO and SCIM",
      "Dedicated broker gateway pool",
      "Revenue share or per-seat",
      "SLA and named support",
    ],
    limits: { brokers: "unlimited", seats: "unlimited", alertDelayMin: 0 },
  },
];

export function getPlan(id: PlanId): Plan {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown plan: ${id}`);
  return p;
}

export const PLAN_LABEL: Record<PlanId, string> = {
  starter: "Starter",
  pro: "Pro",
  desk: "Desk",
  enterprise: "Enterprise",
};

/** Tenant commission, percent of the subscription revenue of the traders a tenant brings. The one place this number is defined. */
export const COMMISSION_PCT = 25;

/** White-label platform fee, per month, on top of per-seat pricing. */
export const WHITE_LABEL_FEE = 999;

/**
 * What a tenant gets. Every tenant earns commission. White-label is an add-on: the super admin
 * grants it to a tenant from the console's White-label page.
 */
export const TENANT_OFFERS: TenantOffer[] = [
  {
    id: "commission",
    name: "Commission",
    summary: "Bring traders to Nasscord and earn a share of their subscription for as long as they stay.",
    pricing: `${COMMISSION_PCT}% of subscription revenue, lifetime, paid monthly.`,
    bullets: [
      "Personal referral link and codes",
      "Attribution tracked from first visit to paid plan",
      "Monthly payouts by ACH, $100 minimum",
      "Tenant portal with clicks, trials and conversions",
    ],
  },
  {
    id: "white_label",
    name: "White-label",
    summary: "Your brand, domain and pricing on the terminal your traders use. Nasscord runs the engine, the broker connections and the infrastructure.",
    pricing: `From $${WHITE_LABEL_FEE}/mo platform fee plus per-seat. Granted after review.`,
    bullets: [
      "Custom domain and branding, including accent color and emails",
      "You set plans and prices for your traders",
      "Dedicated broker gateway pool for your traders",
      "Turned on by Nasscord once your application is approved",
    ],
  },
];
