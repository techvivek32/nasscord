import type { Plan, PlanId, TenantOffer } from "@/lib/types";

export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    tagline: "See every account in one place.",
    monthly: 0,
    yearly: 0,
    cta: "Start free",
    // A feature that starts with "Planned: " is not in this release; the plan cards show it as planned.
    features: [
      "1 broker connection",
      "Accounts, balances and positions",
      "Orders and executions",
      "1 seat",
      "Planned: TradeScope alerts, delayed 15 minutes",
    ],
    limits: { brokers: 1, seats: 1, alertDelayMin: 15 },
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For traders with more than one account.",
    monthly: 49,
    yearly: 39,
    featured: true,
    // Signup does not read a plan from the link; the plan is picked at the workspace step, so the button says sign up.
    cta: "Sign up",
    features: [
      "Unlimited broker connections",
      "Every included account in one book",
      "Orders and executions across brokers",
      "1 seat",
      "Planned: real-time TradeScope alerts",
      "Planned: order entry from the terminal",
    ],
    limits: { brokers: "unlimited", seats: 1, alertDelayMin: 0 },
  },
  {
    id: "desk",
    name: "Desk",
    tagline: "A small team on one book.",
    monthly: 149,
    yearly: 119,
    cta: "Sign up",
    features: [
      "Everything in Pro",
      "Planned: up to 5 seats on one book",
      "Planned: a separate login for each trader",
    ],
    limits: { brokers: "unlimited", seats: 5, alertDelayMin: 0 },
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For firms that trade at scale.",
    monthly: null,
    yearly: null,
    cta: "Talk to us",
    // White-label is not a plan feature: it is the tenant add-on the super admin grants (TENANT_OFFERS).
    features: [
      "Everything in Desk",
      "Limits set per contract",
      "Planned: unlimited seats",
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

/** White-label platform fee, per month, on top of per-seat pricing, once billing is switched on. */
export const WHITE_LABEL_FEE = 999;

/**
 * What a tenant gets. Every tenant earns commission. White-label is an add-on: the super admin
 * grants it to a tenant from the console's White-label page.
 */
export const TENANT_OFFERS: TenantOffer[] = [
  {
    id: "commission",
    name: "Commission",
    summary: "Bring traders to Nasscord with your own code and earn a share of their subscription for as long as they stay.",
    pricing: `${COMMISSION_PCT}% of subscription revenue, lifetime, once billing is switched on.`,
    bullets: [
      "A referral code and link of your own",
      "The traders who signed up with your code, in the tenant portal",
      "No billing in this release, so no commission is earned or paid out yet",
    ],
  },
  {
    id: "white_label",
    name: "White-label",
    summary: "Your brand on the terminal your traders use. Nasscord runs the broker connections and the infrastructure.",
    pricing: `From $${WHITE_LABEL_FEE}/mo platform fee plus per-seat, once billing is switched on. Granted after review.`,
    bullets: [
      "Your name and accent colors on the terminal",
      "Your own domain",
      "Turned on by Nasscord once your application is approved",
      "Planned: your own plans and prices for your traders",
    ],
  },
];
