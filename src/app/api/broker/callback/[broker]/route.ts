import { randomBytes } from "node:crypto";
import { allowFlowStep } from "@/lib/server/api";
import { BrokerServiceError, completeAggregator, completeOAuth } from "@/lib/server/broker-service";
import {
  allBindings,
  bindingFromCookies,
  brokerName,
  callbackSegment,
  canonicalOrigin,
  clearBindingCookie,
  clientAddress,
  finishUrl,
  flowPage,
  headOnly,
  LOGIN_NOT_SET_UP,
  normalizeOrigin,
  OPAQUE_RE,
  requestOrigin,
  returnOriginKind,
  seeOther,
  UUID_RE,
} from "@/lib/server/oauth-return";

export const runtime = "nodejs";

/*
 * GET /api/broker/callback/<broker>: the one URL registered with every broker (docs/real-backend.md
 * section 8, step 3). Canonical host only, no session, never a redirect of its own before the work is
 * done (brokers require the registered URL to answer as is).
 *
 * OAuth brokers send ?code&state (or ?error&state). SnapTrade sends ?cid&status&connection_id to
 * /api/broker/callback/snaptrade. The app hands the result to the broker service together with the
 * binding cookies this host holds: the service exchanges the code here, on the canonical host, and
 * answers only an opaque one-time ticket and the user's own origin. The browser then goes on with
 * 303 to <origin>/api/broker/oauth/finish?cid&ticket. A code, a state or a portal result never
 * travels to another host, and a login approved in a browser that did not do the hop has no cookie
 * here and is refused (the service removes it).
 *
 * Nothing about the request is logged: the query holds the code and the state.
 */

const TITLE = "Broker login";
const BACK = "Close this tab and go back to the Brokers page in Nasscord, in the tab where you started, to try again.";

function failed(status: number, heading: string, message: string): Response {
  return flowPage({ status, title: TITLE, heading, paragraphs: [message, BACK] });
}

function failure(err: unknown, notConnected: string): Response {
  if (err instanceof BrokerServiceError) return failed(err.status, notConnected, err.message);
  console.error(`[api] GET /api/broker/callback/[broker] failed: ${err instanceof Error ? err.name : "unknown error"}`);
  return failed(500, notConnected, "Something went wrong on our side.");
}

/** On to the user's own host with the ticket. The canonical cookie goes unless it is also the user-host cookie. */
async function toFinish(out: { connectionId: string; returnOrigin: string; ticket: string }, canonical: string, notConnected: string): Promise<Response> {
  const origin = normalizeOrigin(out.returnOrigin);
  if (!UUID_RE.test(out.connectionId ?? "") || !OPAQUE_RE.test(out.ticket ?? "") || !origin) {
    return failed(502, notConnected, "The broker service sent a reply the app could not read.");
  }
  // Checked again now: a tenant may have lost white-label (or been suspended) since the login started.
  if (!(await returnOriginKind(origin))) {
    return failed(403, notConnected, `Nasscord no longer returns logins to ${new URL(origin).host}. Open Nasscord at ${canonical} and connect from Brokers there.`);
  }
  const id = out.connectionId.toLowerCase();
  return seeOther(finishUrl(origin, id, out.ticket), origin === canonical ? [] : [clearBindingCookie(id, canonical)]);
}

/** A link checker's HEAD must not use the state (Next would otherwise run GET for it). */
export function HEAD() {
  return headOnly();
}

export async function GET(request: Request, { params }: { params: Promise<{ broker: string }> }) {
  const { broker } = await params;
  const segment = callbackSegment(broker);
  const canonical = canonicalOrigin();
  if (!canonical) return failed(503, "Broker logins are not set up", LOGIN_NOT_SET_UP);
  if (!segment) return failed(404, "Unknown broker login", "Nasscord has no broker login at this address.");
  // SnapTrade is the intermediary, not the broker the user connected (the service's message names
  // that one), so its pages use a neutral heading instead of "SnapTrade was not connected".
  const name = segment === "snaptrade" ? null : brokerName(segment);
  const notConnected = name ? `${name} was not connected` : "The broker was not connected";
  if (requestOrigin(request) !== canonical) {
    return failed(404, "This address does not work here", `${name ?? "Broker"} logins return to ${canonical} only.`);
  }
  if (!allowFlowStep(clientAddress(request), "callback")) {
    return failed(429, notConnected, "Too many login attempts from this network. Wait a few minutes.");
  }
  const q = new URL(request.url).searchParams;

  try {
    if (segment === "snaptrade") {
      const cid = (q.get("cid") ?? "").toLowerCase();
      if (!UUID_RE.test(cid)) return failed(400, "The broker login did not finish", "This login link is not complete.");
      const status = (q.get("status") ?? "").trim().toUpperCase().slice(0, 40);
      const authorizationId = (q.get("connection_id") ?? "").trim();
      // No cookie here: this browser never did the hop. A nonce that cannot match makes the service
      // refuse the login and remove it (as an OAuth callback without cookies does), so whoever did
      // the hop cannot finish it with an authorization approved in someone else's browser.
      const binding = bindingFromCookies(request, cid) ?? randomBytes(32).toString("base64url");
      const out = await completeAggregator({
        connectionId: cid,
        status: status || "ERROR",
        ...(authorizationId && authorizationId.length <= 200 ? { authorizationId } : {}),
        binding,
      });
      return toFinish(out, canonical, notConnected);
    }

    const state = q.get("state") ?? "";
    const code = q.get("code") ?? "";
    const error = q.get("error") ?? "";
    if (!OPAQUE_RE.test(state)) {
      const label = brokerName(segment);
      return error
        ? failed(400, notConnected, `${label} did not grant access: the login was cancelled or refused.`)
        : failed(400, `${label} login not finished`, "This login link is not complete or has expired.");
    }
    const out = await completeOAuth({
      brokerId: segment,
      state,
      ...(code && code.length <= 4096 ? { code } : {}),
      ...(error ? { error: error.slice(0, 100) } : {}),
      bindings: allBindings(request),
    });
    return toFinish(out, canonical, notConnected);
  } catch (err) {
    return failure(err, notConnected);
  }
}
