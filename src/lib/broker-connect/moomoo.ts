import type { ConnectSpec } from "@/lib/types";
import { snaptradeSpec } from "@/lib/broker-connect/shared";

/**
 * Moomoo: its OpenAPI needs an OpenD gateway logged in with the user's moomoo ID and password,
 * which Nasscord would have to run per user while holding passwords, so it is read through SnapTrade.
 * Moomoo paper accounts are not available through SnapTrade.
 */
export const MOOMOO_CONNECT: ConnectSpec[] = [
  snaptradeSpec("moomoo", "Moomoo", {
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval.",
  }),
];
