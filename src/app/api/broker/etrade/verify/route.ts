import { z } from "zod";
import { apiActor, json, jsonError, limitConnectStep, readBody, routeError } from "@/lib/server/api";
import { verifyEtrade } from "@/lib/server/broker-service";
import { connectionInWorkspace } from "@/lib/server/connections";

export const runtime = "nodejs";

const bodySchema = z.object({
  connectionId: z.uuid("That connection is not valid. Start again."),
  verifier: z
    .string()
    .trim()
    .min(4, "Paste the verification code E*TRADE showed you.")
    .max(32, "That verification code is too long.")
    .regex(/^[A-Za-z0-9]+$/, "The verification code is letters and numbers only."),
});

/** POST /api/broker/etrade/verify { connectionId, verifier } -> { connection } */
export async function POST(request: Request) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  const limited = limitConnectStep(actor, "verify");
  if (limited) return limited;
  try {
    if (!(await connectionInWorkspace(body.connectionId, actor.workspaceId))) return jsonError(404, "That connection no longer exists. Start again.");
    const { connection } = await verifyEtrade(actor, body);
    return json({ connection });
  } catch (err) {
    return routeError(err, "POST /api/broker/etrade/verify");
  }
}
