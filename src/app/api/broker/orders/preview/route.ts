import { json } from "@/lib/server/api";
import { BrokerServiceError, previewOrder } from "@/lib/server/broker-service";
import { orderActor, orderJsonError, orderRouteError, readOrderBody } from "@/lib/server/orders";
import { ORDER_COPY, ticketSchema } from "@/lib/order-entry";

export const runtime = "nodejs";

/**
 * POST /api/broker/orders/preview, body OrderTicket -> { request } in status preview. Nothing goes to the
 * broker as an order: the broker service asks for the broker's preview and stores the ticket.
 */
export async function POST(request: Request) {
  const actor = await orderActor(request, "preview");
  if (actor instanceof Response) return actor;
  const body = await readOrderBody(request, ticketSchema, "bad_ticket");
  if (body instanceof Response) return body;
  try {
    return json(await previewOrder(actor, body));
  } catch (err) {
    if (err instanceof BrokerServiceError && (err.kind === "timeout" || err.kind === "unreachable")) {
      return orderJsonError(504, "preview_timeout", ORDER_COPY.previewTimeout);
    }
    return orderRouteError(err, "POST /api/broker/orders/preview");
  }
}
