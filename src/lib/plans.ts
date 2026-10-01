import type { PartnerModelInfo, Plan, PlanId } from "@/lib/types";

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
      "Role-based access",
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

/** Standard referral commission, percent of subscription revenue. The one place this number is defined. */
export const REFERRAL_SHARE_PCT = 25;

export const PARTNER_MODELS: PartnerModelInfo[] = [
  {
    id: "white_label",
    name: "White-label",
    summary: "Your brand, domain and pricing. Nasscord runs the engine, the broker connections and the infrastructure.",
    pricing: "From $999/mo platform fee plus per-seat.",
    bullets: [
      "Custom domain and branding, including accent color and emails",
      "You set plans and prices; we bill on your behalf or you bill directly",
      "Dedicated broker gateway pool for your tenants",
      "Partner console with revenue, seats and support tools",
    ],
  },
  {
    id: "referral",
    name: "Referral commission",
    summary: "Introduce traders to Nasscord and earn a share of their subscription for as long as they stay.",
    pricing: `${REFERRAL_SHARE_PCT}% of subscription revenue, lifetime, paid monthly.`,
    bullets: [
      "Personal referral link and codes",
      "Attribution tracked from first visit to paid plan",
      "Monthly payouts by ACH, $100 minimum",
      "Dashboard with clicks, trials and conversions",
    ],
  },
  {
    id: "embedded",
    name: "Embedded / API",
    summary: "Put TradeScope alerts and the verified order engine inside your own product.",
    pricing: "Custom, based on volume.",
    bullets: [
      "REST and streaming APIs for alerts, orders and positions",
      "Broker connections handled by Nasscord",
      "Usage-based pricing",
      "Solution engineering during integration",
    ],
  },
];
