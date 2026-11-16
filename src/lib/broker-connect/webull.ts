import type { ConnectSpec } from "@/lib/types";
import { sandboxEnvironment, snaptradeSpec } from "@/lib/broker-connect/shared";

/**
 * Webull (US): the Connect API (Nasscord's OAuth client) once Webull approves Nasscord, after the
 * sandbox testing Webull requires. Until then Webull is read through SnapTrade. The individual
 * Trading API key is not offered: Webull designates it for natural persons and it always carries
 * trading permission.
 */
export const WEBULL_CONNECT: ConnectSpec[] = [
  snaptradeSpec("webull", "Webull", {
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval.",
  }),
  {
    flow: "oauth2_platform",
    method: "webull_oauth",
    client: "platform",
    title: "Sign in with Webull",
    summary: "Sign in on Webull's own page and approve access. No key to copy.",
    environments: [{ value: "production", label: "Live", hint: "Your real Webull US account." }, sandboxEnvironment("Webull's Connect sandbox")],
    prerequisites: ["An opened Webull US brokerage account."],
    steps: [
      "Press Continue. Webull's sign-in page opens in a new tab.",
      "Sign in with your Webull login and any second factor, and approve Nasscord.",
      "Webull sends you back to Nasscord, and your accounts appear here.",
    ],
    disclosure: "Nasscord asks for read access and places no orders in this release.",
    sessionNote: "Webull ends the access when its refresh period (15 days) runs out, and Reconnect asks you to approve again. Nasscord shows the date.",
    disconnectNote: "Disconnect deletes Nasscord's Webull tokens.",
    unavailableReason: "Not available yet: Nasscord is waiting for Webull to approve its Connect API application.",
  },
];
