import { z } from "zod";
import { apiActor, json, limitConnectStep, readBody, routeError } from "@/lib/server/api";
import { startIbkr } from "@/lib/server/broker-service";

export const runtime = "nodejs";

const bodySchema = z.object({ environment: z.enum(["production", "paper"], { error: "Choose Live or Paper." }) });

/**
 * POST /api/broker/ibkr/start { environment } -> { connectionId }.
 * The service also returns a one-time login link; it stays on the server. The browser opens
 * /api/broker/ibkr/login/[id], which checks the session and mints a fresh link.
 */
export async function POST(request: Request) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  const limited = limitConnectStep(actor, "start");
  if (limited) return limited;
  try {
    const { connectionId } = await startIbkr(actor, body);
    return json({ connectionId });
  } catch (err) {
    return routeError(err, "POST /api/broker/ibkr/start");
  }
}
