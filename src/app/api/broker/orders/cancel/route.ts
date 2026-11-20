import { json } from "@/lib/server/api";
import { BrokerServiceError, cancelOrder, orderOutcomeUnknown } from "@/lib/server/broker-service";
import { orderActor, orderJsonError, orderRouteError, readOrderBody } from "@/lib/server/orders";
import { cancelSchema, ORDER_COPY } from "@/lib/order-entry";

export const runtime = "nodejs";

/**
 * POST /api/broker/orders/cancel, body { accountId, orderId } -> { status, message }. Never retried. A
 * deliberate refusal answers { error, code }; any other failure answers 504 cancel_unknown, because the cancel
 * may have reached the broker.
 */
export async function POST(request: Request) {
  const actor = await orderActor(request, "cancel");
  if (actor instanceof Response) return actor;
  const body = await readOrderBody(request, cancelSchema, "bad_request");
  if (body instanceof Response) return body;
  try {
    return json(await cancelOrder(actor, body));
  } catch (err) {
    if (err instanceof BrokerServiceError && !orderOutcomeUnknown(err)) return orderRouteError(err, "POST /api/broker/orders/cancel");
    console.error(`[orders] POST /api/broker/orders/cancel outcome unknown: ${err instanceof Error ? err.name : "unknown error"}`);
    return orderJsonError(504, "cancel_unknown", ORDER_COPY.cancelUnknown);
  }
}
