import type { ConnectSpec } from "@/lib/types";
import { snaptradeSpec } from "@/lib/broker-connect/shared";

/**
 * Fidelity publishes no retail API a platform may use. Nasscord reads it through SnapTrade, which
 * logs in through Fidelity Access (OAuth on Fidelity's own page). Fidelity approves Nasscord's
 * SnapTrade profile separately.
 */
export const FIDELITY_CONNECT: ConnectSpec[] = [
  snaptradeSpec("fidelity", "Fidelity", {
    agreement: "the Fidelity Access agreement",
    unavailableReason: "Not available yet: Nasscord is waiting for SnapTrade's production approval and Fidelity's approval of Nasscord's SnapTrade profile.",
  }),
];
