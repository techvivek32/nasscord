import { apiActor, json, routeError } from "@/lib/server/api";
import { cachedOptions } from "@/lib/server/oauth-return";

export const runtime = "nodejs";

/**
 * GET /api/broker/options -> BrokerOptions: every way of connecting a broker, and whether this user
 * may use it now (the broker service's GET /v1/options: built, configured, BROKER_AUDIENCE). The
 * connect UI joins it with the specs in src/lib/broker-connect (connectChoices). Kept 60 s per role.
 */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  try {
    return json(await cachedOptions(actor));
  } catch (err) {
    return routeError(err, "GET /api/broker/options");
  }
}
