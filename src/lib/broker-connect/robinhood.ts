import type { ConnectSpec } from "@/lib/types";
import { snaptradeSpec } from "@/lib/broker-connect/shared";

/** Robinhood publishes no API for stock accounts that a platform may use; Nasscord reads it through SnapTrade (Robinhood Access). */
export const ROBINHOOD_CONNECT: ConnectSpec[] = [
  snaptradeSpec("robinhood", "Robinhood", {
    agreement: "the Robinhood Access agreement",
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval.",
  }),
];
