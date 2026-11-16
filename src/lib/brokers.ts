import type { Broker, BrokerId, BrokerStatus } from "@/lib/types";
import { CONNECT_SPECS } from "@/lib/broker-connect";

/*
 * The single broker registry. Every page renders brokers from here.
 *
 * This release is read-only. The public pages say what connects from the broker service's own
 * answer (/v1/options, through src/lib/server/broker-availability.ts). `status` here is only their
 * fallback while the service cannot be asked: IBKR and E*TRADE, which every deployed service
 * connects; every other broker, Alpaca included, shows "soon" there, so the fallback never offers a
 * broker that a service still being deployed may not have built. What the signed-in user can
 * connect right now is the broker service's answer (GET /api/broker/options), joined with `connect`
 * (the specs in src/lib/broker-connect) by connectChoices(). `capabilities` says what Nasscord can do through the
 * connection today: order entry is switched off in this release, so `trading` (and with it options
 * and extended-hours orders) is false for every broker. `paper` is true where the user's own paper
 * account connects (IBKR Paper, Alpaca Paper).
 */
const BASE: Array<Omit<Broker, "connect">> = [
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
    id: "alpaca",
    site: "app.alpaca.markets",
    name: "Alpaca",
    short: "Alpaca",
    monogram: "AL",
    color: "#B58900",
    status: "soon",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: true },
    blurb:
      "Not available yet. Alpaca will connect with an API key of your own Alpaca account: Live, or one of your paper accounts, read-only.",
  },
  {
    id: "schwab",
    site: "www.schwab.com",
    name: "Charles Schwab",
    short: "Schwab",
    monogram: "CS",
    color: "#0A6ED1",
    status: "soon",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb:
      "Not available yet. Schwab will connect read-only through SnapTrade, or with a sign-in on Schwab's own page once Schwab approves Nasscord's app. Schwab asks for a new login every 7 days.",
  },
  {
    id: "tastytrade",
    site: "tastytrade.com",
    name: "tastytrade",
    short: "tastytrade",
    monogram: "TT",
    color: "#E4572E",
    status: "soon",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. tastytrade will connect with a sign-in on tastytrade's own page once tastytrade verifies Nasscord as a third party.",
  },
  {
    id: "tradier",
    site: "tradier.com",
    name: "Tradier",
    short: "Tradier",
    monogram: "TR",
    color: "#1F7A5C",
    status: "soon",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. Tradier will connect with a sign-in on Tradier's own page once Tradier accepts Nasscord as a partner.",
  },
  {
    id: "tradestation",
    site: "www.tradestation.com",
    name: "TradeStation",
    short: "TradeStation",
    monogram: "TS",
    color: "#0B4F9C",
    status: "soon",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. TradeStation will connect with your own TradeStation API key once TradeStation agrees to it.",
  },
  {
    id: "webull",
    site: "www.webull.com",
    name: "Webull",
    short: "Webull",
    monogram: "WB",
    color: "#F26B1D",
    status: "soon",
    mode: "direct",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. Webull will connect read-only through SnapTrade, and later with a sign-in on Webull's own page once Webull approves Nasscord.",
  },
  {
    id: "fidelity",
    site: "www.fidelity.com",
    name: "Fidelity",
    short: "Fidelity",
    monogram: "FI",
    color: "#3F7D3A",
    status: "soon",
    mode: "aggregator",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. Fidelity publishes no API for platforms; Nasscord will read it through SnapTrade, with your login on Fidelity's own page.",
  },
  {
    id: "robinhood",
    site: "robinhood.com",
    name: "Robinhood",
    short: "Robinhood",
    monogram: "RH",
    color: "#159A3A",
    status: "soon",
    mode: "aggregator",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. Robinhood will connect read-only through SnapTrade, with your login on Robinhood's own page.",
  },
  {
    id: "moomoo",
    site: "www.moomoo.com",
    name: "Moomoo",
    short: "Moomoo",
    monogram: "MM",
    color: "#E8590C",
    status: "soon",
    mode: "aggregator",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. Moomoo will connect read-only through SnapTrade, with your login on Moomoo's own page.",
  },
  {
    id: "public",
    site: "public.com",
    name: "Public",
    short: "Public",
    monogram: "PB",
    color: "#2B2D42",
    status: "soon",
    mode: "aggregator",
    capabilities: { trading: false, options: false, extendedHours: false, paper: false },
    blurb: "Not available yet. Public will connect read-only through SnapTrade, with your login on Public's own page.",
  },
];

export const BROKERS: Broker[] = BASE.map((b) => ({ ...b, connect: CONNECT_SPECS[b.id] }));

const BY_ID = new Map(BROKERS.map((b) => [b.id, b] as const));

export function getBroker(id: BrokerId): Broker {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`Unknown broker: ${id}`);
  return b;
}

/**
 * Badge labels and one-line meanings. "beta" and "sync" stay defined because BrokerStatus names them
 * (a broker that connects through SnapTrade for everyone becomes "sync").
 */
export const BROKER_STATUS: Record<BrokerStatus, { label: string; description: string }> = {
  live: { label: "Connect today", description: "Connects today, read-only: accounts, balances, positions, orders and executions." },
  beta: { label: "Beta", description: "Connects with limits that the broker's page states." },
  sync: { label: "Read-only sync", description: "Read only through SnapTrade. Balances and positions refresh on SnapTrade's schedule, not live." },
  soon: { label: "Not available yet", description: "Listed, but Nasscord cannot connect to it in this release." },
};

/** The fallback's brokers that connect for everyone (status live, beta or sync); the public pages use publicBrokers(). */
export const RELEASED_BROKERS = BROKERS.filter((b) => b.status !== "soon");
export const RELEASED_BROKER_IDS: BrokerId[] = RELEASED_BROKERS.map((b) => b.id);
