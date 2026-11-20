import type { ConnectSpec } from "@/lib/types";
import { sandboxEnvironment } from "@/lib/broker-connect/shared";

/** E*TRADE: OAuth 1.0a with the user's own developer key; the verification code is pasted back. */
export const ETRADE_CONNECT: ConnectSpec[] = [
  {
    flow: "oauth1_verifier",
    method: "etrade_oauth1",
    title: "Connect with your E*TRADE developer key",
    summary: "Use a consumer key you create on developer.etrade.com and approve Nasscord on E*TRADE. Sessions end at midnight Eastern.",
    environments: [
      { value: "production", label: "Production", hint: "Your real E*TRADE account, with a Production key." },
      // Developers only (NEXT_PUBLIC_ETRADE_SANDBOX=1 and a broker service outside production).
      sandboxEnvironment("E*TRADE's sample accounts"),
    ],
    prerequisites: ["An E*TRADE brokerage account.", "An individual consumer key from developer.etrade.com, created with your own E*TRADE login."],
    steps: [
      "Sign in at developer.etrade.com and request an individual consumer key for Production.",
      "Paste the consumer key and secret here.",
      "Approve Nasscord on E*TRADE's page in the new tab. E*TRADE then shows a verification code.",
      "Paste the code here within 5 minutes, and your accounts appear.",
    ],
    fields: [
      { name: "clientId", label: "Consumer key" },
      { name: "clientSecret", label: "Consumer secret", secret: true },
    ],
    disclosure:
      "Nasscord reads your accounts, balances, positions and orders. It places an order only when order entry is on for your workspace and you confirm that order. The key and secret are sent once to Nasscord's broker service and stored there encrypted; they are never shown again. An individual key only works with the account of the person who created it.",
    sessionNote: "E*TRADE ends every session at midnight Eastern. Reconnect reuses your stored key and asks only for a new verification code.",
    disconnectNote: "Disconnect revokes Nasscord's E*TRADE token and deletes the stored key and secret.",
    unavailableReason: "E*TRADE connections are not available on this server yet.",
    docsUrl: "https://developer.etrade.com",
  },
];
