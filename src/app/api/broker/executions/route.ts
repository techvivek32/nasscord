import { apiActor, json, routeError } from "@/lib/server/api";
import { getExecutions } from "@/lib/server/broker-service";
import { hasActiveConnection } from "@/lib/server/connections";

export const runtime = "nodejs";

/** GET /api/broker/executions -> { executions, errors } (included accounts only; errors are per connection). */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  try {
    if (!(await hasActiveConnection(actor.workspaceId))) return json({ executions: [], errors: [] });
    const { executions, errors } = await getExecutions(actor);
    return json({ executions, errors });
  } catch (err) {
    return routeError(err, "GET /api/broker/executions");
  }
}
