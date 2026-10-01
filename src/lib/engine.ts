import type { BacktestStats, EngineParams } from "@/lib/types";

/** TradeScope constants, measured from the production engine (Sept 2026). */
export const ENGINE_DEFAULTS: EngineParams = {
  universeSize: 44,
  timeframe: "15m",
  minScore: 70,
  maxOpen: 5,
  atrStopMultiple: 2.2,
  rewardToRisk: 0.72,
  trailToBreakeven: true,
  newsModelMarketHoursOnly: true,
};

export const UNIVERSE: string[] = [
  "AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "AMD", "NFLX", "AVGO",
  "JPM", "BAC", "WFC", "GS", "V", "MA", "COIN", "MU", "PLTR", "SMCI", "UBER", "DIS",
  "BA", "CAT", "XOM", "CVX", "WMT", "COST", "HD", "NKE", "PYPL", "CRM", "ORCL", "ADBE",
  "INTC", "QCOM", "MRVL", "ARM", "CRWD", "PANW", "ABNB", "LLY", "UNH", "F",
];

export const INDEX_ETFS = ["SPY", "QQQ", "DIA", "IWM"];
export const INVERSE_ETFS = ["SH", "PSQ", "DOG", "SQQQ", "SPXU", "SDOW"];

export const BACKTEST: BacktestStats = {
  riskPerTrade: 0.5,
  symbols: 44,
  trades: 59,
  wins: 23,
  losses: 19,
  scratches: 17,
  winRate: 54.8,
  avgWinR: 0.72,
  avgLossR: 1,
  profitFactor: 0.87,
  expectancyR: -0.035,
  totalReturnPct: -1.1,
  maxDrawdownPct: 2.2,
  maxConsecLosses: 2,
};

export const LIFETIME_RECORD = { wins: 41, losses: 39, scratches: 3 };

/** stop = entry - 2.2 x ATR · target = entry + 0.72 x (entry - stop) */
export function computeLevels(entry: number, atr: number, params: EngineParams = ENGINE_DEFAULTS) {
  const stop = round2(entry - params.atrStopMultiple * atr);
  const risk = entry - stop;
  const target = round2(entry + params.rewardToRisk * risk);
  return {
    entry: round2(entry),
    stop,
    target,
    risk: round2(risk),
    riskReward: params.rewardToRisk,
    stopPct: round2((risk / entry) * 100),
    targetPct: round2(((target - entry) / entry) * 100),
  };
}

/** Quantity so a stop-out costs riskPct of net liquidation, capped at 95% affordability. */
export function sizeByRisk(netLiq: number, riskPct: number, entry: number, stop: number) {
  const perShare = Math.abs(entry - stop);
  if (perShare <= 0 || entry <= 0) return { qty: 0, riskDollars: 0, notional: 0, cappedByCash: false };
  const riskDollars = netLiq * (riskPct / 100);
  const byRisk = Math.floor(riskDollars / perShare);
  const byCash = Math.floor((netLiq * 0.95) / entry);
  const qty = Math.max(0, Math.min(byRisk, byCash));
  return {
    qty,
    riskDollars: round2(qty * perShare),
    notional: round2(qty * entry),
    cappedByCash: byCash < byRisk,
  };
}

/** Options: contracts from a fixed capital-risk preset (0.10 / 0.15 / 0.20 % of net liq). */
export function sizeOptionByCapitalRisk(netLiq: number, riskPct: number, premium: number, stopPremium: number, multiplier = 100) {
  const perContract = Math.max(0, premium - stopPremium) * multiplier;
  if (perContract <= 0) return { contracts: 0, riskDollars: 0, notional: 0 };
  const budget = netLiq * (riskPct / 100);
  const contracts = Math.floor(budget / perContract);
  return { contracts, riskDollars: round2(contracts * perContract), notional: round2(contracts * premium * multiplier) };
}

/** Weekday 04:00–09:30 or 16:00–20:00 ET counts as extended hours. */
export function marketSession(now: Date = new Date()): "pre" | "regular" | "post" | "closed" {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return "closed";
  const minutes = et.getHours() * 60 + et.getMinutes();
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "closed";
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}
