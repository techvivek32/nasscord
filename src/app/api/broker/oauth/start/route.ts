import { z } from "zod";
import { apiActor, jsonError, limitConnectStep, readBody, routeError } from "@/lib/server/api";
import { startOAuth } from "@/lib/server/broker-service";
import { BROKER_IDS, CONNECTION_METHODS, loginStarted, prepareLogin } from "@/lib/server/oauth-return";

export const runtime = "nodejs";

const pasted = (what: string) =>
  z
    .string()
    .trim()
    .max(512, `That ${what} is too long.`)
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || v.length >= 4, `Paste the ${what} exactly as the broker shows it.`);

const bodySchema = z
  .object({
    brokerId: z.enum(BROKER_IDS, { error: "Choose a broker." }),
    method: z.enum(CONNECTION_METHODS, { error: "Choose how to connect." }).optional(),
    client: z.enum(["user", "platform"], { error: "Choose whose app to sign in with." }).optional(),
    environment: z.enum(["production", "paper", "sandbox"], { error: "Choose the account type." }).optional(),
    clientId: pasted("app key"),
    clientSecret: pasted("app secret"),
  })
  .refine((b) => !!b.clientId === !!b.clientSecret, { error: "Paste both the app key and the app secret." })
  .refine((b) => b.client !== "user" || !!b.clientId, { error: "Paste your app key and app secret." })
  .refine((b) => b.client !== "platform" || !b.clientId, { error: "Nasscord's own sign-in takes no app key." });

/**
 * POST /api/broker/oauth/start { brokerId, method?, client?, environment?, clientId?, clientSecret? }
 *   -> { connectionId, openUrl } + Set-Cookie ns_oauth_<connectionId>
 *
 * Step 1 of the hand-off (docs/real-backend.md section 8). Checks that the page's own origin is one a
 * login may return to, makes the binding nonce, and asks the broker service for a pending connection
 * (it keeps only sha256 of the nonce). The nonce goes into an HttpOnly cookie on this host; `openUrl`
 * is the canonical hop the dialog opens in a new tab. The user's own app key and secret go straight to
 * the service, which stores them encrypted; they are never logged.
 */
export async function POST(request: Request) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const body = await readBody(request, bodySchema);
  if (body instanceof Response) return body;
  // Sample data never reaches users: a broker's sandbox (tastytrade cert, Webull's sandbox) is for developers only.
  if (body.environment === "sandbox" && process.env.NODE_ENV === "production") {
    return jsonError(400, "Sandbox accounts hold the broker's sample data and are not offered here. Connect your own account.");
  }
  const limited = limitConnectStep(actor, "oauth");
  if (limited) return limited;
  try {
    const prep = await prepareLogin(request, actor);
    if (prep instanceof Response) return prep;
    const { connectionId } = await startOAuth(actor, {
      brokerId: body.brokerId,
      ...(body.method ? { method: body.method } : {}),
      ...(body.client ? { client: body.client } : {}),
      ...(body.environment ? { environment: body.environment } : {}),
      ...(body.clientId && body.clientSecret ? { clientId: body.clientId, clientSecret: body.clientSecret } : {}),
      returnOrigin: prep.returnOrigin,
      bindingHash: prep.binding.hash,
    });
    return loginStarted(connectionId, prep);
  } catch (err) {
    return routeError(err, "POST /api/broker/oauth/start");
  }
}
