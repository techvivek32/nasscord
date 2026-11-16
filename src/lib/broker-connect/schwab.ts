import type { ConnectSpec } from "@/lib/types";
import { snaptradeSpec } from "@/lib/broker-connect/shared";

/**
 * Charles Schwab (Trader API). Schwab defines an Individual app as your own app for your own
 * account, so a per-user app is the platform owner's own testing until Schwab agrees in writing
 * (BROKER_AUDIENCE schwab_oauth.user=superadmin). Users reach Schwab read-only through SnapTrade, or
 * through Nasscord's Commercial app once Schwab approves it. Schwab has no paper or sandbox
 * environment, and asks for a new login every 7 days.
 */
const LIVE = { value: "production" as const, label: "Live", hint: "Your real Schwab accounts. Schwab's Trader API has no paper or sandbox environment." };

export const SCHWAB_CONNECT: ConnectSpec[] = [
  snaptradeSpec("schwab", "Schwab", {
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval and Schwab's approval of Nasscord's SnapTrade profile.",
  }),
  {
    flow: "oauth2_platform",
    method: "schwab_oauth",
    client: "platform",
    title: "Sign in with Schwab",
    summary: "Sign in on Schwab's own page and tick the accounts to share. No developer app needed.",
    environments: [LIVE],
    prerequisites: ["A Schwab brokerage account."],
    steps: [
      "Press Continue. Schwab's sign-in page opens in a new tab.",
      "Sign in, accept the terms and tick the accounts to share.",
      "Schwab sends you back to Nasscord, and your accounts appear here.",
    ],
    disclosure: "Nasscord reads the accounts you tick, with their balances, positions, orders and trades. It places no orders in this release.",
    sessionNote: "Schwab asks for a new login every 7 days. Nasscord shows the date and warns 48 hours before.",
    reconnectWarnHours: 48,
    disconnectNote: "Disconnect deletes Nasscord's Schwab tokens.",
    unavailableReason: "Not available yet: Nasscord is waiting for Schwab to approve its Commercial app.",
  },
  {
    flow: "oauth2_user_app",
    method: "schwab_oauth",
    client: "user",
    title: "Connect with your own Schwab developer app",
    summary: "Create a Trader API app on developer.schwab.com with Nasscord's callback, then sign in on Schwab's page.",
    environments: [LIVE],
    prerequisites: ["A Schwab brokerage account.", "A developer profile on developer.schwab.com. It is a separate login from your brokerage login."],
    steps: [
      "On developer.schwab.com, request the API product Trader API - Individual.",
      "Under Dashboard, Apps, press Create App. Choose Accounts and Trading Production, and enter Nasscord's callback URL exactly as shown here.",
      "Wait until the app says Ready For Use. Approved - Pending is not usable yet; Schwab takes from a day to a few weeks.",
      "Paste the App Key and Secret here and press Continue.",
      "Sign in on Schwab's page in the new tab, accept the terms and tick the accounts to share. Schwab sends you back to Nasscord.",
    ],
    fields: [
      { name: "clientId", label: "App Key" },
      { name: "clientSecret", label: "Secret", secret: true },
    ],
    disclosure:
      "Nasscord reads the accounts you tick, with their balances, positions, orders and trades, and places no orders in this release. The App Key, Secret and tokens are stored encrypted on Nasscord's broker service. Accounts you leave unticked stay invisible to Nasscord.",
    sessionNote: "Schwab asks for a new login every 7 days. Nasscord shows the date and warns 48 hours before. Reconnect reuses your App Key and Secret.",
    reconnectWarnHours: 48,
    disconnectNote: "Disconnect deletes the stored App Key, Secret and tokens from Nasscord. Your app on developer.schwab.com stays; delete it there if you no longer need it.",
    unavailableReason: "Not available yet: only the platform owner can connect a personal Schwab app while Nasscord waits for Schwab's written approval.",
    docsUrl: "https://developer.schwab.com",
  },
];
