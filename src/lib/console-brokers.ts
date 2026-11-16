import { CONNECT_SPECS, METHOD_BROKERS, METHOD_LABEL, reconnectWarnHours } from "@/lib/broker-connect";
import type { BrokerId, ConnectClient, ConnectionMethod, ConnectOption } from "@/lib/types";

/*
 * Pure broker rules of the super admin console: the BROKER_AUDIENCE key of each way of connecting, who
 * may connect a broker right now, and the expiry windows the overview counts connections by. Used by
 * the console's Brokers page and by src/lib/server/console.ts. The tests in
 * src/lib/server/__tests__/console-brokers.test.mjs pin them to the broker service's config.mjs and to
 * toConnectionStatus in src/lib/server/rows.ts.
 */

/** Who may connect a broker now, as the console's registry table shows it. */
export type BrokerReach = "everyone" | "owner" | "setup" | "closed" | "unknown";

/**
 * Methods that take either the user's own OAuth app or Nasscord's registered client (a connect spec of
 * each). Their BROKER_AUDIENCE key names the client. Equal to TWO_CLIENT_METHODS in the broker service.
 */
export const TWO_CLIENT_METHODS: ReadonlySet<ConnectionMethod> = new Set(
  (Object.keys(METHOD_LABEL) as ConnectionMethod[]).filter((m) => {
    const clients = new Set(
      Object.values(CONNECT_SPECS)
        .flat()
        .filter((s) => s.method === m)
        .map((s) => s.client ?? null),
    );
    return clients.has("user") && clients.has("platform");
  }),
);

/**
 * The BROKER_AUDIENCE key of a method and client, as the broker service names it (gateKey in
 * services/broker/src/config.mjs): "schwab_oauth.user", "schwab_oauth.platform", "alpaca_key".
 */
export function gateKey(method: ConnectionMethod, client: ConnectClient | null): string {
  return TWO_CLIENT_METHODS.has(method) ? `${method}.${client ?? "user"}` : method;
}

/** Sort order of the registry rows: open to everyone first. */
export const REACH_RANK: Readonly<Record<BrokerReach, number>> = { everyone: 0, owner: 1, setup: 2, closed: 3, unknown: 4 };

/** Who may connect a broker now, from the options the super admin got for that broker. */
export function reachOf(options: ConnectOption[], reachable: boolean): BrokerReach {
  if (!reachable) return "unknown";
  if (options.some((o) => o.available && o.audience === "all")) return "everyone";
  if (options.some((o) => o.available)) return "owner";
  if (options.some((o) => o.reasonCode === "not_configured" || o.reasonCode === "no_environment")) return "setup";
  return "closed";
}

/**
 * The windows the overview counts "expiring" connections by. As toConnectionStatus (rows.ts) maps them,
 * an active connection is expiring inside its broker's warn window (reconnectWarnHours: 2 hours, 48 for
 * Schwab's weekly login). One group per window, with the methods that use it. Every broker of a method
 * must share the method's window, or the console's count would differ from the terminal's badges.
 */
export function expiryWindows(): Array<{ hours: number; methods: ConnectionMethod[] }> {
  const byHours = new Map<number, ConnectionMethod[]>();
  for (const [method, brokers] of Object.entries(METHOD_BROKERS) as Array<[ConnectionMethod, readonly BrokerId[]]>) {
    const hours = Math.max(...brokers.map((b) => reconnectWarnHours(b, method)));
    byHours.set(hours, [...(byHours.get(hours) ?? []), method]);
  }
  return [...byHours].map(([hours, methods]) => ({ hours, methods }));
}
