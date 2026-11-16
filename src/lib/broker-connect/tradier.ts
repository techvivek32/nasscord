import type { ConnectSpec } from "@/lib/types";

/**
 * Tradier: Nasscord's OAuth client once Tradier accepts Nasscord as a partner. Until then Tradier's
 * API is for personal use only, so a pasted personal token is the platform owner's own testing
 * (BROKER_AUDIENCE tradier_token=superadmin).
 */
export const TRADIER_CONNECT: ConnectSpec[] = [
  {
    flow: "oauth2_platform",
    method: "tradier_oauth",
    client: "platform",
    title: "Sign in with Tradier",
    summary: "Sign in on Tradier's own page and approve read access. No developer account or key needed.",
    environments: [{ value: "production", label: "Live", hint: "Your real Tradier brokerage account." }],
    prerequisites: ["A Tradier Brokerage account."],
    steps: [
      "Read and accept the consent below.",
      "Press Continue. Tradier's sign-in page opens in a new tab.",
      "Sign in and approve Nasscord.",
      "Tradier sends you back to Nasscord, and your accounts appear here.",
    ],
    scopes: "Read your accounts, and market data to value your positions (read, market).",
    // Replace with the consent exhibit of Tradier's partner agreement once it is signed: Tradier
    // requires its own wording here.
    consent:
      "You allow Nasscord to read your Tradier accounts, balances, positions, orders and history, and Tradier market data, on your behalf until you disconnect. Nasscord places no orders.",
    disclosure: "Nasscord asks for read access and market data only, and places no orders in this release.",
    sessionNote: "Until Tradier enables refresh tokens for Nasscord, Tradier ends the access after 24 hours and Reconnect asks you to approve again.",
    disconnectNote: "Disconnect deletes Nasscord's Tradier tokens.",
    unavailableReason: "Not available yet: Nasscord is waiting for Tradier to approve it as a partner.",
    docsUrl: "https://tradier.com",
  },
  {
    flow: "api_key",
    method: "tradier_token",
    title: "Paste your own Tradier API token",
    summary: "The platform owner's own account only: Tradier's API is for personal use unless you are a Tradier partner.",
    environments: [
      { value: "production", label: "Live", hint: "Your own Tradier brokerage account." },
      { value: "paper", label: "Paper", hint: "Your own Tradier sandbox (paper) account. Quotes and fills there are 15 minutes delayed." },
    ],
    prerequisites: ["Your own Tradier Brokerage account."],
    steps: [
      "Sign in at web.tradier.com and open API Access from the menu under your name.",
      "Copy the token under Production Account Access, or for Paper the token under Sandbox Account Access.",
      "Paste it here and press Connect.",
    ],
    fields: [{ name: "secret", label: "API access token", secret: true }],
    warning: "Anyone with this token has full access to the account until you regenerate it.",
    disclosure:
      "Tradier says its API is for personal use unless you are a Tradier partner, so this is only for the platform owner's own account. Nasscord only reads in this release and blocks every order call in code. The token is stored encrypted on the broker service.",
    sessionNote: "A personal token does not expire. If Tradier stops accepting it (you regenerated it), Reconnect asks you to paste the new one.",
    disconnectNote: "Disconnect deletes the stored token from Nasscord. To revoke it everywhere, regenerate it on Tradier's API Access page.",
    unavailableReason: "Only the platform owner can connect a personal Tradier token.",
  },
];
