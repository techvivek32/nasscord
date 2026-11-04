import { apiActor, json, routeError } from "@/lib/server/api";
import { BrokerServiceError, getPortfolio, isBrokerServiceConfigured } from "@/lib/server/broker-service";
import { mergePortfolio, workspaceConnections } from "@/lib/server/connections";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/broker/connections -> { connections, portfolioError? }
 * Rows from the database (the user's own JWT, RLS), with balances merged in from the broker service
 * when a connection is active. When the service cannot answer, the rows still come back without
 * balances and `portfolioError` says why.
 */
export async function GET() {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  try {
    const connections = await workspaceConnections(await createClient(), actor.workspaceId);
    const active = connections.some((c) => c.status === "connected" || c.status === "expiring");
    if (!active || !isBrokerServiceConfigured()) return json({ connections });
    try {
      const portfolio = await getPortfolio(actor);
      return json({ connections: mergePortfolio(connections, portfolio) });
    } catch (err) {
      // Only the service's own readable sentences reach the browser; anything else is logged by name.
      if (!(err instanceof BrokerServiceError)) console.error(`[api] portfolio merge failed: ${err instanceof Error ? err.name : "unknown error"}`);
      return json({ connections, portfolioError: err instanceof BrokerServiceError ? err.message : "Balances are not available right now." });
    }
  } catch (err) {
    return routeError(err, "GET /api/broker/connections");
  }
}
