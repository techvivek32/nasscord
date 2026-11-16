import type { ConnectSpec } from "@/lib/types";

/**
 * TradeStation: each user's own API key from TradeStation Client Experience, with Nasscord's callback
 * added to the key (no localhost paste-code fallback). A non-partner key only reaches the accounts
 * under its owner's login, so this is the platform owner's own testing until TradeStation agrees in
 * writing (BROKER_AUDIENCE tradestation_oauth.user=superadmin). Paper (SIM) is offered only when the
 * service sets TRADESTATION_ALLOW_SIM.
 */
const ENVIRONMENTS = [
  { value: "production" as const, label: "Live", hint: "Your real TradeStation accounts." },
  { value: "paper" as const, label: "Paper", hint: "Your own TradeStation simulated (SIM) accounts." },
];

export const TRADESTATION_CONNECT: ConnectSpec[] = [
  {
    flow: "oauth2_user_app",
    method: "tradestation_oauth",
    client: "user",
    title: "Connect with your own TradeStation API key",
    summary: "Ask TradeStation for an API key with Nasscord's callback, then sign in on TradeStation's page.",
    environments: ENVIRONMENTS,
    prerequisites: ["A funded TradeStation brokerage account. TradeStation issues API keys to its customers by email."],
    steps: [
      "Email TradeStation Client Experience at ClientExperience@tradestation.com for an API key, and ask them to add Nasscord's callback URL, exactly as shown here, to the key.",
      "Check that the key is the newer kind: upper and lower case letters, no dashes.",
      "Paste the API key and secret here and press Continue.",
      "Sign in on TradeStation's page in the new tab with your username, password and second factor, and approve Nasscord.",
      "TradeStation sends you back to Nasscord, and your accounts appear here.",
    ],
    fields: [
      { name: "clientId", label: "API key" },
      { name: "clientSecret", label: "API secret", secret: true },
    ],
    disclosure:
      "Nasscord asks for read access to your accounts and places no orders in this release. The key, secret and tokens are stored encrypted on Nasscord's broker service.",
    sessionNote:
      "The login lasts until you remove it, unless your key rotates its refresh tokens: then TradeStation asks for a new login every 24 hours, and Nasscord shows when.",
    disconnectNote:
      "Disconnect deletes the stored key, secret and tokens from Nasscord. Nasscord does not revoke tokens at TradeStation, because that would end every other tool that uses your key too.",
    unavailableReason: "Not available yet: only the platform owner can connect a personal TradeStation key while Nasscord waits for TradeStation's written approval.",
    docsUrl: "https://api.tradestation.com/docs",
  },
  {
    flow: "oauth2_platform",
    method: "tradestation_oauth",
    client: "platform",
    title: "Sign in with TradeStation",
    summary: "Sign in on TradeStation's own page and approve read access. No API key needed.",
    environments: ENVIRONMENTS,
    prerequisites: ["A TradeStation brokerage account."],
    steps: [
      "Press Continue. TradeStation's sign-in page opens in a new tab.",
      "Sign in with your username, password and second factor, and approve Nasscord.",
      "TradeStation sends you back to Nasscord, and your accounts appear here.",
    ],
    disclosure: "Nasscord asks for read access to your accounts and places no orders in this release.",
    sessionNote: "The login lasts until you remove it at TradeStation.",
    disconnectNote: "Disconnect deletes Nasscord's TradeStation tokens.",
    unavailableReason: "Not available yet: Nasscord is waiting for TradeStation to accept it as a partner.",
  },
];
