import { json, UUID_RE } from "@/lib/server/api";
import { checkOrderRequest } from "@/lib/server/broker-service";
import { orderActor, orderJsonError, orderRouteError } from "@/lib/server/orders";

export const runtime = "nodejs";

/** POST /api/broker/orders/requests/:id/check ("Check again") -> { request }. Works while order entry is off. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await orderActor(request, "check");
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return orderJsonError(404, "not_found", "That order request does not exist.");
  try {
    return json(await checkOrderRequest(actor, id));
  } catch (err) {
    return orderRouteError(err, "POST /api/broker/orders/requests/:id/check");
  }
}
