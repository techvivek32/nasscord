import type { ConnectSpec } from "@/lib/types";

/**
 * Alpaca: the user's own API key and secret now (Live, or one of their own Paper accounts); Alpaca
 * Connect (Nasscord's OAuth app, read-only by default) once Alpaca approves it.
 */
export const ALPACA_CONNECT: ConnectSpec[] = [
  {
    flow: "api_key",
    method: "alpaca_key",
    title: "Connect with your Alpaca API key",
    summary: "Paste the API key and secret of one Alpaca account, Live or Paper. Nasscord finds out which it is.",
    environments: [
      { value: "production", label: "Live", hint: "Your real Alpaca brokerage account." },
      { value: "paper", label: "Paper", hint: "One of your own Alpaca paper accounts. Each paper account has its own keys and its own connection." },
    ],
    prerequisites: ["An Alpaca account. Anyone can open a free Paper Only account with an email address."],
    steps: [
      "Sign in at app.alpaca.markets and pick the account in the switcher at the top left: your live account or one paper account.",
      "In the API Keys panel on the Home page, press Generate New Keys (Regenerate if keys already exist).",
      "Copy the Key ID and the Secret now. Alpaca shows the Secret only once.",
      "Paste both here and press Connect. Nasscord checks the key with Alpaca and labels the connection Live or Paper.",
    ],
    fields: [
      { name: "keyId", label: "API Key ID" },
      { name: "secret", label: "API Secret", secret: true },
    ],
    warning: "Regenerating keys stops any bot or other tool that uses the old pair on that account.",
    disclosure:
      "This key can place trades. Nasscord only reads in this release, blocks every order call in code, stores the key encrypted on its broker service and never shows it again. Alpaca's customer agreement makes access you give a third party your own risk.",
    sessionNote:
      "Alpaca keys do not expire. If Alpaca stops accepting the key (you regenerated it, or reset a paper account), Reconnect asks you to paste the new key.",
    disconnectNote: "Disconnect deletes the stored key and the accounts from Nasscord. To revoke the key everywhere, regenerate it in Alpaca.",
    unavailableReason: "Alpaca is not available on this server yet.",
    docsUrl: "https://app.alpaca.markets",
  },
  {
    flow: "oauth2_platform",
    method: "alpaca_oauth",
    client: "platform",
    title: "Sign in with Alpaca",
    summary: "Sign in on Alpaca's own page and approve read-only access. No key to copy.",
    environments: [
      { value: "production", label: "Live", hint: "Your real Alpaca brokerage account." },
      { value: "paper", label: "Paper", hint: "One of your own Alpaca paper accounts." },
    ],
    prerequisites: ["An Alpaca account."],
    steps: [
      "Press Continue. Alpaca's sign-in page opens in a new tab.",
      "Sign in, choose your live account, one paper account or both, and approve Nasscord.",
      "Alpaca sends you back to Nasscord, and your accounts appear here.",
    ],
    scopes: "Read only: Nasscord asks for no trading permission.",
    disclosure: "With this approval Nasscord can read your account but cannot place orders. You can remove Nasscord at any time under OAuth Apps in the Alpaca dashboard.",
    sessionNote: "The approval lasts until you remove it in Alpaca. Each further paper account needs its own approval.",
    disconnectNote: "Disconnect deletes Nasscord's Alpaca token. To remove the approval at Alpaca too, use OAuth Apps in the Alpaca dashboard.",
    unavailableReason: "Not available yet: Nasscord is waiting for Alpaca to approve its Connect app. Connect with your API key instead.",
  },
];
