import { fmtMoney } from "@/lib/format";

/*
 * Money in the currency the broker reported it in. fmtMoney (src/lib/format) always writes US
 * dollars; an IBKR account can report in CAD, EUR or another base currency, and its balance must
 * not read as dollars. USD keeps fmtMoney's "$" form; any other currency is written with its code
 * ("CAD 50,000"), so nobody mistakes it for dollars.
 */

const formatters = new Map<string, Intl.NumberFormat | null>();

function formatter(currency: string, digits: 0 | 2): Intl.NumberFormat | null {
  const key = `${currency}:${digits}`;
  if (!formatters.has(key)) {
    try {
      formatters.set(key, new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "code", minimumFractionDigits: digits, maximumFractionDigits: digits }));
    } catch {
      // Not an ISO 4217 code: fall back to a plain number with the code after it.
      formatters.set(key, null);
    }
  }
  return formatters.get(key) ?? null;
}

/** A signed amount in `currency` (ISO code, USD when absent). Same options as fmtMoney, without `compact`. */
export function fmtAmount(value: number, currency: string | undefined | null, opts: { digits?: 0 | 2; sign?: boolean } = {}): string {
  const code = (currency || "USD").trim().toUpperCase();
  if (code === "USD") return fmtMoney(value, opts);
  const { digits = 2, sign = false } = opts;
  const abs = Math.abs(value);
  const f = formatter(code, digits);
  const body = f ? f.format(abs) : `${abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${code}`;
  const prefix = value < 0 ? "-" : sign && value > 0 ? "+" : "";
  return prefix + body;
}
