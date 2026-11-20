import { json, UUID_RE } from "@/lib/server/api";
import { resolveOrderRequest } from "@/lib/server/broker-service";
import { orderActor, orderJsonError, orderRouteError } from "@/lib/server/orders";

export const runtime = "nodejs";

/**
 * POST /api/broker/orders/requests/:id/resolve ("I checked it") -> { request } with resolvedAt. Nasscord stops
 * warning about that unconfirmed order; nothing changes at the broker. Works while order entry is off.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await orderActor(request, "resolve");
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return orderJsonError(404, "not_found", "That order request does not exist.");
  try {
    return json(await resolveOrderRequest(actor, id));
  } catch (err) {
    return orderRouteError(err, "POST /api/broker/orders/requests/:id/resolve");
  }
}
