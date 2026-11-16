import { apiActor, json, jsonError, limitConnectStep, routeError, UUID_RE } from "@/lib/server/api";
import { renewConnection } from "@/lib/server/broker-service";
import {
  bindingCookie,
  brokerRedirect,
  connectionInWorkspaceWithMethod,
  hopUrl,
  jsonWithCookies,
  prepareLogin,
  REDIRECT_METHODS,
  type LoginPrep,
} from "@/lib/server/oauth-return";
import type { RenewNext } from "@/lib/types";

export const runtime = "nodejs";

const GONE = "That connection no longer exists. Refresh the page.";

/**
 * POST /api/broker/connections/[id]/renew -> { connection, next?, needsLogin?, authorizeUrl? }
 *
 * Reconnect. The broker service first tries the connection's own refresh; `next` says what the user
 * does when that is not enough (RenewNext):
 * - gateway_login (IBKR): open /api/broker/ibkr/login/[id] in a new tab. The service's one-time login
 *   link never reaches the browser. Also answered as `needsLogin: true` for the existing dialog.
 * - oauth1_verifier (E*TRADE): approve again on `authorizeUrl` (E*TRADE's own page) and paste the new
 *   code. Also answered as `authorizeUrl` for the existing dialog.
 * - api_key (Alpaca, Tradier token): paste the key again, replace-key mode for this connection.
 * - redirect (OAuth, SnapTrade): a new login through the canonical hop (docs/real-backend.md
 *   section 8). This route makes the binding nonce, sends the service the return origin and its hash,
 *   sets ns_oauth_<id> on this host, and answers next.url = the hop to open in a new tab. A Reconnect of
 *   these always starts a new login, even while the session still works (Schwab's 7-day end only
 *   moves with a new login).
 * No `next`: the session works again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await apiActor();
  if (actor instanceof Response) return actor;
  const { id: rawId } = await params;
  if (!UUID_RE.test(rawId)) return jsonError(404, GONE);
  const id = rawId.toLowerCase();
  const limited = limitConnectStep(actor, "renew");
  if (limited) return limited;
  try {
    const conn = await connectionInWorkspaceWithMethod(id, actor.workspaceId);
    if (!conn) return jsonError(404, GONE);

    let prep: LoginPrep | null = null;
    if (REDIRECT_METHODS.has(conn.method)) {
      const p = await prepareLogin(request, actor);
      if (p instanceof Response) return p;
      prep = p;
    }

    const out = await renewConnection(actor, id, prep ? { returnOrigin: prep.returnOrigin, bindingHash: prep.binding.hash } : undefined);
    const { connection, loginUrl } = out;
    const kind = out.next?.kind;

    if (kind === "redirect") {
      if (!prep) return jsonError(502, "The broker service asked for a new login this connection does not use. Disconnect it and connect again.");
      const next: RenewNext = { kind: "redirect", url: hopUrl(prep.canonical, id, prep.binding.nonce) };
      return jsonWithCookies({ connection, next }, [bindingCookie(id, prep.binding.nonce, prep.returnOrigin)]);
    }
    if (kind === "api_key") return json({ connection, next: { kind: "api_key" } satisfies RenewNext });
    if (kind === "gateway_login" || (!kind && loginUrl && connection.brokerId === "ibkr")) {
      // IBKR's login link stays on the server: the browser opens the app's own login route.
      return json({ connection, next: { kind: "gateway_login" } satisfies RenewNext, needsLogin: true });
    }
    if (kind === "oauth1_verifier" || (!kind && loginUrl)) {
      const authorizeUrl = brokerRedirect(out.next?.kind === "oauth1_verifier" && out.next.authorizeUrl ? out.next.authorizeUrl : loginUrl);
      if (!authorizeUrl) return jsonError(502, "The broker service sent a login page address the app does not open.");
      return json({ connection, next: { kind: "oauth1_verifier", authorizeUrl } satisfies RenewNext, authorizeUrl });
    }
    return json({ connection });
  } catch (err) {
    return routeError(err, "POST /api/broker/connections/[id]/renew");
  }
}
