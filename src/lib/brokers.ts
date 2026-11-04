import type { Broker, BrokerId, BrokerStatus } from "@/lib/types";

/*
 * The single broker registry. Every page renders brokers from here.
 *
 * This release is read-only and connects two brokers: Interactive Brokers (a dedicated Client Portal
 * gateway per connection, login on IBKR's own page) and E*TRADE (OAuth 1.0a with the user's own
 * developer key). Every other broker is listed as "soon" so traders can see what is planned; none of
 * them connect. `capabilities` says what Nasscord can do through the connection today: order entry is
 * switched off in this release, so `trading` (and with it options and extended-hours orders) is false
 * for every broker. `paper` is true where a paper login connects (IBKR Paper).
 */
export const BROKERS: Broker[] = [
  {
    id: "ibkr",
    site: "www.interactivebrokers.com",
    name: "Interactive Brokers",
    short: "IBKR",
    monogram: "IB",
    color: "#C8102E",
    status: "live",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: true },
    blurb:
      "You log in on IBKR's own page, through a gateway session Nasscord runs for your connection alone. Live or paper. Read-only in this release: accounts, balances, positions, orders and executions.",
  },
  {
    id: "etrade",
    site: "us.etrade.com",
    name: "E*TRADE",
    short: "E*TRADE",
    monogram: "ET",
    color: "#5D2E8C",
    status: "live",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb:
      "You connect with your own E*TRADE developer key and approve Nasscord on E*TRADE's page. Read-only in this release. E*TRADE ends every session at midnight Eastern, so you reconnect once a day.",
  },
  {
    id: "schwab",
    site: "www.schwab.com",
    name: "Charles Schwab",
    short: "Schwab",
    monogram: "CS",
    color: "#0A6ED1",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Schwab publishes a Trader API with OAuth.",
  },
  {
    id: "tastytrade",
    site: "tastytrade.com",
    name: "tastytrade",
    short: "tastytrade",
    monogram: "TT",
    color: "#E4572E",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. tastytrade publishes an open API.",
  },
  {
    id: "tradier",
    site: "tradier.com",
    name: "Tradier",
    short: "Tradier",
    monogram: "TR",
    color: "#1F7A5C",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Tradier publishes a brokerage API built for platforms.",
  },
  {
    id: "alpaca",
    site: "app.alpaca.markets",
    name: "Alpaca",
    short: "Alpaca",
    monogram: "AL",
    color: "#B58900",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Alpaca is an API-first broker.",
  },
  {
    id: "tradestation",
    site: "www.tradestation.com",
    name: "TradeStation",
    short: "TradeStation",
    monogram: "TS",
    color: "#0B4F9C",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. TradeStation publishes a WebAPI with OAuth.",
  },
  {
    id: "webull",
    site: "www.webull.com",
    name: "Webull",
    short: "Webull",
    monogram: "WB",
    color: "#F26B1D",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Webull publishes an OpenAPI.",
  },
  {
    id: "fidelity",
    site: "www.fidelity.com",
    name: "Fidelity",
    short: "Fidelity",
    monogram: "FI",
    color: "#3F7D3A",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Fidelity publishes no public trading API.",
  },
  {
    id: "robinhood",
    site: "robinhood.com",
    name: "Robinhood",
    short: "Robinhood",
    monogram: "RH",
    color: "#159A3A",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Robinhood publishes no public API for stock accounts.",
  },
  {
    id: "moomoo",
    site: "www.moomoo.com",
    name: "Moomoo",
    short: "Moomoo",
    monogram: "MM",
    color: "#E8590C",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet. Moomoo publishes an OpenAPI.",
  },
  {
    id: "public",
    site: "public.com",
    name: "Public",
    short: "Public",
    monogram: "PB",
    color: "#2B2D42",
    status: "soon",
    mode: "planned",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not connectable yet.",
  },
];

const BY_ID = new Map(BROKERS.map((b) => [b.id, b] as const));

export function getBroker(id: BrokerId): Broker {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`Unknown broker: ${id}`);
  return b;
}

/**
 * Badge labels and one-line meanings. Only "live" and "soon" are in use in this release; "beta" and
 * "sync" stay defined because BrokerStatus still names them.
 */
export const BROKER_STATUS: Record<BrokerStatus, { label: string; description: string }> = {
  live: { label: "Connect today", description: "Connects today, read-only: accounts, balances, positions, orders and executions." },
  beta: { label: "Beta", description: "Connects with limits that the broker's page states." },
  sync: { label: "Read-only sync", description: "Positions and balances only, read-only." },
  soon: { label: "Not available yet", description: "Listed, but Nasscord cannot connect to it in this release." },
};

/** The statuses that brokers in the registry actually have, in display order. */
export const BROKER_STATUS_ORDER: BrokerStatus[] = (["live", "beta", "sync", "soon"] as const).filter((s) => BROKERS.some((b) => b.status === s));

/**
 * Brokers a user can connect today (read-only release): the broker service supports these two.
 * Every other broker shows "Not available yet" in the connect flows (docs/real-backend.md section 9).
 */
export const CONNECTABLE_BROKER_IDS = ["ibkr", "etrade"] as const satisfies ReadonlyArray<BrokerId>;
export type ConnectableBrokerId = (typeof CONNECTABLE_BROKER_IDS)[number];
export function isConnectable(id: BrokerId): id is ConnectableBrokerId {
  return (CONNECTABLE_BROKER_IDS as ReadonlyArray<BrokerId>).includes(id);
}
export const CONNECTABLE_BROKERS = BROKERS.filter((b) => isConnectable(b.id));

/** Brokers by status. No broker places orders in this release; TRADING_BROKERS keeps its name for older imports. */
export const TRADING_BROKERS = BROKERS.filter((b) => b.status === "live" || b.status === "beta");
export const SYNC_BROKERS = BROKERS.filter((b) => b.status === "sync");
export const PLANNED_BROKERS = BROKERS.filter((b) => b.status === "soon");
