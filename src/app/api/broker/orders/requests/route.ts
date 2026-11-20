import { json } from "@/lib/server/api";
import { listOrderRequests } from "@/lib/server/broker-service";
import { orderJsonError, orderReader } from "@/lib/server/orders";
import { ORDER_COPY } from "@/lib/order-entry";

export const runtime = "nodejs";

/**
 * GET /api/broker/orders/requests -> { requests }: the workspace's unconfirmed orders of the last 24 hours that
 * nobody marked as checked. Works while order entry is off. A failure answers 503: an empty 200 would hide
 * unconfirmed orders.
 */
export async function GET() {
  const actor = await orderReader();
  if (actor instanceof Response) return actor;
  try {
    return json(await listOrderRequests(actor));
  } catch (err) {
    console.error(`[orders] GET /api/broker/orders/requests failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return orderJsonError(503, "unavailable", ORDER_COPY.listUnavailable);
  }
}
