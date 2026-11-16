import { allowFlowStep } from "@/lib/server/api";
import { BrokerServiceError, connectHop } from "@/lib/server/broker-service";
import {
  bindingCookie,
  bindingFromCookies,
  brokerName,
  brokerRedirect,
  canonicalOrigin,
  clientAddress,
  flowPage,
  headOnly,
  LOGIN_NOT_SET_UP,
  loginViaSnapTrade,
  OPAQUE_RE,
  requestOrigin,
  sameNonce,
  sameOriginCall,
  seeOther,
  UUID_RE,
} from "@/lib/server/oauth-return";

export const runtime = "nodejs";

/*
 * The hop (docs/real-backend.md section 8, step 2), on the canonical host only, with no session: the
 * login is authorised by its binding nonce N, which the broker service checks against sha256(N).
 *
 * GET  ?cid&n  A confirmation page naming the workspace the broker accounts would join and the masked
 *              email of who asked, with a Continue button. A link someone forwarded opens behind this
 *              page. When this host already holds ns_oauth_<cid> with the same N, this browser started
 *              the login (on the canonical host itself) or opened the hop before, so it goes straight on.
 * POST cid, n  The Continue button: same-origin only (an auto-submitted form from another site is
 *              refused). Sets ns_oauth_<cid>=N on the canonical host, then 303 to the broker's page
 *              (OAuth authorize URL with a fresh state, or SnapTrade's portal link).
 */

const TITLE = "Broker login";
const CLOSE = "Close this tab and press Connect again on the Brokers page in Nasscord.";

function notHere(canonical: string): Response {
  return flowPage({ status: 404, title: TITLE, heading: "This link does not work here", paragraphs: [`Broker logins open on ${canonical}. ${CLOSE}`] });
}

function failed(status: number, message: string): Response {
  return flowPage({ status, title: TITLE, heading: "The broker login did not open", paragraphs: [message, "You can close this tab."] });
}

function failure(err: unknown, where: string): Response {
  if (err instanceof BrokerServiceError) return failed(err.status, err.message);
  console.error(`[api] ${where} failed: ${err instanceof Error ? err.name : "unknown error"}`);
  return failed(500, `Something went wrong on our side. ${CLOSE}`);
}

/** Checks shared by both methods: the canonical host, the burst guard. */
function precheck(request: Request): { canonical: string } | Response {
  const canonical = canonicalOrigin();
  if (!canonical) return failed(503, LOGIN_NOT_SET_UP);
  if (requestOrigin(request) !== canonical) return notHere(canonical);
  if (!allowFlowStep(clientAddress(request), "hop")) return failed(429, "Too many login attempts from this network. Wait a few minutes, then press Connect again in Nasscord.");
  return { canonical };
}

/** Uses the hop: the service moves the login on and answers the broker's page; the cookie binds this browser. */
async function hop(connectionId: string, nonce: string, repeat: boolean, canonical: string, where: string): Promise<Response> {
  try {
    const out = await connectHop({ connectionId, binding: nonce, repeat });
    const to = brokerRedirect(out.redirectUrl);
    // Neutral: for a SnapTrade login the address is SnapTrade's portal, not the broker's own page.
    if (!to) return failed(502, `The login page address Nasscord received is not one it opens. ${CLOSE}`);
    return seeOther(to, [bindingCookie(connectionId, nonce, canonical)]);
  } catch (err) {
    return failure(err, where);
  }
}

/** A link checker's HEAD must not use the hop (Next would otherwise run GET for it). */
export function HEAD() {
  return headOnly();
}

export async function GET(request: Request) {
  const pre = precheck(request);
  if (pre instanceof Response) return pre;
  const params = new URL(request.url).searchParams;
  const cid = (params.get("cid") ?? "").toLowerCase();
  const nonce = params.get("n") ?? "";
  if (!UUID_RE.test(cid) || !OPAQUE_RE.test(nonce)) return failed(400, `This login link is not complete. ${CLOSE}`);

  if (sameNonce(bindingFromCookies(request, cid), nonce)) return hop(cid, nonce, true, pre.canonical, "GET /api/broker/oauth/go");

  try {
    const who = await connectHop({ connectionId: cid, binding: nonce, preview: true });
    const name = brokerName(who.brokerId);
    const workspace = who.workspaceName ? `the Nasscord workspace "${who.workspaceName}" (a name its owner chose)` : "a Nasscord workspace";
    const asker = who.requestedBy ? `, at the request of ${who.requestedBy}` : "";
    // A SnapTrade login opens SnapTrade's portal first, not the broker's own page.
    const viaSnapTrade = await loginViaSnapTrade(cid, who.brokerId);
    const next =
      viaSnapTrade === true
        ? `Next you choose and log in to ${name} through SnapTrade.`
        : viaSnapTrade === false
          ? `Next you log in to ${name} on its own page.`
          : `Next you log in to ${name}.`;
    return flowPage({
      status: 200,
      title: `Connect ${name}`,
      heading: `Connect ${name} to Nasscord`,
      paragraphs: [
        `${next} The ${name} accounts you approve there join ${workspace}${asker}. Nasscord reads them; it places no orders.`,
        "Continue only if you pressed Connect in Nasscord yourself a moment ago. If someone sent you this link, close this tab: continuing would let them see your accounts.",
      ],
      form: { action: "/api/broker/oauth/go", fields: { cid, n: nonce }, button: `Continue to ${name}` },
    });
  } catch (err) {
    return failure(err, "GET /api/broker/oauth/go");
  }
}

export async function POST(request: Request) {
  const pre = precheck(request);
  if (pre instanceof Response) return pre;
  // Only the Continue button of the page above: a form another site submits carries its own origin.
  if (!sameOriginCall(request, pre.canonical)) return failed(403, `For your safety, a broker login only continues from Nasscord's own page. ${CLOSE}`);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 2048) return failed(413, `This login request is too large. ${CLOSE}`);
  let form: URLSearchParams;
  try {
    const text = await request.text();
    if (text.length > 2048) return failed(413, `This login request is too large. ${CLOSE}`);
    form = new URLSearchParams(text);
  } catch {
    return failed(400, `This login request could not be read. ${CLOSE}`);
  }
  const cid = (form.get("cid") ?? "").toLowerCase();
  const nonce = form.get("n") ?? "";
  if (!UUID_RE.test(cid) || !OPAQUE_RE.test(nonce)) return failed(400, `This login link is not complete. ${CLOSE}`);
  return hop(cid, nonce, sameNonce(bindingFromCookies(request, cid), nonce), pre.canonical, "POST /api/broker/oauth/go");
}
