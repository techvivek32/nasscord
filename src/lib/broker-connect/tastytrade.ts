import type { ConnectSpec } from "@/lib/types";
import { sandboxEnvironment, snaptradeSpec } from "@/lib/broker-connect/shared";

/**
 * tastytrade: OAuth only (the username and password login was shut down on 2026-02-11). Until
 * tastytrade verifies Nasscord as a trusted third party, the client is the platform owner's own
 * personal OAuth app (BROKER_AUDIENCE tastytrade_oauth=superadmin). tastytrade has no paper account
 * on its API; its cert sandbox is sample data for developers.
 */
export const TASTYTRADE_CONNECT: ConnectSpec[] = [
  {
    flow: "oauth2_platform",
    method: "tastytrade_oauth",
    client: "platform",
    title: "Sign in with tastytrade",
    summary: "Sign in on tastytrade's own page and approve read access. Two-factor authentication must be on.",
    environments: [
      { value: "production", label: "Live", hint: "Your real tastytrade account. tastytrade has no paper account on its API." },
      sandboxEnvironment("tastytrade's cert environment"),
    ],
    prerequisites: ["A tastytrade brokerage account.", "Two-factor authentication turned on at my.tastytrade.com, under Manage, My Profile, Security."],
    steps: [
      "Press Continue. tastytrade's sign-in page opens in a new tab.",
      "Sign in with your username, password and two-factor code, and approve Nasscord.",
      "tastytrade sends you back to Nasscord, and your accounts appear here.",
    ],
    scopes: "Read your accounts (read). No trading permission.",
    disclosure: "Nasscord asks for read access only and places no orders. tastytrade's grant does not expire on its own, so Nasscord keeps it encrypted and never shows it.",
    sessionNote: "The approval lasts until you remove it. If tastytrade stops accepting it, Reconnect asks you to approve again.",
    disconnectNote: "Disconnect deletes Nasscord's tastytrade tokens. Also delete the grant at my.tastytrade.com, under Manage, My Profile, API.",
    unavailableReason: "Not available yet: Nasscord is waiting for tastytrade's third-party verification.",
    docsUrl: "https://my.tastytrade.com",
  },
  snaptradeSpec("tastytrade", "tastytrade", {
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval.",
  }),
];
