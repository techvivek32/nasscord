import { json } from "@/lib/server/api";
import { BrokerServiceError, orderOutcomeUnknown, placeOrder } from "@/lib/server/broker-service";
import { orderActor, orderRouteError, readOrderBody } from "@/lib/server/orders";
import { ORDER_COPY, placeSchema } from "@/lib/order-entry";

export const runtime = "nodejs";

/**
 * POST /api/broker/orders/place, body { requestId, acknowledged, confirmBrokerMessages? } -> { request }.
 * Never retried. A deliberate refusal (nothing was sent) answers { error, code } with its status; any other
 * failure may have reached the broker, so it answers 202 { checking: true, requestId, error } and the terminal
 * reads the stored request instead of offering to place it again.
 */
export async function POST(request: Request) {
  const actor = await orderActor(request, "place");
  if (actor instanceof Response) return actor;
  const body = await readOrderBody(request, placeSchema, "bad_request");
  if (body instanceof Response) return body;
  try {
    const answer: unknown = await placeOrder(actor, body);
    // An answer without the stored request tells nothing about the order: read it as "checking".
    if (!answer || typeof answer !== "object" || !("request" in answer) || !(answer as { request?: unknown }).request) {
      return json({ checking: true, requestId: body.requestId, error: ORDER_COPY.unknownOutcome }, 202);
    }
    return json(answer);
  } catch (err) {
    if (err instanceof BrokerServiceError && !orderOutcomeUnknown(err)) return orderRouteError(err, "POST /api/broker/orders/place");
    console.error(`[orders] POST /api/broker/orders/place outcome unknown: ${err instanceof Error ? err.name : "unknown error"}`);
    return json({ checking: true, requestId: body.requestId, error: ORDER_COPY.unknownOutcome }, 202);
  }
}
