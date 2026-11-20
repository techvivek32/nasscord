import { json, UUID_RE } from "@/lib/server/api";
import { getOrderRequest } from "@/lib/server/broker-service";
import { orderJsonError, orderReader, orderRouteError } from "@/lib/server/orders";

export const runtime = "nodejs";

/** GET /api/broker/orders/requests/:id -> { request }. Works while order entry is off. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await orderReader();
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return orderJsonError(404, "not_found", "That order request does not exist.");
  try {
    return json(await getOrderRequest(actor, id));
  } catch (err) {
    return orderRouteError(err, "GET /api/broker/orders/requests/:id");
  }
}
