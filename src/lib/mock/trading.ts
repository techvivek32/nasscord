import { computeLevels } from "@/lib/engine";
import type { Alert, BrokerConnection, Execution, Order, Position, Ticker } from "@/lib/types";

/* All timestamps are relative to the demo "now": 2026-09-30 14:52 ET (DEMO_NOW in lib/demo-clock). */

export const CONNECTIONS: BrokerConnection[] = [
  {
    brokerId: "ibkr",
    status: "connected",
    connectedAt: "2026-09-30T12:05:00Z",
    sessionExpiresAt: "2026-10-01T12:05:00Z",
    permissions: ["read", "trade", "options"],
    note: "Dedicated gateway session. Renews daily with your IBKR login and second factor.",
    accounts: [
      { id: "acc_ibkr_1", brokerId: "ibkr", label: "Individual", masked: "U12•••45", type: "margin", netLiq: 58_930.4, buyingPower: 41_200, cash: 12_410.2, dayPnl: 412.6, included: true },
    ],
  },
  {
    brokerId: "schwab",
    status: "connected",
    connectedAt: "2026-08-02T15:40:00Z",
    tokenRenewsAt: "2026-09-30T19:33:00Z",
    permissions: ["read", "trade", "options"],
    accounts: [
      { id: "acc_schwab_1", brokerId: "schwab", label: "Individual", masked: "••••8821", type: "individual", netLiq: 84_210.55, buyingPower: 39_800, cash: 22_106.8, dayPnl: 786.4, included: true },
      { id: "acc_schwab_2", brokerId: "schwab", label: "Roth IRA", masked: "••••1190", type: "roth", netLiq: 31_006.12, buyingPower: 8_110, cash: 8_110, dayPnl: 61.2, included: true },
    ],
  },
  {
    brokerId: "alpaca",
    status: "connected",
    connectedAt: "2026-09-10T13:00:00Z",
    permissions: ["read", "trade"],
    note: "Paper account. Orders route to Alpaca's simulated book.",
    accounts: [
      { id: "acc_alpaca_1", brokerId: "alpaca", label: "Paper", masked: "PA3•••7K", type: "paper", netLiq: 9_500, buyingPower: 3_000, cash: 3_839, dayPnl: 24, included: true },
    ],
  },
];

export const ACCOUNTS = CONNECTIONS.flatMap((c) => c.accounts);
export const NET_LIQ = ACCOUNTS.reduce((s, a) => s + a.netLiq, 0);
export const BUYING_POWER = ACCOUNTS.reduce((s, a) => s + a.buyingPower, 0);
export const DAY_PNL = ACCOUNTS.reduce((s, a) => s + a.dayPnl, 0);

function spark(seed: number, n = 24, drift = 0.15) {
  const out: number[] = [];
  let v = 100;
  for (let i = 0; i < n; i++) {
    const r = Math.sin(seed * 7.13 + i * 1.37) * 0.6 + Math.cos(seed * 3.7 + i * 0.61) * 0.4;
    v = v + r + drift;
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

function openAlert(a: {
  id: number; symbol: string; company: string; score: number; reasons: string[];
  rsi: number; adx: number; relVol: number; entry: number; atr: number; openedAt: string; ticks: number; last: number;
  news?: Alert["news"];
}): Alert {
  const lv = computeLevels(a.entry, a.atr);
  return {
    id: a.id, symbol: a.symbol, company: a.company, timeframe: "15m", score: a.score, reasons: a.reasons,
    rsi: a.rsi, adx: a.adx, relVol: a.relVol, atr: a.atr, atrPct: Math.round((a.atr / a.entry) * 10000) / 100,
    entry: lv.entry, stop: lv.stop, stop0: lv.stop, target: lv.target, riskReward: lv.riskReward,
    status: "open", movedBE: false, ticks: a.ticks, openedAt: a.openedAt, news: a.news, spark: spark(a.id), last: a.last,
  };
}

function closedAlert(a: {
  id: number; symbol: string; company: string; score: number; reasons: string[]; rsi: number; adx: number; relVol: number;
  entry: number; atr: number; openedAt: string; closedAt: string; status: "target" | "stop"; ticks: number;
}): Alert {
  const lv = computeLevels(a.entry, a.atr);
  const closePrice = a.status === "target" ? lv.target : lv.entry; // stop trailed to breakeven before the exit
  const resultPct = Math.round(((closePrice - lv.entry) / lv.entry) * 10000) / 100;
  return {
    id: a.id, symbol: a.symbol, company: a.company, timeframe: "15m", score: a.score, reasons: a.reasons,
    rsi: a.rsi, adx: a.adx, relVol: a.relVol, atr: a.atr, atrPct: Math.round((a.atr / a.entry) * 10000) / 100,
    entry: lv.entry, stop: lv.entry, stop0: lv.stop, target: lv.target, riskReward: lv.riskReward,
    status: a.status, movedBE: true, ticks: a.ticks, openedAt: a.openedAt, closedAt: a.closedAt, closePrice, resultPct,
    spark: spark(a.id, 24, a.status === "target" ? 0.2 : -0.05), last: closePrice,
  };
}

export const OPEN_ALERTS: Alert[] = [
  openAlert({ id: 1187, symbol: "NVDA", company: "NVIDIA", score: 108, reasons: ["Strong uptrend (ADX 34)", "Momentum rising (RSI 63)", "Volume 1.8x average", "Breaking out"], rsi: 63.1, adx: 34.2, relVol: 1.8, entry: 121.4, atr: 1.26, openedAt: "2026-09-30T17:15:00Z", ticks: 26, last: 122.18, news: { sentiment: "bullish", headline: "NVIDIA expands Blackwell supply agreements with two hyperscalers", reason: "Supply expansion supports the breakout narrative.", source: "Yahoo" } }),
  openAlert({ id: 1186, symbol: "AVGO", company: "Broadcom", score: 100, reasons: ["Strong uptrend (ADX 31)", "Momentum rising (RSI 58)", "Volume 1.4x average"], rsi: 58.4, adx: 31.0, relVol: 1.4, entry: 172.8, atr: 2.15, openedAt: "2026-09-30T16:45:00Z", ticks: 38, last: 173.65, news: { sentiment: "neutral" } }),
  openAlert({ id: 1185, symbol: "JPM", company: "JPMorgan Chase", score: 92, reasons: ["Uptrend forming (ADX 24)", "Momentum rising (RSI 57)", "Fresh upward momentum"], rsi: 56.9, adx: 24.3, relVol: 1.1, entry: 224.15, atr: 1.55, openedAt: "2026-09-30T15:30:00Z", ticks: 66, last: 224.02, news: { sentiment: "neutral" } }),
  openAlert({ id: 1184, symbol: "CRWD", company: "CrowdStrike", score: 86, reasons: ["Strong uptrend (ADX 29)", "Volume 1.6x average", "Breaking out"], rsi: 61.2, adx: 29.4, relVol: 1.6, entry: 286.4, atr: 3.9, openedAt: "2026-09-30T14:15:00Z", ticks: 112, last: 289.1, news: { sentiment: "bullish", headline: "CrowdStrike lands federal Falcon expansion", source: "Yahoo" } }),
  openAlert({ id: 1183, symbol: "LLY", company: "Eli Lilly", score: 79, reasons: ["Uptrend forming (ADX 22)", "Momentum rising (RSI 54)"], rsi: 54.0, adx: 22.1, relVol: 1.0, entry: 902.1, atr: 8.4, openedAt: "2026-09-30T13:45:00Z", ticks: 140, last: 899.6, news: { sentiment: "neutral" } }),
];

export const CLOSED_ALERTS: Alert[] = [
  closedAlert({ id: 1182, symbol: "MSFT", company: "Microsoft", score: 94, reasons: ["Strong uptrend (ADX 30)", "Momentum rising (RSI 60)"], rsi: 60.2, adx: 30.1, relVol: 1.3, entry: 428.6, atr: 3.1, openedAt: "2026-09-29T15:00:00Z", closedAt: "2026-09-29T19:30:00Z", status: "target", ticks: 210 }),
  closedAlert({ id: 1181, symbol: "AMD", company: "Advanced Micro Devices", score: 81, reasons: ["Uptrend forming (ADX 23)", "Volume 1.5x average"], rsi: 55.8, adx: 23.4, relVol: 1.5, entry: 164.2, atr: 2.4, openedAt: "2026-09-29T14:15:00Z", closedAt: "2026-09-29T18:00:00Z", status: "stop", ticks: 180 }),
  closedAlert({ id: 1180, symbol: "META", company: "Meta Platforms", score: 103, reasons: ["Strong uptrend (ADX 36)", "Momentum rising (RSI 64)", "Breaking out"], rsi: 64.1, adx: 36.0, relVol: 1.9, entry: 596.3, atr: 5.2, openedAt: "2026-09-26T14:45:00Z", closedAt: "2026-09-26T17:15:00Z", status: "target", ticks: 96 }),
  closedAlert({ id: 1179, symbol: "TSLA", company: "Tesla", score: 88, reasons: ["Strong uptrend (ADX 28)", "Volume 2.1x average"], rsi: 62.0, adx: 28.2, relVol: 2.1, entry: 262.9, atr: 4.6, openedAt: "2026-09-25T15:15:00Z", closedAt: "2026-09-25T19:45:00Z", status: "stop", ticks: 260 }),
  closedAlert({ id: 1178, symbol: "COST", company: "Costco", score: 77, reasons: ["Uptrend forming (ADX 21)", "Momentum rising (RSI 53)"], rsi: 53.2, adx: 21.4, relVol: 1.0, entry: 912.4, atr: 6.9, openedAt: "2026-09-24T14:30:00Z", closedAt: "2026-09-24T18:30:00Z", status: "target", ticks: 220 }),
  closedAlert({ id: 1177, symbol: "V", company: "Visa", score: 84, reasons: ["Strong uptrend (ADX 27)", "Fresh upward momentum"], rsi: 57.5, adx: 27.3, relVol: 1.2, entry: 289.7, atr: 2.2, openedAt: "2026-09-23T15:45:00Z", closedAt: "2026-09-23T19:00:00Z", status: "target", ticks: 190 }),
];

export const ALERTS: Alert[] = [...OPEN_ALERTS, ...CLOSED_ALERTS];

export const POSITIONS: Position[] = [
  { id: "pos_1", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "NVDA", qty: 38, avgCost: 118.2, last: 122.18, dayPnl: 96.14, alertId: 1187 },
  { id: "pos_2", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "AVGO", qty: 12, avgCost: 168.9, last: 173.65, dayPnl: 41.4, alertId: 1186 },
  { id: "pos_3", accountId: "acc_schwab_2", brokerId: "schwab", symbol: "JPM", qty: 20, avgCost: 221.3, last: 224.02, dayPnl: 14.8, alertId: 1185 },
  { id: "pos_4", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "CRWD", qty: 8, avgCost: 279.5, last: 289.1, dayPnl: 62.4, alertId: 1184 },
  { id: "pos_5", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "AAPL", qty: 25, avgCost: 228.4, last: 231.06, dayPnl: 31.25 },
  { id: "pos_6", accountId: "acc_alpaca_1", brokerId: "alpaca", symbol: "SPY", qty: 10, avgCost: 566.1, last: 571.42, dayPnl: 21.6 },
];

export const ORDERS: Order[] = [
  { id: "ord_4471", clientId: "nova-1790794500-4f2a", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "NVDA", side: "SELL", qty: 38, type: "LMT", price: 123.39, tif: "GTC", status: "working", placedAt: "2026-09-30T17:16:10Z", parentId: "ord_4470", brokerRef: "4471" },
  { id: "ord_4472", clientId: "nova-1790794500-4f2a", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "NVDA", side: "SELL", qty: 38, type: "STP", price: 118.63, tif: "GTC", status: "working", placedAt: "2026-09-30T17:16:10Z", parentId: "ord_4470", brokerRef: "4472" },
  { id: "ord_4470", clientId: "nova-1790794500-4f2a", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "NVDA", side: "BUY", qty: 38, type: "LMT", price: 121.4, tif: "DAY", status: "filled", placedAt: "2026-09-30T17:16:02Z", filledQty: 38, avgFill: 121.38, brokerRef: "4470" },
  { id: "ord_9912", clientId: "nova-1790791200-8c1d", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "AVGO", side: "BUY", qty: 12, type: "LMT", price: 172.8, tif: "DAY", status: "filled", placedAt: "2026-09-30T16:46:30Z", filledQty: 12, avgFill: 172.77, brokerRef: "1290034" },
  { id: "ord_9913", clientId: "nova-1790791200-8c1d", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "AVGO", side: "SELL", qty: 12, type: "TRAIL", trailPct: 2.5, tif: "GTC", status: "working", placedAt: "2026-09-30T16:46:31Z", parentId: "ord_9912", brokerRef: "1290035" },
  { id: "ord_3301", clientId: "nova-1790787000-1a9e", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "CRWD", side: "BUY", qty: 8, type: "LMT", price: 286.4, tif: "DAY", status: "filled", placedAt: "2026-09-30T14:16:00Z", filledQty: 8, avgFill: 286.35, brokerRef: "1289977" },
  { id: "ord_3302", clientId: "nova-1790787000-1a9e", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "CRWD", side: "SELL", qty: 8, type: "LMT", price: 289.9, tif: "GTC", status: "working", placedAt: "2026-09-30T14:16:01Z", parentId: "ord_3301", brokerRef: "1289978" },
  { id: "ord_2200", clientId: "nova-1790700000-77b2", accountId: "acc_alpaca_1", brokerId: "alpaca", symbol: "SPY", side: "BUY", qty: 10, type: "MKT", tif: "DAY", status: "filled", placedAt: "2026-09-29T14:31:00Z", filledQty: 10, avgFill: 566.1, brokerRef: "a1f3-22" },
  { id: "ord_2199", clientId: "nova-1790699000-3c3c", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "MSFT", side: "SELL", qty: 15, type: "LMT", price: 430.83, tif: "GTC", status: "filled", placedAt: "2026-09-29T15:01:00Z", filledQty: 15, avgFill: 430.83, brokerRef: "4402" },
  { id: "ord_2198", clientId: "nova-1790612000-9d9d", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "AMD", side: "SELL", qty: 30, type: "STP", price: 164.2, tif: "GTC", status: "cancelled", placedAt: "2026-09-29T14:20:00Z", brokerRef: "4388" },
];

export const EXECUTIONS: Execution[] = [
  { id: "ex_1", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "NVDA", side: "BUY", qty: 38, price: 121.38, commission: 0, net: -4612.44, tradedAt: "2026-09-30T17:16:04Z", provisional: true },
  { id: "ex_2", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "AVGO", side: "BUY", qty: 12, price: 172.77, commission: 1.0, net: -2074.24, tradedAt: "2026-09-30T16:46:33Z" },
  { id: "ex_3", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "CRWD", side: "BUY", qty: 8, price: 286.35, commission: 1.0, net: -2291.8, tradedAt: "2026-09-30T14:16:02Z" },
  { id: "ex_4", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "MSFT", side: "SELL", qty: 15, price: 430.83, commission: 0, net: 6462.45, tradedAt: "2026-09-29T19:28:00Z" },
  { id: "ex_5", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "MSFT", side: "BUY", qty: 15, price: 428.6, commission: 0, net: -6429.0, tradedAt: "2026-09-29T15:01:20Z" },
  { id: "ex_6", accountId: "acc_alpaca_1", brokerId: "alpaca", symbol: "SPY", side: "BUY", qty: 10, price: 566.1, commission: 0, net: -5661.0, tradedAt: "2026-09-29T14:31:02Z" },
  { id: "ex_7", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "AMD", side: "SELL", qty: 30, price: 164.22, commission: 0, net: 4926.6, tradedAt: "2026-09-29T18:02:00Z" },
  { id: "ex_8", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "AMD", side: "BUY", qty: 30, price: 164.2, commission: 0, net: -4926.0, tradedAt: "2026-09-29T14:16:00Z" },
  { id: "ex_9", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "META", side: "SELL", qty: 6, price: 600.62, commission: 1.0, net: 3602.72, tradedAt: "2026-09-26T17:14:00Z" },
  { id: "ex_10", accountId: "acc_ibkr_1", brokerId: "ibkr", symbol: "META", side: "BUY", qty: 6, price: 596.3, commission: 1.0, net: -3578.8, tradedAt: "2026-09-26T14:46:00Z" },
  { id: "ex_11", accountId: "acc_schwab_2", brokerId: "schwab", symbol: "JPM", side: "BUY", qty: 20, price: 221.3, commission: 0, net: -4426.0, tradedAt: "2026-09-25T15:32:00Z" },
  { id: "ex_12", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "TSLA", side: "SELL", qty: 12, price: 262.9, commission: 0, net: 3154.8, tradedAt: "2026-09-25T19:44:00Z" },
  { id: "ex_13", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "TSLA", side: "BUY", qty: 12, price: 262.9, commission: 0, net: -3154.8, tradedAt: "2026-09-25T15:16:00Z" },
  { id: "ex_14", accountId: "acc_schwab_1", brokerId: "schwab", symbol: "AAPL", side: "BUY", qty: 25, price: 228.4, commission: 0, net: -5710.0, tradedAt: "2026-09-24T14:40:00Z" },
];

export const TICKERS: Ticker[] = [
  { symbol: "SPY", last: 571.42, changePct: 0.38 },
  { symbol: "QQQ", last: 488.1, changePct: 0.61 },
  { symbol: "DIA", last: 423.77, changePct: 0.12 },
  { symbol: "IWM", last: 222.05, changePct: -0.24 },
  { symbol: "NVDA", last: 122.18, changePct: 1.42 },
  { symbol: "AAPL", last: 231.06, changePct: 0.55 },
  { symbol: "MSFT", last: 431.2, changePct: 0.31 },
  { symbol: "TSLA", last: 258.4, changePct: -1.12 },
  { symbol: "AVGO", last: 173.65, changePct: 0.98 },
  { symbol: "META", last: 601.3, changePct: 0.44 },
  { symbol: "AMZN", last: 191.8, changePct: -0.2 },
  { symbol: "GOOGL", last: 168.9, changePct: 0.27 },
];

/** 60 trading days of combined equity for the analysis chart. */
export const EQUITY_CURVE: { label: string; equity: number }[] = (() => {
  const out: { label: string; equity: number }[] = [];
  let v = 176_400;
  const start = new Date("2026-07-06T00:00:00Z");
  let d = 0;
  while (out.length < 60) {
    const day = new Date(start.getTime() + d * 86_400_000);
    d++;
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const i = out.length;
    v += Math.sin(i * 0.9) * 420 + Math.cos(i * 0.37) * 260 + 118;
    out.push({ label: day.toLocaleDateString("en-US", { month: "short", day: "numeric" }), equity: Math.round(v) });
  }
  return out;
})();

/** 20 trading days of daily P&L (mixed sign). */
export const DAILY_PNL: { label: string; pnl: number }[] = EQUITY_CURVE.slice(-21).map((p, i, arr) =>
  i === 0 ? null : { label: p.label, pnl: p.equity - arr[i - 1].equity },
).filter((x): x is { label: string; pnl: number } => x !== null);
