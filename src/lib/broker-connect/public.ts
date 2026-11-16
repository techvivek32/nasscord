import type { ConnectSpec } from "@/lib/types";
import { snaptradeSpec } from "@/lib/broker-connect/shared";

/**
 * Public: its own API uses a personal secret key that can view the account and place trades, and it
 * offers OAuth only to AI assistants, so Nasscord does not ask for that key. It is read through
 * SnapTrade instead.
 */
export const PUBLIC_CONNECT: ConnectSpec[] = [
  snaptradeSpec("public", "Public", {
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval.",
  }),
];
