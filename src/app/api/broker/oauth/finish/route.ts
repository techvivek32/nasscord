import { apiActor, limitConnectStep, UUID_RE } from "@/lib/server/api";
import { BrokerServiceError, claimConnection } from "@/lib/server/broker-service";
import { connectionInWorkspace } from "@/lib/server/connections";
import { bindingFromCookies, clearBindingCookie, flowPage, headOnly, OPAQUE_RE, requestOrigin, seeOther } from "@/lib/server/oauth-return";

export const runtime = "nodejs";

/*
 * GET /api/broker/oauth/finish?cid&ticket: the last step of an OAuth or SnapTrade login
 * (docs/real-backend.md section 8, step 4), on the user's own host, where their session lives.
 *
 * The canonical callback sends the browser here with a one-time ticket only. The login joins the
 * workspace when all three hold: the Supabase session of the user who started it, the ns_oauth_<cid>
 * cookie this host set at the start (its nonce is the binding), and the ticket. The broker service
 * checks them and activates the connection (merging it into an existing connection of the same login),
 * then this route clears the cookie and lands on /app/brokers?connected=<id>, with the id the claim
 * answered. This is a top-level navigation from another site (the canonical host), so it does not
 * check Sec-Fetch-Site. The ticket is never logged.
 */

const TITLE = "Broker login";
const BROKERS = { href: "/app/brokers", label: "Go to Brokers in Nasscord" };

function failed(status: number, message: string, cookies: string[] = []): Response {
  return flowPage({ status, title: TITLE, heading: "The broker was not connected", paragraphs: [message], link: BROKERS, cookies });
}

async function readError(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const error = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" ? error : "This login cannot be finished right now.";
}

/** A link checker's HEAD must not use the ticket (Next would otherwise run GET for it). */
export function HEAD() {
  return headOnly();
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const cid = (params.get("cid") ?? "").toLowerCase();
  const ticket = params.get("ticket") ?? "";
  const here = requestOrigin(request) ?? "https://invalid";
  const clear = UUID_RE.test(cid) ? [clearBindingCookie(cid, here)] : [];

  const actor = await apiActor();
  if (actor instanceof Response) {
    // The ticket lives 5 minutes and only the user who started the login may use it.
    if (actor.status === 401) {
      return failed(401, "Sign in to Nasscord on this site with the account that started the connection, then press Connect again on the Brokers page.");
    }
    return failed(actor.status, await readError(actor));
  }
  if (!UUID_RE.test(cid) || !OPAQUE_RE.test(ticket)) return failed(400, "This login link is not complete. Press Connect again on the Brokers page.", clear);

  const binding = bindingFromCookies(request, cid);
  if (!binding) {
    return failed(
      403,
      "This login was started in another browser or on another device. Start again from Brokers in the browser you use for Nasscord.",
      clear,
    );
  }
  const limited = limitConnectStep(actor, "claim");
  if (limited) return failed(429, await readError(limited));

  try {
    if (!(await connectionInWorkspace(cid, actor.workspaceId))) {
      return failed(404, "This connection is not in your workspace. Press Connect again on the Brokers page.", clear);
    }
    const { connection } = await claimConnection(actor, { connectionId: cid, ticket, binding });
    return seeOther(`/app/brokers?connected=${encodeURIComponent(connection.id)}`, clear);
  } catch (err) {
    if (err instanceof BrokerServiceError) return failed(err.status, err.message, clear);
    console.error(`[api] GET /api/broker/oauth/finish failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return failed(500, "Something went wrong on our side. Press Connect again on the Brokers page in a moment.", clear);
  }
}
