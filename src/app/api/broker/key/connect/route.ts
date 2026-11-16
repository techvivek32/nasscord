import { z } from "zod";
import { apiActor, json, jsonError, limitConnectStep, readBody, routeError, UUID_RE } from "@/lib/server/api";
import { connectKey } from "@/lib/server/broker-service";
import { connectionInWorkspace } from "@/lib/server/connections";
import { BROKER_IDS, CONNECTION_METHODS } from "@/lib/server/oauth-return";

export const runtime = "nodejs";

/** An optional pasted value: blank means absent. */
const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .optional()
    .transform((v) => (v ? v : undefined));

const bodySchema = z.object({
  brokerId: z.enum(BROKER_IDS, { error: "Choose a broker." }),
  method: z.enum(CONNECTION_METHODS, { error: "Choose how to connect." }).optional(),
  // Keys reach the user's real or own paper account only: no broker's sample-data sandbox here.
  environment: z.enum(["production", "paper"], { error: "Choose Live or Paper." }).optional(),
  keyId: optionalText(256, "That key ID is too long.").refine((v) => v === undefined || v.length >= 4, "Paste the key ID exactly as the broker shows it."),
  secret: z
    .string({ error: "Paste the secret." })
    .trim()
    .min(8, "Paste the secret exactly as the broker shows it.")
    .max(512, "That secret is too long."),
  connectionId: z.string().regex(UUID_RE, "That connection no longer exists. Refresh the page.").optional(),
});

/**
 * POST /api/broker/key/connect { brokerId, method?, environment?, keyId?, secret, connectionId? }
 *   -> { connection }
 * The api_key flow (Alpaca key and secret, the owner's own Tradier token). The broker service checks
 * the key with a read call, stores it encrypted and answers the connection with its accounts; a key
 * of a login the workspace already has updates that connection. `connectionId` is replace-key mode
 * (Reconnect answered next.kind "api_key"). The key is never logged or sent back.
 */
export async function POST(request: Request) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  const limited = limitConnectStep(actor, "key");
  if (limited) return limited;
  try {
    if (body.connectionId && !(await connectionInWorkspace(body.connectionId.toLowerCase(), actor.workspaceId))) {
      return jsonError(404, "That connection no longer exists. Refresh the page.");
    }
    const { connection } = await connectKey(actor, {
      brokerId: body.brokerId,
      ...(body.method ? { method: body.method } : {}),
      ...(body.environment ? { environment: body.environment } : {}),
      ...(body.keyId ? { keyId: body.keyId } : {}),
      secret: body.secret,
      ...(body.connectionId ? { connectionId: body.connectionId.toLowerCase() } : {}),
    });
    return json({ connection });
  } catch (err) {
    return routeError(err, "POST /api/broker/key/connect");
  }
}
