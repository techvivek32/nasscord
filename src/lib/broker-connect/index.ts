import type {
  BrokerId,
  BrokerOptions,
  ConnectClient,
  ConnectFlow,
  ConnectionEnvironment,
  ConnectionMethod,
  ConnectOption,
  ConnectSpec,
} from "@/lib/types";
import { ALPACA_CONNECT } from "@/lib/broker-connect/alpaca";
import { ETRADE_CONNECT } from "@/lib/broker-connect/etrade";
import { FIDELITY_CONNECT } from "@/lib/broker-connect/fidelity";
import { IBKR_CONNECT } from "@/lib/broker-connect/ibkr";
import { MOOMOO_CONNECT } from "@/lib/broker-connect/moomoo";
import { PUBLIC_CONNECT } from "@/lib/broker-connect/public";
import { ROBINHOOD_CONNECT } from "@/lib/broker-connect/robinhood";
import { SCHWAB_CONNECT } from "@/lib/broker-connect/schwab";
import { SANDBOX_LABEL } from "@/lib/broker-connect/shared";
import { TASTYTRADE_CONNECT } from "@/lib/broker-connect/tastytrade";
import { TRADESTATION_CONNECT } from "@/lib/broker-connect/tradestation";
import { TRADIER_CONNECT } from "@/lib/broker-connect/tradier";
import { WEBULL_CONNECT } from "@/lib/broker-connect/webull";

/*
 * How each broker connects (docs/real-backend.md, "Connect flows"). One file per broker holds its
 * specs: the steps, fields, disclosures and session notes the connect UI shows. Whether a way is
 * open to the signed-in user right now is the broker service's answer (GET /api/broker/options,
 * BrokerOptions); the helpers below join the two. Pure data: safe for client and server code.
 */

export { SANDBOX_LABEL } from "@/lib/broker-connect/shared";

/** Every broker's ways of connecting, the preferred one first. */
export const CONNECT_SPECS: Readonly<Record<BrokerId, ConnectSpec[]>> = {
  ibkr: IBKR_CONNECT,
  etrade: ETRADE_CONNECT,
  alpaca: ALPACA_CONNECT,
  tradier: TRADIER_CONNECT,
  schwab: SCHWAB_CONNECT,
  tastytrade: TASTYTRADE_CONNECT,
  tradestation: TRADESTATION_CONNECT,
  webull: WEBULL_CONNECT,
  fidelity: FIDELITY_CONNECT,
  robinhood: ROBINHOOD_CONNECT,
  public: PUBLIC_CONNECT,
  moomoo: MOOMOO_CONNECT,
};

/** The broker ids each method serves (the migration's method/broker pairs). */
export const METHOD_BROKERS: Readonly<Record<ConnectionMethod, readonly BrokerId[]>> = {
  ibkr_gateway: ["ibkr"],
  ibkr_oauth: ["ibkr"],
  etrade_oauth1: ["etrade"],
  alpaca_key: ["alpaca"],
  alpaca_oauth: ["alpaca"],
  tradier_token: ["tradier"],
  tradier_oauth: ["tradier"],
  schwab_oauth: ["schwab"],
  tastytrade_oauth: ["tastytrade"],
  tradestation_oauth: ["tradestation"],
  webull_oauth: ["webull"],
  snaptrade: ["fidelity", "robinhood", "public", "moomoo", "webull", "schwab", "tastytrade"],
};

/** A method in a sentence (console tables, audit views). */
export const METHOD_LABEL: Readonly<Record<ConnectionMethod, string>> = {
  ibkr_gateway: "IBKR Client Portal Gateway",
  ibkr_oauth: "IBKR OAuth",
  etrade_oauth1: "E*TRADE OAuth 1.0a",
  alpaca_key: "Alpaca API key",
  alpaca_oauth: "Alpaca Connect (OAuth)",
  tradier_token: "Tradier personal token",
  tradier_oauth: "Tradier OAuth",
  schwab_oauth: "Schwab Trader API (OAuth)",
  tastytrade_oauth: "tastytrade OAuth",
  tradestation_oauth: "TradeStation OAuth",
  webull_oauth: "Webull Connect (OAuth)",
  snaptrade: "SnapTrade",
};

/** A flow in a few words. */
export const FLOW_LABEL: Readonly<Record<ConnectFlow, string>> = {
  gateway_login: "Log in on the broker's page",
  oauth1_verifier: "Your developer key and a verification code",
  api_key: "Your API key",
  oauth2_user_app: "Your own developer app",
  oauth2_platform: "Sign in with the broker",
  aggregator_portal: "Through SnapTrade",
};

/** A broker's ways of connecting. */
export function connectSpecs(brokerId: BrokerId): ConnectSpec[] {
  return CONNECT_SPECS[brokerId] ?? [];
}

/** The spec of one way of connecting a broker (`client` picks the user's own app or Nasscord's). */
export function findSpec(brokerId: BrokerId, method: ConnectionMethod, client?: ConnectClient | null): ConnectSpec | undefined {
  const specs = connectSpecs(brokerId).filter((s) => s.method === method);
  if (client === undefined) return specs[0];
  return specs.find((s) => (s.client ?? null) === client) ?? specs[0];
}

/**
 * How an environment is called for a broker: the spec's own label ("Live", "Production" for
 * E*TRADE, "Paper"), and always "Sandbox · sample data" for a sample-data environment.
 */
export function environmentLabel(brokerId: BrokerId, environment: ConnectionEnvironment, method?: ConnectionMethod): string {
  if (environment === "sandbox") return SANDBOX_LABEL;
  const specs = connectSpecs(brokerId).filter((s) => !method || s.method === method);
  const own = specs.flatMap((s) => s.environments).find((e) => e.value === environment);
  if (own) return own.label;
  return environment === "paper" ? "Paper" : "Live";
}

/** Hours before a session ends that the connection shows "Session ending soon" (2, or 48 for Schwab). */
export function reconnectWarnHours(brokerId: BrokerId, method?: ConnectionMethod): number {
  const hours = connectSpecs(brokerId)
    .filter((s) => !method || s.method === method)
    .map((s) => s.reconnectWarnHours ?? 2);
  return hours.length ? Math.max(...hours) : 2;
}

/** The broker service's answer for one spec, if it sent one. */
export function optionFor(options: BrokerOptions | null | undefined, brokerId: BrokerId, spec: ConnectSpec): ConnectOption | undefined {
  return options?.options.find((o) => o.brokerId === brokerId && o.method === spec.method && o.client === (spec.client ?? null));
}

/** One way of connecting a broker, joined with the service's answer for the signed-in user. */
export interface ConnectChoice {
  spec: ConnectSpec;
  option?: ConnectOption;
  available: boolean;
  /** Environments to offer: the service's list in the spec's order and words. */
  environments: ConnectSpec["environments"];
  /** Why it is not available: the service's sentence for the platform owner's setup problems, else the spec's. */
  reason: string | null;
}

/**
 * A broker's ways of connecting for the signed-in user, available ones first. Without options
 * (the service could not be asked) nothing is available.
 */
export function connectChoices(brokerId: BrokerId, options: BrokerOptions | null | undefined): ConnectChoice[] {
  const choices = connectSpecs(brokerId).map((spec): ConnectChoice => {
    const option = optionFor(options, brokerId, spec);
    const available = !!option?.available;
    const environments = option ? spec.environments.filter((e) => option.environments.includes(e.value)) : [];
    let reason: string | null = null;
    if (!available) reason = option?.reasonCode === "not_configured" && option.reason ? option.reason : spec.unavailableReason;
    return { spec, option, available: available && environments.length > 0, environments, reason };
  });
  return [...choices.filter((c) => c.available), ...choices.filter((c) => !c.available)];
}

/** Brokers with at least one way the signed-in user can connect now. */
export function connectableNow(options: BrokerOptions | null | undefined): BrokerId[] {
  return (Object.keys(CONNECT_SPECS) as BrokerId[]).filter((id) => connectChoices(id, options).some((c) => c.available));
}
