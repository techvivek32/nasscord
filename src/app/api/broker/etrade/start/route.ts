import { z } from "zod";
import { apiActor, json, limitConnectStep, readBody, routeError } from "@/lib/server/api";
import { startEtrade } from "@/lib/server/broker-service";

export const runtime = "nodejs";

const bodySchema = z.object({
  environment: z.enum(["production", "sandbox"], { error: "Choose Production or Sandbox." }),
  consumerKey: z.string().trim().min(8, "Paste the consumer key from developer.etrade.com.").max(200, "That consumer key is too long."),
  consumerSecret: z.string().trim().min(8, "Paste the consumer secret from developer.etrade.com.").max(200, "That consumer secret is too long."),
});

/**
 * POST /api/broker/etrade/start { environment, consumerKey, consumerSecret } -> { connectionId, authorizeUrl }
 * The key and secret go straight to the broker service, which stores them encrypted. They are never logged here.
 */
export async function POST(request: Request) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  const limited = limitConnectStep(actor, "start");
  if (limited) return limited;
  try {
    const { connectionId, authorizeUrl } = await startEtrade(actor, body);
    return json({ connectionId, authorizeUrl });
  } catch (err) {
    return routeError(err, "POST /api/broker/etrade/start");
  }
}
