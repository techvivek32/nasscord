import { apiActor, json, jsonError, routeError, UUID_RE } from "@/lib/server/api";
import { deleteConnection, getConnection } from "@/lib/server/broker-service";
import { connectionInWorkspace } from "@/lib/server/connections";

export const runtime = "nodejs";

const GONE = "That connection no longer exists. Refresh the page.";

/** GET /api/broker/connections/[id] -> { connection } with fresh status from the broker service. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError(404, GONE);
  try {
    if (!(await connectionInWorkspace(id, actor.workspaceId))) return jsonError(404, GONE);
    const { connection } = await getConnection(actor, id);
    return json({ connection });
  } catch (err) {
    return routeError(err, "GET /api/broker/connections/[id]");
  }
}

/** DELETE /api/broker/connections/[id] -> { ok: true }. The service revokes tokens or stops the gateway. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError(404, GONE);
  try {
    if (!(await connectionInWorkspace(id, actor.workspaceId))) return jsonError(404, GONE);
    await deleteConnection(actor, id);
    return json({ ok: true });
  } catch (err) {
    return routeError(err, "DELETE /api/broker/connections/[id]");
  }
}
