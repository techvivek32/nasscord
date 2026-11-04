import { apiActor, UUID_RE } from "@/lib/server/api";
import { BrokerServiceError } from "@/lib/server/broker-service";
import { ibkrLoginUrl } from "@/lib/server/terminal-extra";

export const runtime = "nodejs";

/**
 * GET /api/broker/ibkr/login/[id]: opens the IBKR login for one of the signed-in member's connections.
 *
 * The connect dialog opens this route in a new tab instead of the login link the broker service
 * returned at start. It checks the Nasscord session and that the connection belongs to the member's
 * workspace, asks the service for a fresh one-time ticket (POST /v1/ibkr/:id/ticket) and redirects
 * to the login host with it. A copied link to this route is useless to anyone not signed in to the
 * same workspace. Signed out: sign in first and come back. Anything else: a short page that says why.
 *
 * Only a navigation that starts on Nasscord itself mints a ticket: browsers send
 * `Sec-Fetch-Site: same-origin` for the dialog's link (and for the hop back after sign-in), and
 * `cross-site` or `none` when the visit started on another site, in an email or in the address bar.
 * That stops a link that first signs the reader in to someone else's account (an email link for
 * that account) from landing them straight on that account's IBKR login.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const here = `/api/broker/ibkr/login/${encodeURIComponent(id)}`;

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return page(403, "For your safety, the IBKR login only opens from the Brokers page in Nasscord, not from a link in an email or on another site. Open Brokers and press Connect or Reconnect there.");
  }

  const actor = await apiActor();
  if (actor instanceof Response) {
    if (actor.status === 401) return redirect(new URL(`/login?next=${encodeURIComponent(here)}`, request.url).toString());
    return page(actor.status, await readError(actor));
  }
  if (!UUID_RE.test(id)) return page(404, "That IBKR connection no longer exists. Open Brokers in Nasscord and connect IBKR again.");

  try {
    return redirect(await ibkrLoginUrl(actor, id.toLowerCase()));
  } catch (err) {
    if (err instanceof BrokerServiceError) return page(err.status, err.message);
    console.error(`[api] GET /api/broker/ibkr/login/[id] failed: ${err instanceof Error ? err.name : "unknown error"}`);
    return page(500, "Something went wrong on our side. Close this tab and try again in a moment.");
  }
}

const NO_STORE = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { ...NO_STORE, Location: location } });
}

async function readError(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const error = body && typeof body === "object" && "error" in body ? (body as { error?: unknown }).error : undefined;
  return typeof error === "string" ? error : "The IBKR login cannot be opened right now.";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** A minimal page for this tab when the login cannot be opened. System colors only, so it follows the visitor's theme. */
function page(status: number, message: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>IBKR login not opened</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 32rem; padding: 3rem 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
  p { margin: 0 0 1rem; }
  a { color: LinkText; }
</style>
</head>
<body>
<main>
<h1>The IBKR login did not open</h1>
<p>${esc(message)}</p>
<p><a href="/app/brokers">Go to Brokers in Nasscord</a></p>
</main>
</body>
</html>`;
  return new Response(html, { status, headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" } });
}
