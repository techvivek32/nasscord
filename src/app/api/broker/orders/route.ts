import { apiActor, json, routeError } from "@/lib/server/api";
import { getOrders } from "@/lib/server/broker-service";
import { hasActiveConnection } from "@/lib/server/connections";

export const runtime = "nodejs";

/** GET /api/broker/orders -> { orders, errors } (included accounts only; errors are per connection). */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  try {
    if (!(await hasActiveConnection(actor.workspaceId))) return json({ orders: [], errors: [] });
    const { orders, errors } = await getOrders(actor);
    return json({ orders, errors });
  } catch (err) {
    return routeError(err, "GET /api/broker/orders");
  }
}
