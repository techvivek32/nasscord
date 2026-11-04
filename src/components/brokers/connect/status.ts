import { getBroker } from "@/lib/brokers";
import { fmtDateTime, fmtTimeET, timeAgo } from "@/lib/format";
import type { AccountType, BrokerConnection, BrokerId, ConnectionEnvironment, ConnectionStatus } from "@/lib/types";

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

/** IBKR calls its environments Live and Paper; E*TRADE calls them Production and Sandbox. */
export function environmentLabel(brokerId: BrokerId, environment: ConnectionEnvironment): string {
  if (environment === "paper") return "Paper";
  if (environment === "sandbox") return "Sandbox";
  return brokerId === "ibkr" ? "Live" : "Production";
}

/** "IBKR Paper", "E*TRADE Production". */
export function connectionName(c: Pick<BrokerConnection, "brokerId" | "environment">): string {
  return `${getBroker(c.brokerId).short} ${environmentLabel(c.brokerId, c.environment)}`;
}

function left(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** One line on the session: when it ends, or when the broker last answered. Null when nothing is known. */
export function sessionLine(c: BrokerConnection, now: Date): string | null {
  const ends = c.sessionExpiresAt ? new Date(c.sessionExpiresAt) : null;
  if (c.status === "pending") return ends ? `Waiting for the login until ${fmtTimeET(ends.toISOString())}` : null;
  if ((c.status === "connected" || c.status === "expiring") && ends) {
    const ms = ends.getTime() - now.getTime();
    return ms > 0 ? `Session ends ${fmtDateTime(ends.toISOString())}, in ${left(ms)}` : `Session ended ${fmtDateTime(ends.toISOString())}`;
  }
  if (c.lastOkAt) return `Last answered ${timeAgo(c.lastOkAt, now)}`;
  return null;
}
