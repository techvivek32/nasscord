import { apiActor, json, routeError } from "@/lib/server/api";
import { getPortfolio } from "@/lib/server/broker-service";
import { hasActiveConnection } from "@/lib/server/connections";

export const runtime = "nodejs";

/** GET /api/broker/positions -> { positions, errors } (included accounts only; errors are per connection). */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  try {
    if (!(await hasActiveConnection(actor.workspaceId))) return json({ positions: [], errors: [] });
    const { positions, errors } = await getPortfolio(actor);
    return json({ positions, errors });
  } catch (err) {
    return routeError(err, "GET /api/broker/positions");
  }
}
