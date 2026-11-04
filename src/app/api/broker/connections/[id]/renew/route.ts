import { apiActor, json, jsonError, limitConnectStep, routeError, UUID_RE } from "@/lib/server/api";
import { renewConnection } from "@/lib/server/broker-service";
import { connectionInWorkspace } from "@/lib/server/connections";

export const runtime = "nodejs";

/**
 * POST /api/broker/connections/[id]/renew -> { connection, needsLogin?, authorizeUrl? }.
 * IBKR: needsLogin means the user must log in again; the browser opens /api/broker/ibkr/login/[id]
 * (the service's one-time link never reaches the browser). E*TRADE: authorizeUrl is E*TRADE's own
 * approval page for a fresh request token.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError(404, "That connection no longer exists. Refresh the page.");
  const limited = limitConnectStep(actor, "renew");
  if (limited) return limited;
  try {
    if (!(await connectionInWorkspace(id, actor.workspaceId))) return jsonError(404, "That connection no longer exists. Refresh the page.");
    const { connection, loginUrl } = await renewConnection(actor, id);
    if (!loginUrl) return json({ connection });
    return json(connection.brokerId === "ibkr" ? { connection, needsLogin: true } : { connection, authorizeUrl: loginUrl });
  } catch (err) {
    return routeError(err, "POST /api/broker/connections/[id]/renew");
  }
}
