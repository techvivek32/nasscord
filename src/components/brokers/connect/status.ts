import { getBroker } from "@/lib/brokers";
import { connectSpecs, environmentLabel as registryEnvironmentLabel, findSpec, optionFor } from "@/lib/broker-connect";
import { fmtDateTime, fmtTimeET, timeAgo } from "@/lib/format";
import type {
  AccountType,
  BrokerConnection,
  BrokerId,
  BrokerOptions,
  ConnectFlow,
  ConnectionEnvironment,
  ConnectionMethod,
  ConnectionStatus,
  ConnectSpec,
} from "@/lib/types";

/** Status dot tone and label for a connection status. */
export const CONNECTION_TONE: Record<ConnectionStatus, { tone: "good" | "warn" | "bad" | "brand" | "neutral"; label: string }> = {
  connected: { tone: "good", label: "Connected" },
  expiring: { tone: "warn", label: "Session ending soon" },
  pending: { tone: "brand", label: "Waiting for login" },
  expired: { tone: "bad", label: "Session ended" },
  error: { tone: "bad", label: "Error" },
  disconnected: { tone: "neutral", label: "Disconnected" },
};

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { individual: "Individual", ira: "IRA", roth: "Roth IRA", margin: "Margin", paper: "Paper" };

/** Statuses whose session answers reads. */
export function isLiveStatus(status: ConnectionStatus | undefined): boolean {
  return status === "connected" || status === "expiring";
}

/**
 * How a connection's environment is called, from the broker's connect specs (src/lib/broker-connect):
 * "Live" or "Paper" for most brokers, "Production" for E*TRADE, and "Sandbox · sample data" for a
 * sample-data environment wherever it appears.
 */
export function environmentLabel(brokerId: BrokerId, environment: ConnectionEnvironment, method?: ConnectionMethod): string {
  return registryEnvironmentLabel(brokerId, environment, method);
}

/** "IBKR Paper", "E*TRADE Production", "Alpaca Live". */
export function connectionName(c: Pick<BrokerConnection, "brokerId" | "environment"> & { method?: ConnectionMethod }): string {
  return `${getBroker(c.brokerId).short} ${environmentLabel(c.brokerId, c.environment, c.method)}`;
}

/**
 * The spec a connection was made with. Most methods have one spec. Schwab and TradeStation have two
 * under one method (the user's own app and Nasscord's client), and a connection does not say which
 * client it used, so the service's options decide: Nasscord's client can only have made it once its
 * credentials are configured, and the user's own app only while that way is open to this user.
 * Undefined when the options are unknown or both are possible; callers then use neutral copy.
 */
export function connectionSpec(c: Pick<BrokerConnection, "brokerId" | "method">, options: BrokerOptions | null | undefined): ConnectSpec | undefined {
  const specs = connectSpecs(c.brokerId).filter((s) => s.method === c.method);
  if (specs.length <= 1) return specs[0];
  if (!options) return undefined;
  const user = specs.find((s) => s.client === "user");
  const platform = specs.find((s) => s.client === "platform");
  const platformOption = platform ? optionFor(options, c.brokerId, platform) : undefined;
  const platformPossible = !!platformOption?.built && !!platformOption.configured;
  const userPossible = !!user && !!optionFor(options, c.brokerId, user)?.available;
  if (user && !platformPossible) return user;
  if (platform && platformPossible && !userPossible) return platform;
  return undefined;
}

/**
 * The flow a connection was made with (null for a method without a spec, such as the reserved
 * ibkr_oauth). Without `options`, a method with two OAuth clients answers its first spec's flow,
 * which is still an OAuth flow, so session lines and key checks read the same either way.
 */
export function connectionFlow(c: Pick<BrokerConnection, "brokerId" | "method">, options?: BrokerOptions | null): ConnectFlow | null {
  return (connectionSpec(c, options) ?? findSpec(c.brokerId, c.method))?.flow ?? null;
}

/** The connection reads through SnapTrade, so its data is as fresh as SnapTrade's last sync. */
export function isAggregated(c: Pick<BrokerConnection, "method">): boolean {
  return c.method === "snaptrade";
}

function left(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/**
 * One line on the session. Pass the minute clock (useMinuteClock), never a clock read during render.
 * - SnapTrade: "via SnapTrade · updated 8 min ago" from the aggregator's last sync.
 * - OAuth logins with a fixed end (Schwab's 7 days, Webull's refresh period, a rotating
 *   TradeStation key, Tradier without refresh tokens): "Reconnect by <date>", with the time left
 *   once the warn window starts.
 * - IBKR and E*TRADE: "Session ends <date>, in 5 h".
 * Otherwise when the broker last answered. Null when nothing is known.
 */
export function sessionLine(c: BrokerConnection, now: Date): string | null {
  const ends = c.sessionExpiresAt ? new Date(c.sessionExpiresAt) : null;
  if (c.status === "pending") return ends ? `Waiting for the login until ${fmtTimeET(ends.toISOString())}` : null;
  const live = isLiveStatus(c.status);
  if (live && isAggregated(c)) {
    return c.dataAsOf ? `via SnapTrade · updated ${timeAgo(c.dataAsOf, now)}` : "via SnapTrade · not synced yet";
  }
  if (live && ends) {
    const ms = ends.getTime() - now.getTime();
    const when = fmtDateTime(ends.toISOString());
    const flow = connectionFlow(c);
    if (flow === "oauth2_user_app" || flow === "oauth2_platform") {
      if (ms <= 0) return `Login ended ${when}`;
      return c.status === "expiring" ? `Reconnect by ${when}, in ${left(ms)}` : `Reconnect by ${when}`;
    }
    return ms > 0 ? `Session ends ${when}, in ${left(ms)}` : `Session ended ${when}`;
  }
  if (isAggregated(c) && c.dataAsOf) return `via SnapTrade · last updated ${timeAgo(c.dataAsOf, now)}`;
  if (c.lastOkAt) return `Last answered ${timeAgo(c.lastOkAt, now)}`;
  return null;
}
