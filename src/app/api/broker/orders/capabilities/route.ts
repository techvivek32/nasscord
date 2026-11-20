import { json } from "@/lib/server/api";
import { BrokerServiceError, getOrderCapabilities } from "@/lib/server/broker-service";
import { orderEntryState, orderJsonError, orderReader, orderRouteError } from "@/lib/server/orders";
import { ORDER_COPY } from "@/lib/order-entry";
import type { OrderCapabilities } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/broker/orders/capabilities -> OrderCapabilities: whether order entry is on for the workspace and what
 * each connection may send for this user. Off or suspended answers without calling the broker service. A service
 * failure, or a failed database read of the switch or the notice, answers 503, never a 200 that says "off", so
 * the terminal keeps its last good answer.
 */
export async function GET() {
  const actor = await orderReader();
  if (actor instanceof Response) return actor;
  try {
    const state = await orderEntryState(actor.workspaceId, actor.userId);
    // A failed read of the switch or the notice is not "off": 503, so the terminal keeps its last good answer.
    if (state.unreadable) return orderJsonError(503, "unavailable", ORDER_COPY.unavailable);
    if (!state.enabled) {
      const off: OrderCapabilities = {
        enabled: false,
        reason: state.reason ?? "off",
        message: state.reason === "suspended" ? ORDER_COPY.suspended : ORDER_COPY.offWorkspace,
        limits: { maxQty: 0, maxNotional: 0 },
        connections: {},
        blocked: {},
        termsAcceptedAt: state.termsAcceptedAt,
      };
      return json(off);
    }
    const caps = await getOrderCapabilities(actor);
    const answer: OrderCapabilities = { ...caps, termsAcceptedAt: state.termsAcceptedAt };
    return json(answer);
  } catch (err) {
    // A deliberate refusal of the service (role, workspace, member) passes through; anything else is "unavailable".
    if (err instanceof BrokerServiceError && err.kind === "answered" && err.serviceStatus !== undefined && err.serviceStatus < 500) {
      return orderRouteError(err, "GET /api/broker/orders/capabilities");
    }
    if (!(err instanceof BrokerServiceError)) console.error(`[orders] GET /api/broker/orders/capabilities failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return orderJsonError(503, "unavailable", ORDER_COPY.unavailable);
  }
}
