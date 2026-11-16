import { z } from "zod";
import { apiActor, jsonError, limitConnectStep, readBody, routeError } from "@/lib/server/api";
import { startAggregator } from "@/lib/server/broker-service";
import { BROKER_IDS, loginStarted, prepareLogin } from "@/lib/server/oauth-return";

export const runtime = "nodejs";

const bodySchema = z.object({
  brokerId: z.enum(BROKER_IDS, { error: "Choose a broker." }),
  environment: z.enum(["production", "paper", "sandbox"], { error: "Choose the account type." }).optional(),
});

/**
 * POST /api/broker/aggregator/start { brokerId, environment? } -> { connectionId, openUrl } + Set-Cookie ns_oauth_<connectionId>
 *
 * A broker read through SnapTrade (Fidelity, Robinhood, Public, Moomoo, Webull...). The same hand-off
 * as an OAuth login (docs/real-backend.md section 8): the hop on the canonical host asks the service
 * for SnapTrade's portal link (broker preselected, read only), and SnapTrade returns to the canonical
 * callback, never to this host.
 */
export async function POST(request: Request) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  if (body.environment === "sandbox" && process.env.NODE_ENV === "production") {
    return jsonError(400, "Sandbox accounts hold sample data and are not offered here. Connect your own account.");
  }
  const limited = limitConnectStep(actor, "aggregator");
  if (limited) return limited;
  try {
    const prep = await prepareLogin(request, actor);
    if (prep instanceof Response) return prep;
    const { connectionId } = await startAggregator(actor, {
      brokerId: body.brokerId,
      ...(body.environment ? { environment: body.environment } : {}),
      returnOrigin: prep.returnOrigin,
      bindingHash: prep.binding.hash,
    });
    return loginStarted(connectionId, prep);
  } catch (err) {
    return routeError(err, "POST /api/broker/aggregator/start");
  }
}
